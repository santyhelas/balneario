begin;
-- =====================================================================
-- 0071 · Arreglos de la prueba a fondo (21/11/2026)
--   1. Grupo: al cancelar una carpa del grupo, lo que ya pagó pasa a las otras
--      carpas del mismo grupo (hasta cubrir su saldo). Antes la seña quedaba
--      en la cancelada y las demás seguían debiendo el total.
--      El pase queda registrado como «traslado» (no es plata que entra ni sale de la caja).
--   2. Grupo: cobrar el saldo de todo el grupo en un solo cobro (se reparte en orden).
--   3. Cortesía: ya no pide tarifas cargadas (es un regalo a $0).
--   5. Reserva de $0 sin marcar cortesía: no se permite (hay que marcarla como cortesía).
-- =====================================================================

-- «traslado»: plata que se mueve entre reservas del mismo grupo. No toca la caja.
create or replace function private.valid_payment_method(p text) returns boolean
language sql immutable as $$
  select private.valid_method(p) or p in ('dolares', 'voucher', 'traslado')
$$;

-- ---------------------------------------------------------------------
-- 3. Cortesía sin tarifas: la cotización de una cortesía no necesita precios.
--    Se envuelve la cotización original (que queda como compute_quote_tarifas).
-- ---------------------------------------------------------------------
alter function private.compute_quote(uuid, date, date, jsonb, jsonb) rename to compute_quote_tarifas;

