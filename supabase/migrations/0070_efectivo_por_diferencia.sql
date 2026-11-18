-- =====================================================================
-- 0070 · Dos precios (lista y efectivo): lo que se paga resta lo mismo en los dos.
--   Ej.: lista $700.000 / efectivo $540.000; seña $80.000 por transferencia →
--        quedan $620.000 con transferencia o $460.000 en efectivo.
--   · Se guarda la diferencia entre los dos precios ($160.000) y se descuenta recién
--     cuando un pago en efectivo termina de saldar la reserva. Si se anula ese pago, vuelve.
--   · Las reservas que ya tenían precio en efectivo (proporción) pasan a la diferencia.
-- =====================================================================
alter table public.reservations add column if not exists cash_discount numeric(14,2)
  check (cash_discount is null or cash_discount > 0);

-- Cuánto falta descontar por pagar en efectivo (la diferencia menos lo ya descontado en cobros vigentes).
create or replace function private.cash_discount_left(p_reservation_id uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select greatest(coalesce(r.cash_discount, 0) - coalesce((
           select sum(d.amount) from public.reservation_discounts d
            where d.reservation_id = r.id and d.kind = 'efectivo' and d.payment_id is not null
              and not exists (select 1 from public.payments v where v.voids_payment_id = d.payment_id)), 0), 0)
    from public.reservations r where r.id = p_reservation_id
$$;

-- Pasar las reservas con proporción a diferencia: lista = total + descuentos por efectivo vigentes.
update public.reservations r
   set cash_discount = nullif(x.lista - round(x.lista * r.cash_ratio, 0), 0), cash_ratio = null, version = r.version + 1
  from (select r2.id, r2.total_amount + coalesce((
                 select sum(d.amount) from public.reservation_discounts d
                  where d.reservation_id = r2.id and d.kind = 'efectivo' and d.payment_id is not null
                    and not exists (select 1 from public.payments v where v.voids_payment_id = d.payment_id)), 0) as lista
          from public.reservations r2 where r2.cash_ratio is not null) x
 where x.id = r.id;

-- Lo que hay que pagar con un medio para cancelar el saldo (en efectivo, con el precio de efectivo si lo hay).
create or replace function private.due_for_method(p_reservation_id uuid, p_method text) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when p_method = 'efectivo'
              then greatest(r.total_amount - coalesce(p.paid, 0) - private.cash_discount_left(r.id), 0)
              else greatest(r.total_amount - coalesce(p.paid, 0), 0) end
    from public.reservations r
    left join (select reservation_id, sum(signed_amount) as paid from public.payments group by reservation_id) p on p.reservation_id = r.id
   where r.id = p_reservation_id
$$;

-- Para la pantalla: saldo pagando en efectivo (null si la reserva no tiene precio en efectivo).
create or replace function public.cash_due(p_reservation_id uuid) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_ws uuid;
begin
  select workspace_id into v_ws from public.reservations where id = p_reservation_id;
  if v_ws is null then return null; end if;
  perform private.require_member(v_ws);
  if private.cash_discount_left(p_reservation_id) <= 0 then return null; end if;
  return private.due_for_method(p_reservation_id, 'efectivo');
end $$;
revoke all on function public.cash_due(uuid) from public, anon;
grant execute on function public.cash_due(uuid) to authenticated;

CREATE OR REPLACE FUNCTION private.record_payment(p_workspace_id uuid, p_reservation_id uuid, p_kind text, p_amount numeric, p_method text, p_idempotency_key uuid, p_note text, p_reason text, p_voids_payment_id uuid DEFAULT NULL::uuid, p_usd numeric DEFAULT NULL::numeric, p_rate numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_due numeric(14,2);
  v_due_cash numeric(14,2);
  v_disc numeric(14,2) := 0;
  v_pos integer;
  v_d public.reservation_discounts%rowtype;
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
    -- Precio en efectivo acordado: la diferencia con el precio de lista se descuenta
    -- recién cuando el pago en efectivo termina de saldar la reserva (los pagos de antes restan igual en los dos precios).
    if p_method = 'efectivo' and private.cash_discount_left(p_reservation_id) > 0 then
      v_due := v_res.total_amount - v_paid;
      v_due_cash := greatest(v_due - private.cash_discount_left(p_reservation_id), 0);
      if v_amount > v_due_cash then
        raise exception 'El cobro (%) supera el saldo en efectivo (%).', private.ars(v_amount), private.ars(v_due_cash);
      end if;
      v_disc := case when v_amount = v_due_cash then v_due - v_amount else 0 end;
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

  -- Descuento por pagar en efectivo (precio en efectivo acordado), ligado a este cobro.
  if v_disc > 0 then
    select coalesce(max(position), 0) + 1 into v_pos from public.reservation_discounts where reservation_id = p_reservation_id;
    insert into public.reservation_discounts (workspace_id, reservation_id, position, kind, label, amount, payment_id)
    values (p_workspace_id, p_reservation_id, v_pos, 'efectivo', 'Precio en efectivo', v_disc, v_id);
    update public.reservations
       set discount_amount = discount_amount + v_disc, total_amount = total_amount - v_disc, version = version + 1
     where id = p_reservation_id;
  end if;
  -- Si se anula un cobro en efectivo que tuvo ese descuento, el precio vuelve a como estaba.
  if p_kind = 'anulacion' then
    select * into v_d from public.reservation_discounts where payment_id = p_voids_payment_id;
    if found then
      update public.reservations
         set discount_amount = discount_amount - v_d.amount, total_amount = total_amount + v_d.amount, version = version + 1
       where id = p_reservation_id;
    end if;
  end if;

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
end $function$;

CREATE OR REPLACE FUNCTION public.create_reservation_v3(p_workspace_id uuid, p_request_id uuid, p_customer_id uuid, p_start_date date, p_end_date date, p_segments jsonb, p_options jsonb DEFAULT '{}'::jsonb, p_notes text DEFAULT NULL::text, p_payment jsonb DEFAULT NULL::jsonb, p_extras jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_existing public.reservations%rowtype;
  v_res jsonb;
  v_id uuid;
  v_x jsonb;
begin
  perform private.require_member(p_workspace_id);
  select * into v_existing from public.reservations where workspace_id = p_workspace_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('reservation_id', v_existing.id, 'number', v_existing.number, 'repetida', true);
  end if;
  if p_extras is not null and jsonb_typeof(p_extras) <> 'array' then raise exception 'Extras inválidos.'; end if;
  if jsonb_array_length(coalesce(p_extras, '[]'::jsonb)) > 30 then raise exception 'Demasiados extras en una reserva.'; end if;

  v_res := public.create_reservation_v2(p_workspace_id, p_request_id, p_customer_id, p_start_date, p_end_date,
                                        p_segments, p_options, p_notes, null);
  v_id := (v_res ->> 'reservation_id')::uuid;

  -- Dos precios acordados (tarjeta/transferencia y efectivo): se guarda la diferencia.
  -- Se descuenta recién cuando se termina de pagar en efectivo.
  if nullif(p_options ->> 'manual_cash', '') is not null and nullif(p_options ->> 'manual_base', '') is not null
     and not coalesce((p_options ->> 'courtesy')::boolean, false) then
    if (p_options ->> 'manual_cash')::numeric <= 0 or (p_options ->> 'manual_cash')::numeric > (p_options ->> 'manual_base')::numeric then
      raise exception 'El precio en efectivo tiene que ser mayor a cero y no puede superar el precio con tarjeta o transferencia.';
    end if;
    if (p_options ->> 'manual_cash')::numeric < (p_options ->> 'manual_base')::numeric then
      update public.reservations
         set cash_discount = floor((p_options ->> 'manual_base')::numeric) - floor((p_options ->> 'manual_cash')::numeric),
             version = version + 1
       where id = v_id;
    end if;
  end if;

  for v_x in select * from jsonb_array_elements(coalesce(p_extras, '[]'::jsonb)) loop
    perform public.add_reservation_extra(v_id, (v_x ->> 'extra_id')::uuid, (v_x ->> 'quantity')::integer, nullif(v_x ->> 'days', '')::integer);
  end loop;

  if p_payment is not null then
    if nullif(p_payment ->> 'usd_amount', '') is not null then
      perform public.register_payment_usd(p_workspace_id, v_id, (p_payment ->> 'usd_amount')::numeric, (p_payment ->> 'exchange_rate')::numeric,
                                          (p_payment ->> 'idempotency_key')::uuid, null);
    else
      perform public.register_payment(p_workspace_id, v_id, (p_payment ->> 'amount')::numeric, p_payment ->> 'method',
                                      (p_payment ->> 'idempotency_key')::uuid, null);
    end if;
  end if;

  return v_res || jsonb_build_object('total_amount', (select total_amount from public.reservations where id = v_id));
end $function$;
