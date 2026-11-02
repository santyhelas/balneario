-- =====================================================================
-- 0005 · Operaciones sobre reservas (todas en una sola transacción):
--   create_reservation   · alta con tramos, precio, descuentos y pago opcional
--   relocate_reservation · cambio de carpa por un día o por el resto de la estadía
--   cancel_reservation   · cancelación sin borrar historial ni pagos
--   revert_change        · revertir un cambio desde el historial
--   last_reversible_change · para "Deshacer último cambio"
-- =====================================================================

-- Tramos activos de una reserva, en formato legible para el historial.
create or replace function private.segments_snapshot(p_reservation_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'segment_id', s.id, 'space_id', s.space_id, 'space_code', sp.code,
           'start_date', s.start_date, 'end_date', s.end_date) order by s.start_date), '[]'::jsonb)
  from public.reservation_segments s
  join public.spaces sp on sp.id = s.space_id
  where s.reservation_id = p_reservation_id and s.active
$$;

-- ---------------------------------------------------------------------
-- Crear reserva
-- p_segments:  [{"space_id": uuid, "start_date": "AAAA-MM-DD", "end_date": "AAAA-MM-DD"}]
-- p_charges:   [{"description", "space_kind", "start_date", "end_date", "days",
--                "unit_price", "amount", "is_manual", "rate_snapshot"}]
-- p_discounts: [{"kind": "efectivo|convenio|manual", "agreement_id", "percent", "amount", "reason"}]
-- p_payment:   {"amount", "method", "idempotency_key"} o null (cobrar después)
-- ---------------------------------------------------------------------
create or replace function public.create_reservation(
  p_workspace_id uuid,
  p_request_id uuid,
  p_customer_id uuid,
  p_start_date date,
  p_end_date date,
  p_segments jsonb,
  p_charges jsonb,
  p_discounts jsonb default '[]'::jsonb,
  p_is_courtesy boolean default false,
  p_notes text default null,
  p_payment jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.reservations%rowtype;
  v_res_id uuid := gen_random_uuid();
  v_change_id uuid := gen_random_uuid();
  v_number bigint;
  v_list numeric(14,2) := 0;
  v_discount numeric(14,2) := 0;
  v_total numeric(14,2);
  v_seg jsonb;
  v_item jsonb;
  v_pos integer := 0;
  v_conflict text;
  v_space_ids uuid[];
  v_agreement public.agreements%rowtype;
  v_payment_id uuid;
  v_kind text;
  v_amount numeric(14,2);
  v_label text;
  v_percent numeric(5,2);
begin
  perform private.require_member(p_workspace_id);

  -- Reintento (doble clic, recarga, red lenta): devuelve la misma reserva.
  select * into v_existing from public.reservations
  where workspace_id = p_workspace_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('reservation_id', v_existing.id, 'number', v_existing.number, 'repetida', true);
  end if;

  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'Revisá las fechas: la salida no puede ser anterior a la entrada.';
  end if;
  if not exists (select 1 from public.customers c where c.id = p_customer_id and c.workspace_id = p_workspace_id) then
    raise exception 'Elegí un cliente válido.';
  end if;
  if p_segments is null or jsonb_typeof(p_segments) <> 'array' or jsonb_array_length(p_segments) = 0 then
    raise exception 'Asigná al menos una carpa o sombrilla.';
  end if;
  if p_charges is null or jsonb_typeof(p_charges) <> 'array' then
    raise exception 'Falta el detalle de precio.';
  end if;
  p_discounts := coalesce(p_discounts, '[]'::jsonb);

  -- Cada tramo dentro de la estadía y sin días repetidos entre tramos.
  if exists (select 1 from jsonb_array_elements(p_segments) s
             where (s ->> 'start_date') is null or (s ->> 'end_date') is null or (s ->> 'space_id') is null
                or (s ->> 'end_date')::date < (s ->> 'start_date')::date
                or (s ->> 'start_date')::date < p_start_date or (s ->> 'end_date')::date > p_end_date) then
    raise exception 'Cada tramo de carpa tiene que estar dentro de las fechas de la estadía.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_segments) with ordinality a(s, i)
             join jsonb_array_elements(p_segments) with ordinality b(s, j) on a.i < b.j
             where daterange((a.s ->> 'start_date')::date, (a.s ->> 'end_date')::date, '[]')
                && daterange((b.s ->> 'start_date')::date, (b.s ->> 'end_date')::date, '[]')) then
    raise exception 'Los tramos de carpa se superponen: un cliente no puede tener dos carpas el mismo día.';
  end if;

  -- Bloquea todos los espacios involucrados (en orden, para evitar bloqueos cruzados)
  select array_agg((s ->> 'space_id')::uuid) into v_space_ids from jsonb_array_elements(p_segments) s;
  perform private.lock_spaces(v_space_ids);

  -- Revalida la disponibilidad al guardar, con el detalle de cada conflicto.
  for v_seg in select * from jsonb_array_elements(p_segments) loop
    if not exists (select 1 from public.spaces sp where sp.id = (v_seg ->> 'space_id')::uuid
                   and sp.workspace_id = p_workspace_id) then
      raise exception 'Uno de los espacios elegidos no existe.';
    end if;
    v_conflict := private.space_conflict((v_seg ->> 'space_id')::uuid,
                                         (v_seg ->> 'start_date')::date, (v_seg ->> 'end_date')::date);
    if v_conflict is not null then
      raise exception 'Ya no está disponible: %', v_conflict using errcode = '23P01', hint = 'CONFLICTO_DISPONIBILIDAD';
    end if;
  end loop;

  -- Precio de lista
  for v_item in select * from jsonb_array_elements(p_charges) loop
    v_amount := round((v_item ->> 'amount')::numeric, 2);
    if v_amount is null or v_amount < 0 then
      raise exception 'Hay un importe inválido en el detalle de precio.';
    end if;
    v_list := v_list + v_amount;
  end loop;

  -- Descuentos (cada uno queda registrado con su importe, motivo y responsable)
  for v_item in select * from jsonb_array_elements(p_discounts) loop
    v_kind := v_item ->> 'kind';
    v_amount := round((v_item ->> 'amount')::numeric, 2);
    if v_amount is null or v_amount < 0 then
      raise exception 'Hay un descuento con importe inválido.';
    end if;
    if v_kind = 'cortesia' then
      raise exception 'La cortesía se indica marcando la reserva como cortesía, no como descuento.';
    elsif v_kind = 'convenio' then
      select * into v_agreement from public.agreements
      where id = (v_item ->> 'agreement_id')::uuid and workspace_id = p_workspace_id;
      if not found or not v_agreement.active then
        raise exception 'El convenio elegido no está vigente.';
      end if;
    elsif v_kind = 'manual' then
      if not private.has_role(p_workspace_id, array['propietario','administrador']) then
        raise exception 'Solo un administrador puede aplicar descuentos manuales.' using errcode = '42501';
      end if;
      if char_length(btrim(coalesce(v_item ->> 'reason', ''))) < 3 then
        raise exception 'Los descuentos manuales necesitan un motivo.';
      end if;
    elsif v_kind <> 'efectivo' then
      raise exception 'Tipo de descuento inválido.';
    end if;
    v_discount := v_discount + v_amount;
  end loop;

  if p_is_courtesy then
    if jsonb_array_length(p_discounts) > 0 then
      raise exception 'Una cortesía no lleva otros descuentos.';
    end if;
    if p_payment is not null then
      raise exception 'Una cortesía no genera cobros.';
    end if;
    v_discount := v_list;
  end if;

  if v_discount > v_list then
    raise exception 'Los descuentos superan el precio.';
  end if;
  v_total := v_list - v_discount;

  insert into public.reservations (id, workspace_id, customer_id, start_date, end_date, is_courtesy,
                                   list_amount, discount_amount, total_amount, notes, request_id, created_by)
  values (v_res_id, p_workspace_id, p_customer_id, p_start_date, p_end_date, coalesce(p_is_courtesy, false),
          v_list, v_discount, v_total, nullif(btrim(p_notes), ''), p_request_id, auth.uid())
  returning number into v_number;

  insert into public.reservation_changes (id, workspace_id, reservation_id, kind, description)
  values (v_change_id, p_workspace_id, v_res_id, 'creacion', format('Reserva #%s creada', v_number));

  for v_seg in select * from jsonb_array_elements(p_segments) loop
    insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
    values (p_workspace_id, v_res_id, (v_seg ->> 'space_id')::uuid,
            (v_seg ->> 'start_date')::date, (v_seg ->> 'end_date')::date, v_change_id);
  end loop;
  perform private.assert_coverage(v_res_id);

  v_pos := 0;
  for v_item in select * from jsonb_array_elements(p_charges) loop
    v_pos := v_pos + 1;
    insert into public.reservation_charges (workspace_id, reservation_id, position, description, space_kind,
                                            start_date, end_date, days, unit_price, amount, is_manual, rate_snapshot)
    values (p_workspace_id, v_res_id, v_pos,
            coalesce(nullif(btrim(v_item ->> 'description'), ''), 'Alquiler'),
            v_item ->> 'space_kind',
            (v_item ->> 'start_date')::date, (v_item ->> 'end_date')::date,
            (v_item ->> 'days')::integer,
            round((v_item ->> 'unit_price')::numeric, 2),
            round((v_item ->> 'amount')::numeric, 2),
            coalesce((v_item ->> 'is_manual')::boolean, false),
            v_item -> 'rate_snapshot');
  end loop;

  v_pos := 0;
  if p_is_courtesy then
    insert into public.reservation_discounts (workspace_id, reservation_id, position, kind, label, percent, amount, reason)
    values (p_workspace_id, v_res_id, 1, 'cortesia', 'Cortesía familiar', 100, v_list, 'Cortesía familiar');
  else
    for v_item in select * from jsonb_array_elements(p_discounts) loop
      v_pos := v_pos + 1;
      v_kind := v_item ->> 'kind';
      v_percent := (v_item ->> 'percent')::numeric;
      v_label := case v_kind when 'efectivo' then 'Pago en efectivo' when 'manual' then 'Descuento manual' else null end;
      if v_kind = 'convenio' then
        select * into v_agreement from public.agreements where id = (v_item ->> 'agreement_id')::uuid;
        v_label := 'Convenio ' || v_agreement.name;
        v_percent := v_agreement.percent;
      end if;
      insert into public.reservation_discounts (workspace_id, reservation_id, position, kind, agreement_id,
                                                label, percent, amount, reason)
      values (p_workspace_id, v_res_id, v_pos, v_kind,
              case when v_kind = 'convenio' then v_agreement.id end,
              v_label, v_percent, round((v_item ->> 'amount')::numeric, 2),
              nullif(btrim(v_item ->> 'reason'), ''));
    end loop;
  end if;

  if p_payment is not null then
    if coalesce((p_payment ->> 'amount')::numeric, 0) <= 0 then
      raise exception 'Ingresá el importe cobrado (o elegí "Cobrar después").';
    end if;
    v_payment_id := private.record_payment(p_workspace_id, v_res_id, 'cobro', (p_payment ->> 'amount')::numeric,
                                           p_payment ->> 'method', (p_payment ->> 'idempotency_key')::uuid,
                                           'Pago al reservar', null);
  end if;

  update public.reservation_changes set after_state = jsonb_build_object(
    'segments', private.segments_snapshot(v_res_id), 'total_amount', v_total)
  where id = v_change_id;

  return jsonb_build_object('reservation_id', v_res_id, 'number', v_number, 'total_amount', v_total,
                            'payment_id', v_payment_id, 'repetida', false);