create function private.compute_quote(p_workspace_id uuid, p_start date, p_end date, p_segments jsonb, p_options jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_opts jsonb := coalesce(p_options, '{}'::jsonb);
begin
  if coalesce((v_opts ->> 'courtesy')::boolean, false) and nullif(v_opts ->> 'manual_base', '') is null then
    v_opts := v_opts || '{"manual_base": 0}'::jsonb;
  end if;
  return private.compute_quote_tarifas(p_workspace_id, p_start, p_end, p_segments, v_opts);
end $$;
revoke all on function private.compute_quote(uuid, date, date, jsonb, jsonb) from public;

-- ---------------------------------------------------------------------
-- 5. Reserva de $0: tiene que ser cortesía.
--    Se envuelve create_reservation_v3 (la original queda en private).
-- ---------------------------------------------------------------------
alter function public.create_reservation_v3(uuid, uuid, uuid, date, date, jsonb, jsonb, text, jsonb, jsonb) set schema private;
alter function private.create_reservation_v3(uuid, uuid, uuid, date, date, jsonb, jsonb, text, jsonb, jsonb) rename to create_reservation_v3_base;
revoke all on function private.create_reservation_v3_base(uuid, uuid, uuid, date, date, jsonb, jsonb, text, jsonb, jsonb) from public, anon, authenticated;

create function public.create_reservation_v3(
  p_workspace_id uuid, p_request_id uuid, p_customer_id uuid, p_start_date date, p_end_date date,
  p_segments jsonb, p_options jsonb default '{}'::jsonb, p_notes text default null, p_payment jsonb default null,
  p_extras jsonb default '[]'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_res jsonb; v_r public.reservations%rowtype;
begin
  v_res := private.create_reservation_v3_base(p_workspace_id, p_request_id, p_customer_id, p_start_date, p_end_date,
                                              p_segments, p_options, p_notes, p_payment, p_extras);
  if coalesce((v_res ->> 'repetida')::boolean, false) then return v_res; end if;
  select * into v_r from public.reservations where id = (v_res ->> 'reservation_id')::uuid;
  if not v_r.is_courtesy and v_r.total_amount = 0
     and not exists (select 1 from public.reservation_extras x where x.reservation_id = v_r.id and x.amount > 0 and x.voided_at is null) then
    raise exception 'El total da $0. Si es un regalo, marcala como cortesía (familiar); si no, revisá el precio.';
  end if;
  return v_res;
end $$;
revoke all on function public.create_reservation_v3(uuid, uuid, uuid, date, date, jsonb, jsonb, text, jsonb, jsonb) from public, anon;
grant execute on function public.create_reservation_v3(uuid, uuid, uuid, date, date, jsonb, jsonb, text, jsonb, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. Saldo y cobro de todo el grupo.
-- ---------------------------------------------------------------------
create or replace function public.group_due(p_group_id uuid, p_method text default 'transferencia') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_ws uuid; v_due numeric := 0; v_n int := 0; r record;
begin
  select workspace_id into v_ws from public.reservations where group_id = p_group_id limit 1;
  if v_ws is null then raise exception 'El grupo no existe.'; end if;
  perform private.require_member(v_ws);
  for r in select id from public.reservations where group_id = p_group_id and status = 'confirmada' and not is_courtesy loop
    v_due := v_due + greatest(coalesce(private.due_for_method(r.id, p_method), 0), 0);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('due', v_due, 'reservas', v_n);
end $$;

create or replace function public.register_group_payment(
  p_workspace_id uuid, p_group_id uuid, p_amount numeric, p_method text, p_idempotency_key uuid, p_note text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_left numeric; v_total numeric; v_pay numeric; v_due numeric; v_i int := 0; v_out jsonb := '[]'::jsonb; r record;
begin
  perform private.require_member(p_workspace_id);
  if p_method = 'dolares' or p_method = 'traslado' or p_method = 'voucher' then
    raise exception 'Para el grupo cobrá en pesos (efectivo, transferencia, tarjeta o Mercado Pago).';
  end if;
  -- Reintento del mismo cobro: no se duplica.
  if exists (select 1 from public.payments where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key) then
    return jsonb_build_object('repetido', true);
  end if;
  v_left := round(p_amount, 2);
  if v_left is null or v_left <= 0 then raise exception 'Importe del cobro inválido.'; end if;
  -- Se bloquean las reservas del grupo para que dos cobros a la vez no se pisen.
  perform 1 from public.reservations where group_id = p_group_id and workspace_id = p_workspace_id for update;
  v_total := coalesce((public.group_due(p_group_id, p_method) ->> 'due')::numeric, 0);
  if v_left > v_total then
    raise exception 'El cobro (%) supera el saldo del grupo (%).', private.ars(v_left), private.ars(v_total);
  end if;
  for r in select id, number from public.reservations
            where group_id = p_group_id and workspace_id = p_workspace_id and status = 'confirmada' and not is_courtesy
            order by number loop
    exit when v_left <= 0;
    v_due := greatest(coalesce(private.due_for_method(r.id, p_method), 0), 0);
    continue when v_due <= 0;
    v_pay := least(v_left, v_due);
    v_i := v_i + 1;
    perform public.register_payment(p_workspace_id, r.id, v_pay, p_method,
      case when v_i = 1 then p_idempotency_key else md5(p_idempotency_key::text || ':grupo:' || v_i)::uuid end, p_note);
    v_out := v_out || jsonb_build_object('reserva', r.number, 'importe', v_pay);
    v_left := v_left - v_pay;
  end loop;
  return jsonb_build_object('pagos', v_out);
end $$;
revoke all on function public.group_due(uuid, text), public.register_group_payment(uuid, uuid, numeric, text, uuid, text) from public, anon;
grant execute on function public.group_due(uuid, text), public.register_group_payment(uuid, uuid, numeric, text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 1. Cancelar una carpa del grupo: lo pagado pasa a las otras carpas del grupo.
--    Se envuelve cancel_reservation (la original queda en private).
-- ---------------------------------------------------------------------
alter function public.cancel_reservation(uuid, integer, text) set schema private;
alter function private.cancel_reservation(uuid, integer, text) rename to cancel_reservation_base;
revoke all on function private.cancel_reservation_base(uuid, integer, text) from public, anon, authenticated;

create function public.cancel_reservation(p_reservation_id uuid, p_expected_version integer, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_res jsonb; v_r public.reservations%rowtype; v_left numeric; v_x numeric; v_ses uuid; m record;
begin
  v_res := private.cancel_reservation_base(p_reservation_id, p_expected_version, p_reason);
  select * into v_r from public.reservations where id = p_reservation_id;
  if v_r.group_id is null then return v_res; end if;
  v_left := coalesce((select sum(signed_amount) from public.payments where reservation_id = v_r.id), 0);
  if v_left <= 0 then return v_res; end if;
  -- El traslado no es plata de la caja: queda anotado en la misma caja del último pago de esta carpa.
  select cash_session_id into v_ses from public.payments where reservation_id = v_r.id order by created_at desc limit 1;
  for m in select id, number from public.reservations
            where group_id = v_r.group_id and id <> v_r.id and status = 'confirmada' and not is_courtesy
            order by number loop
    exit when v_left <= 0;
    v_x := least(v_left, greatest(coalesce((select due_amount from public.reservation_balances where reservation_id = m.id), 0), 0));
    continue when v_x <= 0;
    insert into public.payments (workspace_id, reservation_id, kind, amount, signed_amount, method, idempotency_key, reason, created_by, cash_session_id)
    values (v_r.workspace_id, v_r.id, 'devolucion', v_x, -v_x, 'traslado', gen_random_uuid(),
            format('Pasa a la reserva #%s del mismo grupo (se canceló esta carpa)', m.number), auth.uid(), v_ses);
    insert into public.payments (workspace_id, reservation_id, kind, amount, signed_amount, method, idempotency_key, reason, created_by, cash_session_id)
    values (v_r.workspace_id, m.id, 'cobro', v_x, v_x, 'traslado', gen_random_uuid(),
            format('Viene de la reserva #%s del mismo grupo (cancelada)', v_r.number), auth.uid(), v_ses);
    v_left := v_left - v_x;
  end loop;
  return v_res;
end $$;
revoke all on function public.cancel_reservation(uuid, integer, text) from public, anon;
grant execute on function public.cancel_reservation(uuid, integer, text) to authenticated, service_role;

commit;
