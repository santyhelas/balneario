-- 0049 · Redondeo del total en Nueva reserva (a $500 hacia abajo: $400.040 → $400.000, $23.730 → $23.500).
-- Es opcional en cada reserva y queda guardado como un descuento más ("Redondeo"), así los informes cuadran.

alter table public.reservation_discounts drop constraint if exists reservation_discounts_kind_check;
alter table public.reservation_discounts add constraint reservation_discounts_kind_check
  check (kind in ('paquete','efectivo','convenio','manual','cortesia','redondeo'));

-- Alta de la reserva: acepta el descuento "Redondeo".
create or replace function private.create_reservation(
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
    elsif v_kind not in ('efectivo','paquete','redondeo') then
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
      v_label := case v_kind when 'efectivo' then 'Pago en efectivo' when 'manual' then 'Descuento manual'
                     when 'paquete' then coalesce(nullif(v_item ->> 'label', ''), 'Descuento por paquete') when 'redondeo' then 'Redondeo' else null end;
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

create or replace function private.discount_default_label() returns trigger
language plpgsql as $$
begin
  if new.kind = 'redondeo' and new.label is null then new.label := 'Redondeo'; end if;
  return new;
end $$;
drop trigger if exists reservation_discounts_label on public.reservation_discounts;
create trigger reservation_discounts_label before insert on public.reservation_discounts
  for each row execute function private.discount_default_label();

create or replace function private.compute_quote(
  p_workspace_id uuid, p_start date, p_end date, p_segments jsonb, p_options jsonb
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_opts jsonb := coalesce(p_options, '{}'::jsonb);
  v_seg jsonb;
  v_space public.spaces%rowtype;
  v_d date;
  v_period_end date;
  v_half smallint;
  v_price numeric(14,2);
  v_rate public.rates%rowtype;
  v_days integer;
  v_charges jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_discounts jsonb := '[]'::jsonb;
  v_base numeric(14,2) := 0;
  v_cur numeric(14,2);
  v_amt numeric(14,2);
  v_pct numeric(5,2);
  v_total_days integer := p_end - p_start + 1;
  v_agreement public.agreements%rowtype;
  v_ws public.workspaces%rowtype;
  v_manual jsonb := v_opts -> 'manual';
  v_courtesy boolean := coalesce((v_opts ->> 'courtesy')::boolean, false);
  v_mode text;
  v_cap numeric(14,2);
  v_excess numeric(14,2);
  v_new jsonb;
  v_i integer;
  v_capped boolean := false;
  v_cands jsonb := '[]'::jsonb;
  v_best jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_c jsonb;
  v_month_names text[] := array['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  v_kind text;
  v_pack public.package_prices%rowtype;
  v_fixed boolean := false;
  v_extra integer;
begin
  select * into v_ws from public.workspaces where id = p_workspace_id;
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'Revisá las fechas: la salida no puede ser anterior a la entrada.';
  end if;

  if v_opts ? 'manual_base' and (v_opts ->> 'manual_base') is not null then
    -- Precio manual acordado (solo administradores)
    if not private.has_role(p_workspace_id, array['propietario','administrador']) then
      raise exception 'Solo un administrador puede fijar un precio manual.' using errcode = '42501';
    end if;
    v_base := floor((v_opts ->> 'manual_base')::numeric);
    if v_base < 0 then
      raise exception 'El precio manual no puede ser negativo.';
    end if;
    v_charges := jsonb_build_array(jsonb_build_object(
      'description', 'Precio manual acordado', 'start_date', p_start, 'end_date', p_end,
      'days', v_total_days, 'amount', v_base, 'is_manual', true));
  else
    -- Paquete con precio fijo (Descuentos y convenios): el mayor paquete que entra en la estadía,
    -- vigente en la fecha de entrada, para el tipo de espacio. Los días que pasan se cobran al precio de día extra.
    select sp.kind into v_kind from public.spaces sp
     where sp.workspace_id = p_workspace_id
       and sp.id = (select (e ->> 'space_id')::uuid from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) e
                    order by (e ->> 'start_date') limit 1);
    if v_kind is not null and not exists (
         select 1 from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) e
         join public.spaces sp on sp.id = (e ->> 'space_id')::uuid where sp.kind <> v_kind) then
      select * into v_pack from public.package_prices
       where workspace_id = p_workspace_id and active and space_kind = v_kind and days <= v_total_days
         and (valid_from is null or p_start >= valid_from) and (valid_to is null or p_start <= valid_to)
       order by days desc, valid_from desc nulls last limit 1;
      v_fixed := found;
    end if;
  end if;
  if v_fixed then
    v_extra := v_total_days - v_pack.days;
    v_charges := jsonb_build_array(jsonb_build_object(
      'description', format('Paquete %s %s · %s', v_pack.days, case when v_pack.days = 1 then 'día' else 'días' end,
                            case v_kind when 'carpa' then 'carpa' else 'sombrilla' end),
      'space_kind', v_kind, 'start_date', p_start, 'end_date', p_start + v_pack.days - 1,
      'days', v_pack.days, 'unit_price', v_pack.price, 'amount', v_pack.price, 'is_manual', false,
      'rate_snapshot', jsonb_build_object('package_price_id', v_pack.id, 'days', v_pack.days, 'price', v_pack.price,
                                          'extra_day_price', v_pack.extra_day_price,
                                          'valid_from', v_pack.valid_from, 'valid_to', v_pack.valid_to)));
    v_base := v_pack.price;
    if v_extra > 0 then
      v_charges := v_charges || jsonb_build_object(
        'description', format('%s %s extra × %s', v_extra, case when v_extra = 1 then 'día' else 'días' end, private.ars(v_pack.extra_day_price)),
        'space_kind', v_kind, 'start_date', p_start + v_pack.days, 'end_date', p_end,
        'days', v_extra, 'unit_price', v_pack.extra_day_price, 'amount', v_pack.extra_day_price * v_extra, 'is_manual', false,
        'rate_snapshot', jsonb_build_object('package_price_id', v_pack.id, 'extra_day_price', v_pack.extra_day_price));
      v_base := v_base + v_pack.extra_day_price * v_extra;
    end if;
  elsif not (v_opts ? 'manual_base' and (v_opts ->> 'manual_base') is not null) then
    for v_seg in select * from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) order by (value ->> 'start_date') loop
      select * into v_space from public.spaces where id = (v_seg ->> 'space_id')::uuid and workspace_id = p_workspace_id;
      if not found then
        raise exception 'Uno de los espacios elegidos no existe.';
      end if;
      v_d := (v_seg ->> 'start_date')::date;
      while v_d <= (v_seg ->> 'end_date')::date loop
        v_half := case when extract(day from v_d) <= 15 then 1 else 2 end;
        v_period_end := least((v_seg ->> 'end_date')::date,
          case when v_half = 1 then make_date(extract(year from v_d)::int, extract(month from v_d)::int, 15)
               else (date_trunc('month', v_d) + interval '1 month - 1 day')::date end);
        v_days := v_period_end - v_d + 1;
        select * into v_rate from public.rates
        where workspace_id = p_workspace_id and space_kind = v_space.kind
          and year = extract(year from v_d)::int and month = extract(month from v_d)::int and half = v_half;
        if not found then
          v_missing := v_missing || jsonb_build_object('space_kind', v_space.kind, 'year', extract(year from v_d)::int,
                         'month', extract(month from v_d)::int, 'half', v_half);
        else
          v_charges := v_charges || jsonb_build_object(
            'description', format('%s · %s al %s · %s %s × %s', private.space_label(v_space.kind, v_space.code),
                                  to_char(v_d, 'DD/MM'), to_char(v_period_end, 'DD/MM'), v_days,
                                  case when v_days = 1 then 'día' else 'días' end,
                                  private.ars(v_rate.daily_price)),
            'space_id', v_space.id, 'space_kind', v_space.kind, 'start_date', v_d, 'end_date', v_period_end,
            'days', v_days, 'unit_price', v_rate.daily_price, 'amount', v_rate.daily_price * v_days, 'is_manual', false,
            'rate_snapshot', jsonb_build_object('rate_id', v_rate.id, 'season', v_rate.season, 'year', v_rate.year,
                             'month', v_rate.month, 'half', v_rate.half, 'daily_price', v_rate.daily_price,
                             'periodo', (case v_half when 1 then '1ª' else '2ª' end) || ' quincena de '
                                        || v_month_names[v_rate.month] || ' ' || v_rate.year));
          v_base := v_base + v_rate.daily_price * v_days;
        end if;
        v_d := v_period_end + 1;
      end loop;
    end loop;
  end if;

  v_cur := v_base;
  v_mode := coalesce(v_ws.discount_mode, 'cascada');
  if not v_courtesy then
    -- Descuentos automáticos que corresponden (paquete, convenio, efectivo), en este orden.
    -- 2. Paquete por cantidad de días
    -- (con un paquete de precio fijo no se suma además el paquete en %)
    select percent into v_pct from public.package_discounts
    where workspace_id = p_workspace_id and active and min_days <= v_total_days and not v_fixed
    order by min_days desc limit 1;
    if found and v_base > 0 then
      v_cands := v_cands || jsonb_build_object('kind', 'paquete', 'percent', v_pct,
                   'label', format('Paquete %s días (%s%%)', v_total_days, to_char(v_pct, 'FM990D##')));
    end if;

    -- 3. Convenio
    if (v_opts ->> 'agreement_id') is not null then
      select * into v_agreement from public.agreements
      where id = (v_opts ->> 'agreement_id')::uuid and workspace_id = p_workspace_id;
      if not found or not v_agreement.active or v_agreement.deleted_at is not null
         or (v_agreement.valid_from is not null and p_start < v_agreement.valid_from)
         or (v_agreement.valid_to is not null and p_start > v_agreement.valid_to) then
        raise exception 'El convenio elegido no está vigente para esas fechas.';
      end if;
      v_cands := v_cands || jsonb_build_object('kind', 'convenio', 'agreement_id', v_agreement.id, 'percent', v_agreement.percent,
                   'label', 'Convenio ' || v_agreement.name);
    end if;

    -- 4. Pago en efectivo
    if coalesce((v_opts ->> 'cash')::boolean, false) and v_ws.cash_discount_percent > 0 then
      v_cands := v_cands || jsonb_build_object('kind', 'efectivo', 'percent', v_ws.cash_discount_percent, 'label', 'Pago en efectivo');
    end if;

    -- Cómo se combinan (lo decide cada balneario en Convenios y descuentos):
    --   cascada: cada uno sobre lo que queda · sumados: cada uno sobre el precio base ·
    --   mayor: no acumulables, se aplica solo el de mayor porcentaje.
    if v_mode = 'mayor' and jsonb_array_length(v_cands) > 1 then
      select c into v_best from jsonb_array_elements(v_cands) with ordinality as t(c, n)
      order by (c ->> 'percent')::numeric desc, n limit 1;
      select coalesce(jsonb_agg(c), '[]'::jsonb) into v_skipped from jsonb_array_elements(v_cands) with ordinality as t(c, n)
      where c is distinct from v_best;
      v_cands := jsonb_build_array(v_best);
    end if;
    for v_c in select * from jsonb_array_elements(v_cands) loop
      v_pct := (v_c ->> 'percent')::numeric;
      v_amt := least(floor((case when v_mode = 'sumados' then v_base else v_cur end) * v_pct / 100), v_cur);
      v_discounts := v_discounts || (v_c - 'label' || jsonb_build_object('amount', v_amt)
                     || case when v_c ->> 'kind' = 'paquete' then jsonb_build_object('label', v_c ->> 'label') else '{}'::jsonb end);
      v_cur := v_cur - v_amt;
    end loop;

    -- 5. Descuento manual (decisión del administrador: se aplica siempre, al final)
    if v_manual is not null and coalesce((v_manual ->> 'value')::numeric, 0) > 0 then
      if char_length(btrim(coalesce(v_manual ->> 'reason', ''))) < 3 then
        raise exception 'Los descuentos manuales necesitan un motivo.';
      end if;
      if v_manual ->> 'type' = 'porcentaje' then
        v_pct := (v_manual ->> 'value')::numeric;
        if v_pct > 100 then
          raise exception 'El porcentaje no puede superar 100.';
        end if;
        v_amt := least(floor((case when v_mode = 'sumados' then v_base else v_cur end) * v_pct / 100), v_cur);
      else
        v_pct := null;
        v_amt := least(floor((v_manual ->> 'value')::numeric), v_cur);
      end if;
      v_discounts := v_discounts || jsonb_build_object('kind', 'manual', 'percent', v_pct, 'amount', v_amt,
                       'reason', btrim(v_manual ->> 'reason'));
      v_cur := v_cur - v_amt;
    end if;
  end if;

  -- Tope de descuento del balneario: el total de descuentos no pasa de ese % del precio base.
  -- Si se pasa, se recorta desde el último descuento hacia atrás (primero el manual).
  if not v_courtesy and v_ws.discount_cap_percent is not null and v_base > 0 then
    v_cap := floor(v_base * v_ws.discount_cap_percent / 100);
    v_excess := (v_base - v_cur) - v_cap;
    if v_excess > 0 then
      v_new := '[]'::jsonb;
      for v_i in reverse jsonb_array_length(v_discounts) - 1 .. 0 loop
        v_c := v_discounts -> v_i;
        v_amt := least((v_c ->> 'amount')::numeric, v_excess);
        v_excess := v_excess - v_amt;
        v_c := jsonb_set(v_c, '{amount}', to_jsonb((v_c ->> 'amount')::numeric - v_amt));
        if (v_c ->> 'amount')::numeric > 0 then
          v_new := jsonb_build_array(v_c) || v_new;
        end if;
      end loop;
      v_discounts := v_new;
      v_cur := v_base - v_cap;
      v_capped := true;
    end if;
  end if;

  -- Redondeo (opcional, lo elige quien carga la reserva): el total baja al múltiplo de $500 de abajo.
  -- Ej.: $400.040 → $400.000 · $23.730 → $23.500. Queda registrado como un descuento "Redondeo".
  if not v_courtesy and coalesce((v_opts ->> 'round')::boolean, false) and v_cur > 0 then
    v_amt := v_cur - floor(v_cur / 500) * 500;
    if v_amt > 0 then
      v_discounts := v_discounts || jsonb_build_object('kind', 'redondeo', 'percent', null, 'amount', v_amt, 'label', 'Redondeo');
      v_cur := v_cur - v_amt;
    end if;
  end if;

  return jsonb_build_object(
    'ok', jsonb_array_length(v_missing) = 0,
    'faltan_tarifas', v_missing,
    'charges', v_charges,
    'dias', v_total_days,
    'precio_base', v_base,
    'discounts', v_discounts,
    'cortesia', v_courtesy,
    'total', case when v_courtesy then 0 else v_cur end,
    'modo_descuentos', v_mode,
    'no_aplicados', v_skipped,
    'tope', v_ws.discount_cap_percent,
    'tope_aplicado', v_capped,
    'paquete_fijo', v_fixed
  );
end $$;