end $$;

-- ---------------------------------------------------------------------
-- Cambio de carpa durante la estadía
--   Un solo día:            p_from = p_to = ese día
--   Resto de la estadía:    p_from = fecha del cambio, p_to = fin de la reserva
-- La reserva sigue siendo una sola; pagos y deuda no se tocan.
-- ---------------------------------------------------------------------
create or replace function public.relocate_reservation(
  p_reservation_id uuid, p_target_space_id uuid, p_from date, p_to date,
  p_expected_version integer, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_res public.reservations%rowtype;
  v_seg public.reservation_segments%rowtype;
  v_change_id uuid := gen_random_uuid();
  v_target public.spaces%rowtype;
  v_before jsonb;
  v_conflict text;
  v_space_ids uuid[];
begin
  select * into v_res from public.reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'La reserva no existe.';
  end if;
  perform private.require_member(v_res.workspace_id);
  if v_res.version <> p_expected_version then
    raise exception 'Esta reserva fue modificada desde otro dispositivo. Recargá e intentá de nuevo.'
      using errcode = '40001', hint = 'CONFLICTO_VERSION';
  end if;
  if v_res.status <> 'confirmada' then
    raise exception 'Solo se pueden cambiar de carpa reservas confirmadas.';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_from < v_res.start_date or p_to > v_res.end_date then
    raise exception 'Las fechas del cambio deben estar dentro de la estadía (% al %).',
      to_char(v_res.start_date, 'DD/MM/YYYY'), to_char(v_res.end_date, 'DD/MM/YYYY');
  end if;

  select * into v_target from public.spaces where id = p_target_space_id and workspace_id = v_res.workspace_id;
  if not found then
    raise exception 'El espacio de destino no existe.';
  end if;

  select array_agg(distinct space_id) || p_target_space_id into v_space_ids
  from public.reservation_segments where reservation_id = p_reservation_id and active;
  perform private.lock_spaces(v_space_ids);

  if not exists (select 1 from public.reservation_segments s
                 where s.reservation_id = p_reservation_id and s.active and s.space_id <> p_target_space_id
                   and daterange(s.start_date, s.end_date, '[]') && daterange(p_from, p_to, '[]')) then
    raise exception 'El cliente ya está en % en esas fechas.', v_target.code;
  end if;

  v_conflict := private.space_conflict(p_target_space_id, p_from, p_to, p_reservation_id);
  if v_conflict is not null then
    raise exception 'No se puede hacer el cambio: %', v_conflict using errcode = '23P01', hint = 'CONFLICTO_DISPONIBILIDAD';
  end if;

  v_before := private.segments_snapshot(p_reservation_id);
  perform set_config('app.reason', coalesce(p_reason, ''), true);

  insert into public.reservation_changes (id, workspace_id, reservation_id, kind, description, reason, before_state)
  values (v_change_id, v_res.workspace_id, p_reservation_id, 'reubicacion',
          case when p_from = p_to
               then format('Cambio a %s por el día %s', v_target.code, to_char(p_from, 'DD/MM/YYYY'))
               else format('Cambio a %s del %s al %s', v_target.code, to_char(p_from, 'DD/MM/YYYY'), to_char(p_to, 'DD/MM/YYYY'))
          end,
          nullif(btrim(p_reason), ''), jsonb_build_object('segments', v_before));

  -- Finaliza los tramos afectados y recrea las partes que quedan fuera del cambio.
  for v_seg in select * from public.reservation_segments s
               where s.reservation_id = p_reservation_id and s.active
                 and daterange(s.start_date, s.end_date, '[]') && daterange(p_from, p_to, '[]')
               order by s.start_date loop
    update public.reservation_segments set active = false, ended_by_change_id = v_change_id where id = v_seg.id;
    if v_seg.start_date < p_from then
      insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
      values (v_seg.workspace_id, p_reservation_id, v_seg.space_id, v_seg.start_date, p_from - 1, v_change_id);
    end if;
    if v_seg.end_date > p_to then
      insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
      values (v_seg.workspace_id, p_reservation_id, v_seg.space_id, p_to + 1, v_seg.end_date, v_change_id);
    end if;
  end loop;

  insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
  values (v_res.workspace_id, p_reservation_id, p_target_space_id, p_from, p_to, v_change_id);

  perform private.assert_coverage(p_reservation_id);

  update public.reservation_changes set after_state = jsonb_build_object('segments', private.segments_snapshot(p_reservation_id))
  where id = v_change_id;
  update public.reservations set version = version + 1 where id = p_reservation_id;

  return jsonb_build_object('change_id', v_change_id, 'segments', private.segments_snapshot(p_reservation_id));
end $$;

-- ---------------------------------------------------------------------
-- Cancelar reserva: libera los espacios, conserva pagos e historial.
-- Si hubo cobros, quedan como saldo a favor hasta que se registre
-- una devolución (decisión del administrador).
-- ---------------------------------------------------------------------
create or replace function public.cancel_reservation(
  p_reservation_id uuid, p_expected_version integer, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_res public.reservations%rowtype;
  v_change_id uuid := gen_random_uuid();
begin
  select * into v_res from public.reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'La reserva no existe.';
  end if;
  perform private.require_member(v_res.workspace_id);
  if v_res.version <> p_expected_version then
    raise exception 'Esta reserva fue modificada desde otro dispositivo. Recargá e intentá de nuevo.'
      using errcode = '40001', hint = 'CONFLICTO_VERSION';
  end if;
  if v_res.status = 'cancelada' then
    raise exception 'La reserva ya está cancelada.';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Indicá el motivo de la cancelación.';
  end if;

  perform set_config('app.reason', p_reason, true);
  insert into public.reservation_changes (id, workspace_id, reservation_id, kind, description, reason, before_state)
  values (v_change_id, v_res.workspace_id, p_reservation_id, 'cancelacion',
          format('Reserva #%s cancelada', v_res.number), btrim(p_reason),
          jsonb_build_object('segments', private.segments_snapshot(p_reservation_id)));

  update public.reservation_segments set active = false, ended_by_change_id = v_change_id
  where reservation_id = p_reservation_id and active;

  update public.reservations set status = 'cancelada', cancelled_at = now(), cancelled_by = auth.uid(),
         cancel_reason = btrim(p_reason), version = version + 1
  where id = p_reservation_id;

  update public.reservation_changes set after_state = jsonb_build_object('segments', '[]'::jsonb)
  where id = v_change_id;

  return jsonb_build_object('change_id', v_change_id);
end $$;

-- ---------------------------------------------------------------------
-- Revertir un cambio (cambio de carpa o cancelación).
-- Solo si es seguro: no debe haber cambios posteriores sobre los mismos
-- tramos y los espacios deben seguir libres. Nunca borra el cambio original.
-- ---------------------------------------------------------------------
create or replace function public.revert_change(p_change_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_chg public.reservation_changes%rowtype;
  v_res public.reservations%rowtype;
  v_new_id uuid := gen_random_uuid();
  v_seg public.reservation_segments%rowtype;
  v_conflict text;
  v_space_ids uuid[];
begin
  select * into v_chg from public.reservation_changes where id = p_change_id;
  if not found then
    raise exception 'El cambio no existe.';
  end if;
  perform private.require_member(v_chg.workspace_id);

  select * into v_res from public.reservations where id = v_chg.reservation_id for update;
  -- Vuelve a leer el cambio ya con la reserva bloqueada.
  select * into v_chg from public.reservation_changes where id = p_change_id;

  if v_chg.kind not in ('reubicacion','cancelacion') then
    raise exception 'Este tipo de cambio no se puede revertir desde el historial.';
  end if;
  if v_chg.reverted_by_change_id is not null then
    raise exception 'Este cambio ya fue revertido.';
  end if;

  -- Los tramos que dejó este cambio tienen que seguir vigentes tal cual
  -- (mismo espacio y mismas fechas); si no, hubo cambios posteriores encima.
  if exists (select 1 from public.reservation_segments c
             where c.created_by_change_id = p_change_id
               and not exists (select 1 from public.reservation_segments a
                               where a.reservation_id = c.reservation_id and a.active
                                 and a.space_id = c.space_id and a.start_date = c.start_date
                                 and a.end_date = c.end_date)) then
    raise exception 'Hay cambios posteriores sobre esta reserva. Revertí primero los más recientes.'
      using hint = 'REVERSION_INSEGURA';
  end if;

  select array_agg(distinct space_id) into v_space_ids from public.reservation_segments
  where ended_by_change_id = p_change_id or created_by_change_id = p_change_id;
  perform private.lock_spaces(v_space_ids);

  -- Los espacios a recuperar tienen que seguir libres.
  for v_seg in select * from public.reservation_segments where ended_by_change_id = p_change_id order by start_date loop
    v_conflict := private.space_conflict(v_seg.space_id, v_seg.start_date, v_seg.end_date, v_res.id);
    if v_conflict is not null then
      raise exception 'No se puede revertir: %', v_conflict using errcode = '23P01', hint = 'REVERSION_CONFLICTO';
    end if;
  end loop;

  perform set_config('app.reason', coalesce(p_reason, ''), true);
  insert into public.reservation_changes (id, workspace_id, reservation_id, kind, description, reason,
                                          before_state, reverts_change_id)
  values (v_new_id, v_chg.workspace_id, v_chg.reservation_id, 'reversion',
          'Reversión: ' || v_chg.description, nullif(btrim(p_reason), ''),
          jsonb_build_object('segments', private.segments_snapshot(v_chg.reservation_id)), p_change_id);

  if v_chg.kind = 'cancelacion' then
    if v_res.status <> 'cancelada' then
      raise exception 'La reserva ya no está cancelada.';
    end if;
    update public.reservations set status = 'confirmada', cancelled_at = null, cancelled_by = null,
           cancel_reason = null, version = version + 1
    where id = v_res.id;
  else
    update public.reservation_segments a set active = false, ended_by_change_id = v_new_id
    where a.reservation_id = v_res.id and a.active
      and exists (select 1 from public.reservation_segments c
                  where c.created_by_change_id = p_change_id and c.space_id = a.space_id
                    and c.start_date = a.start_date and c.end_date = a.end_date);
    update public.reservations set version = version + 1 where id = v_res.id;
  end if;

  -- Se recrean (como tramos nuevos) los tramos que el cambio había finalizado.
  for v_seg in select * from public.reservation_segments where ended_by_change_id = p_change_id order by start_date loop
    insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
    values (v_seg.workspace_id, v_seg.reservation_id, v_seg.space_id, v_seg.start_date, v_seg.end_date, v_new_id);
  end loop;

  perform private.assert_coverage(v_res.id);

  update public.reservation_changes set reverted_by_change_id = v_new_id where id = p_change_id;
  update public.reservation_changes set after_state = jsonb_build_object('segments', private.segments_snapshot(v_res.id))
  where id = v_new_id;

  return jsonb_build_object('change_id', v_new_id, 'segments', private.segments_snapshot(v_res.id));
end $$;

-- Último cambio reversible del balneario (para el botón "Deshacer").
create or replace function public.last_reversible_change(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.require_member(p_workspace_id);
  select jsonb_build_object('change_id', c.id, 'reservation_id', c.reservation_id, 'reservation_number', r.number,
                            'kind', c.kind, 'description', c.description, 'at', c.at, 'actor_email', c.actor_email)
    into v
  from public.reservation_changes c
  join public.reservations r on r.id = c.reservation_id
  where c.workspace_id = p_workspace_id and c.kind in ('reubicacion','cancelacion')
    and c.reverted_by_change_id is null
  order by c.at desc
  limit 1;
  return v;
end $$;

-- Editar observaciones de una reserva.
create or replace function public.update_reservation_notes(
  p_reservation_id uuid, p_expected_version integer, p_notes text
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid;
begin
  select workspace_id into v_ws from public.reservations where id = p_reservation_id;
  if not found then
    raise exception 'La reserva no existe.';
  end if;
  perform private.require_member(v_ws);
  update public.reservations set notes = nullif(btrim(p_notes), ''), version = p_expected_version + 1
  where id = p_reservation_id;
end $$;

revoke all on function
  public.create_reservation(uuid, uuid, uuid, date, date, jsonb, jsonb, jsonb, boolean, text, jsonb),
  public.relocate_reservation(uuid, uuid, date, date, integer, text),
  public.cancel_reservation(uuid, integer, text),
  public.revert_change(uuid, text),
  public.last_reversible_change(uuid),
  public.update_reservation_notes(uuid, integer, text)
  from public, anon;
grant execute on function
  public.create_reservation(uuid, uuid, uuid, date, date, jsonb, jsonb, jsonb, boolean, text, jsonb),
  public.relocate_reservation(uuid, uuid, date, date, integer, text),
  public.cancel_reservation(uuid, integer, text),
  public.revert_change(uuid, text),
  public.last_reversible_change(uuid),
  public.update_reservation_notes(uuid, integer, text)
  to authenticated;
