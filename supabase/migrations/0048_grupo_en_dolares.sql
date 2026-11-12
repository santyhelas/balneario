-- 0048 · Cobro en dólares en reservas de grupo y "todo el saldo" en dólares.
--
-- · Una reserva de grupo (varias carpas) ahora acepta seña o pago completo en dólares:
--   se reparte entre las carpas al centavo de dólar.
-- · Corrección: al pagar "todo el saldo" en dólares, si por el redondeo la cuenta daba unos centavos
--   de más (menos de un centavo de dólar), se rechazaba; ahora se toma justo el saldo, como estaba previsto.

create or replace function private.record_payment(
  p_workspace_id uuid, p_reservation_id uuid, p_kind text, p_amount numeric, p_method text,
  p_idempotency_key uuid, p_note text, p_reason text, p_voids_payment_id uuid default null,
  p_usd numeric default null, p_rate numeric default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.payments%rowtype;
  v_res public.reservations%rowtype;
  v_orig public.payments%rowtype;
  v_session uuid;
  v_paid numeric(14,2);
  v_signed numeric(14,2);
  v_amount numeric(14,2) := round(p_amount, 2);
  v_id uuid;
  v_category text;
  v_concept text;
  v_usd numeric(14,2);
  v_rate numeric(14,4);
  v_code text;
begin
  -- Dólares: monto en dólares y cotización. Desde Nueva reserva llegan por la sesión (ver create_reservation_v2).
  if p_method = 'dolares' then
    v_usd := round(coalesce(p_usd, nullif(current_setting('app.pay_usd', true), '')::numeric), 2);
    v_rate := round(coalesce(p_rate, nullif(current_setting('app.pay_rate', true), '')::numeric), 4);
    if v_usd is null or v_usd <= 0 or v_rate is null or v_rate <= 0 then
      raise exception 'Para cobrar en dólares indicá el monto en dólares y la cotización.';
    end if;
    v_amount := round(v_usd * v_rate, 2);
  end if;

  if p_idempotency_key is null then
    raise exception 'Falta la clave de operación.';
  end if;

  select * into v_existing from public.payments
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.reservation_id <> p_reservation_id or v_existing.kind <> p_kind
       or (p_kind <> 'anulacion' and (v_existing.amount <> v_amount or v_existing.method <> p_method)) then
      raise exception 'Esta operación ya fue registrada con otros datos.';
    end if;
    return v_existing.id;
  end if;

  v_session := private.today_session(p_workspace_id);

  -- Bloquea la reserva: dos pagos simultáneos se procesan de a uno.
  select * into v_res from public.reservations
  where id = p_reservation_id and workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'La reserva no existe.';
  end if;

  -- Reintento simultáneo con la misma clave: el otro ya terminó.
  select * into v_existing from public.payments
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return v_existing.id;
  end if;

  select coalesce(sum(signed_amount), 0) into v_paid from public.payments where reservation_id = p_reservation_id;

  if p_kind = 'cobro' then
    if v_res.status = 'cancelada' then
      raise exception 'No se pueden registrar cobros en una reserva cancelada.';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'El importe debe ser mayor a cero.';
    end if;
    if p_method = 'dolares' and v_amount > v_res.total_amount - v_paid and v_amount - (v_res.total_amount - v_paid) < greatest(1, v_rate * 0.01) then
      v_amount := v_res.total_amount - v_paid;  -- "todo el saldo": diferencia menor a un centavo de dólar
    end if;
    if v_amount > v_res.total_amount - v_paid then
      raise exception 'El cobro (%) supera el saldo pendiente (%).',
        private.ars(v_amount), private.ars(greatest(v_res.total_amount - v_paid, 0));
    end if;
    if p_method = 'voucher' then
      raise exception 'El voucher del restaurante solo se usa para devoluciones.';
    end if;
    v_signed := v_amount;
    v_category := 'cobro';
    v_concept := format('Cobro reserva #%s', v_res.number);

  elsif p_kind = 'devolucion' then
    if p_method not in ('efectivo', 'voucher') then
      raise exception 'Las devoluciones se hacen en efectivo o con un voucher para el restaurante.';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'El importe debe ser mayor a cero.';
    end if;
    if v_amount > v_paid then
      raise exception 'La devolución supera lo cobrado en la reserva.';
    end if;
    v_signed := -v_amount;
    v_category := 'devolucion';
    v_concept := format('Devolución reserva #%s', v_res.number);

  elsif p_kind = 'anulacion' then
    select * into v_orig from public.payments
    where id = p_voids_payment_id and reservation_id = p_reservation_id;
    if not found then
      raise exception 'El pago a anular no existe en esta reserva.';
    end if;
    if v_orig.kind = 'anulacion' then
      raise exception 'Una anulación no se puede anular.';
    end if;
    if exists (select 1 from public.payments where voids_payment_id = v_orig.id) then
      raise exception 'Ese pago ya fue anulado.';
    end if;
    if v_orig.method = 'voucher' and exists (select 1 from public.restaurant_vouchers
                                              where payment_id = v_orig.id and status = 'usado') then
      raise exception 'Ese voucher ya se usó en el restaurante; no se puede anular.';
    end if;
    v_amount := v_orig.amount;
    p_method := v_orig.method;
    v_usd := v_orig.usd_amount;
    v_rate := v_orig.exchange_rate;
    v_signed := -v_orig.signed_amount;
    v_category := case v_orig.kind when 'cobro' then 'anulacion_cobro' else 'anulacion_devolucion' end;
    v_concept := format('Anulación de %s · reserva #%s', v_orig.kind, v_res.number);
  else
    raise exception 'Tipo de pago inválido.';
  end if;

  if p_method is null or not private.valid_payment_method(p_method) then
    raise exception 'Medio de pago inválido.';
  end if;

  insert into public.payments (workspace_id, reservation_id, kind, amount, signed_amount, method,
                               voids_payment_id, cash_session_id, idempotency_key, note, reason, usd_amount, exchange_rate)
  values (p_workspace_id, p_reservation_id, p_kind, v_amount, v_signed, p_method,
          p_voids_payment_id, v_session, p_idempotency_key, nullif(btrim(p_note), ''), nullif(btrim(p_reason), ''),
          case when p_method = 'dolares' then v_usd end, case when p_method = 'dolares' then v_rate end)
  returning id into v_id;

  if p_method = 'voucher' then
    -- El voucher no es dinero de la caja: no genera movimiento de caja.
    if p_kind = 'devolucion' then
      loop
        v_code := 'V-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
        exit when not exists (select 1 from public.restaurant_vouchers where workspace_id = p_workspace_id and code = v_code);
      end loop;
      insert into public.restaurant_vouchers (workspace_id, code, payment_id, reservation_id, customer_id, amount)
      values (p_workspace_id, v_code, v_id, p_reservation_id, v_res.customer_id, v_amount);
    else
      update public.restaurant_vouchers set status = 'anulado', version = version + 1 where payment_id = p_voids_payment_id;
    end if;
  else
    insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, payment_id, usd_amount)
    values (p_workspace_id, v_session, case when v_signed > 0 then 'entrada' else 'salida' end,
            p_method, v_amount, v_category,
            v_concept || case when p_method = 'dolares' then format(' · US$ %s a $ %s', v_usd, v_rate) else '' end,
            v_id, case when p_method = 'dolares' then v_usd end);
  end if;

  return v_id;
end $$;

create or replace function public.create_reservation_group(
  p_workspace_id uuid, p_request_id uuid, p_customer_id uuid, p_start_date date, p_end_date date,
  p_segments jsonb, p_extra_spaces uuid[] default '{}', p_options jsonb default '{}'::jsonb, p_notes text default null,
  p_payment jsonb default null, p_extras jsonb default '[]'::jsonb, p_people integer default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.reservations%rowtype;
  v_extra uuid[] := coalesce(p_extra_spaces, '{}');
  v_n integer;
  v_group uuid;
  v_main jsonb;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_opts jsonb;
  v_i integer;
  v_left numeric;
  v_pay numeric;
  v_due numeric;
  v_people integer;
  v_usd_left numeric;
  v_rate numeric;
  v_usd numeric;
  v_paid_now numeric;
begin
  perform private.require_member(p_workspace_id);
  -- Reintento (doble clic, recarga): devuelve lo que ya se guardó.
  select * into v_existing from public.reservations where workspace_id = p_workspace_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('reservation_id', v_existing.id, 'number', v_existing.number, 'group_id', v_existing.group_id, 'repetida', true);
  end if;
  if p_people is not null and (p_people < 1 or p_people > 500) then raise exception 'La cantidad de personas tiene que ser entre 1 y 500.'; end if;
  if array_length(v_extra, 1) > 9 then raise exception 'Un grupo puede tener hasta 10 espacios.'; end if;
  if (select count(distinct e.sid) from unnest(v_extra) as e(sid)) <> coalesce(array_length(v_extra, 1), 0) then
    raise exception 'Hay espacios repetidos en el grupo.';
  end if;
  if exists (select 1 from unnest(v_extra) as e(sid), jsonb_array_elements(p_segments) s where (s ->> 'space_id')::uuid = e.sid) then
    raise exception 'Un espacio del grupo es el mismo que el principal.';
  end if;
  if exists (select 1 from unnest(v_extra) as e(sid) where not exists (select 1 from public.spaces sp where sp.id = e.sid and sp.workspace_id = p_workspace_id and sp.active)) then
    raise exception 'Uno de los espacios del grupo no existe o está desactivado.';
  end if;

  v_n := 1 + coalesce(array_length(v_extra, 1), 0);
  v_group := case when v_n > 1 then gen_random_uuid() end;

  -- Principal (con sus tramos, extras y opciones de precio tal cual)
  v_main := public.create_reservation_v3(p_workspace_id, p_request_id, p_customer_id, p_start_date, p_end_date,
                                          p_segments, p_options, p_notes, null, p_extras);
  v_ids := array_append(v_ids, (v_main ->> 'reservation_id')::uuid);

  -- Las demás carpas del grupo: toda la estadía, mismo precio y descuentos.
  -- Un descuento manual en pesos se aplica una sola vez (en la principal), no en cada carpa.
  v_opts := case when p_options -> 'manual' ->> 'type' = 'monto' then p_options - 'manual' else p_options end;
  for v_i in 1 .. v_n - 1 loop
    v_id := (public.create_reservation_v3(
      p_workspace_id, md5(p_request_id::text || ':grupo:' || v_i)::uuid, p_customer_id, p_start_date, p_end_date,
      jsonb_build_array(jsonb_build_object('space_id', v_extra[v_i], 'start_date', p_start_date, 'end_date', p_end_date)),
      v_opts, p_notes, null, '[]'::jsonb) ->> 'reservation_id')::uuid;
    v_ids := array_append(v_ids, v_id);
  end loop;

  -- Personas repartidas entre las carpas (la principal se lleva el resto) y el grupo.
  for v_i in 1 .. v_n loop
    v_people := case when p_people is null then null
                     else (p_people / v_n) + case when v_i <= p_people % v_n then 1 else 0 end end;
    if v_people = 0 then v_people := null; end if;
    update public.reservations set people = v_people, group_id = v_group, version = version + 1
     where id = v_ids[v_i] and (people is distinct from v_people or group_id is distinct from v_group);
  end loop;

  -- Cobro: se reparte en orden, completando cada carpa antes de pasar a la siguiente.
  if p_payment is not null then
    if v_n = 1 then
      if nullif(p_payment ->> 'usd_amount', '') is not null then
        perform public.register_payment_usd(p_workspace_id, v_ids[1], (p_payment ->> 'usd_amount')::numeric, (p_payment ->> 'exchange_rate')::numeric,
                                            (p_payment ->> 'idempotency_key')::uuid, null);
      else
        perform public.register_payment(p_workspace_id, v_ids[1], (p_payment ->> 'amount')::numeric, p_payment ->> 'method',
                                        (p_payment ->> 'idempotency_key')::uuid, null);
      end if;
    elsif nullif(p_payment ->> 'usd_amount', '') is not null then
      -- Dólares en un grupo: se reparten en orden, cada carpa recibe los dólares que cubren su saldo
      -- (redondeado al centavo de dólar) y la última se lleva lo que queda.
      v_usd_left := round((p_payment ->> 'usd_amount')::numeric, 2);
      v_rate := (p_payment ->> 'exchange_rate')::numeric;
      if v_usd_left is null or v_usd_left <= 0 or v_rate is null or v_rate <= 0 then raise exception 'Ingresá los dólares y la cotización.'; end if;
      for v_i in 1 .. v_n loop
        exit when v_usd_left <= 0;
        select r.total_amount - coalesce((select sum(signed_amount) from public.payments p where p.reservation_id = r.id), 0)
          into v_due from public.reservations r where r.id = v_ids[v_i];
        continue when v_due <= 0;
        v_usd := case when v_i = v_n then v_usd_left else least(v_usd_left, ceil(v_due / v_rate * 100) / 100) end;
        perform public.register_payment_usd(p_workspace_id, v_ids[v_i], v_usd, v_rate,
                                            case when v_i = 1 then (p_payment ->> 'idempotency_key')::uuid
                                                 else md5((p_payment ->> 'idempotency_key') || ':grupo:' || v_i)::uuid end, null);
        v_usd_left := v_usd_left - v_usd;
      end loop;
      if v_usd_left > 0.009 then raise exception 'Los dólares superan el total del grupo.'; end if;
    else
      v_left := (p_payment ->> 'amount')::numeric;
      if v_left is null or v_left <= 0 then raise exception 'Importe del cobro inválido.'; end if;
      for v_i in 1 .. v_n loop
        exit when v_left <= 0;
        select total_amount into v_due from public.reservations where id = v_ids[v_i];
        v_pay := least(v_left, v_due);
        if v_pay > 0 then
          perform public.register_payment(p_workspace_id, v_ids[v_i], v_pay, p_payment ->> 'method',
                                          case when v_i = 1 then (p_payment ->> 'idempotency_key')::uuid
                                               else md5((p_payment ->> 'idempotency_key') || ':grupo:' || v_i)::uuid end, null);
          v_left := v_left - v_pay;
        end if;
      end loop;
      if v_left > 0.009 then raise exception 'El cobro supera el total del grupo.'; end if;
    end if;
  end if;

  return v_main || jsonb_build_object(
    'group_id', v_group,
    'reservations', (select jsonb_agg(jsonb_build_object('id', r.id, 'number', r.number) order by r.number)
                       from public.reservations r where r.id = any(v_ids)),
    'total_amount', (select sum(total_amount) from public.reservations where id = any(v_ids)));
end $$;
