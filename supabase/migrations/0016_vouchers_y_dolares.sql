-- =====================================================================
-- 0016 · Devoluciones con voucher del restaurante y cobros en dólares.
--   · Devolución: en efectivo (sale de la caja) o con un voucher para el
--     restaurante (no toca la caja). Cada voucher tiene un código.
--   · Cobro en dólares: se guarda el monto en dólares y la cotización;
--     la reserva se descuenta en pesos. En la caja los dólares se cuentan aparte.
-- =====================================================================

-- Medios válidos para pagos de reservas: los de siempre + dólares + voucher.
create or replace function private.valid_payment_method(p text) returns boolean
language sql immutable as $$
  select private.valid_method(p) or p in ('dolares', 'voucher')
$$;
grant execute on function private.valid_payment_method(text) to authenticated;

alter table public.payments drop constraint payments_method_check;
alter table public.payments add constraint payments_method_check check (private.valid_payment_method(method));
alter table public.payments add column usd_amount numeric(14,2) check (usd_amount is null or usd_amount > 0);
alter table public.payments add column exchange_rate numeric(14,4) check (exchange_rate is null or exchange_rate > 0);
alter table public.payments add constraint payments_usd_check
  check ((method = 'dolares') = (usd_amount is not null and exchange_rate is not null));
alter table public.payments add constraint payments_voucher_check check (method <> 'voucher' or kind <> 'cobro');

alter table public.cash_movements drop constraint cash_movements_method_check;
alter table public.cash_movements add constraint cash_movements_method_check
  check (private.valid_method(method) or method = 'dolares');
alter table public.cash_movements add column usd_amount numeric(14,2);
alter table public.cash_movements add constraint cash_movements_usd_check
  check ((method = 'dolares') = (usd_amount is not null));

-- ---------------------------------------------------------------------
-- Vouchers para el restaurante (crédito a favor del cliente)
-- ---------------------------------------------------------------------
create table public.restaurant_vouchers (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id),
  code           text not null,
  payment_id     uuid not null unique,
  reservation_id uuid not null,
  customer_id    uuid not null,
  amount         numeric(14,2) not null check (amount > 0),
  status         text not null default 'vigente' check (status in ('vigente', 'usado', 'anulado')),
  used_at        timestamptz,
  used_by        uuid,
  version        integer not null default 1,
  created_at     timestamptz not null default now(),
  unique (workspace_id, code),
  foreign key (workspace_id, payment_id) references public.payments(workspace_id, id),
  foreign key (workspace_id, reservation_id) references public.reservations(workspace_id, id),
  foreign key (workspace_id, customer_id) references public.customers(workspace_id, id),
  check ((status = 'usado') = (used_at is not null))
);
create index restaurant_vouchers_customer_idx on public.restaurant_vouchers(customer_id);
alter table public.restaurant_vouchers enable row level security;
create policy "miembros leen vouchers" on public.restaurant_vouchers for select to authenticated using (private.is_member(workspace_id));
grant select on public.restaurant_vouchers to authenticated;
create trigger restaurant_vouchers_version before update on public.restaurant_vouchers
  for each row execute function private.check_version();
create trigger restaurant_vouchers_no_delete before delete on public.restaurant_vouchers
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------
-- Registro de pagos (reemplaza la versión anterior)
-- ---------------------------------------------------------------------
drop function private.record_payment(uuid, uuid, text, numeric, text, uuid, text, text, uuid);

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
    if v_amount > v_res.total_amount - v_paid then
      raise exception 'El cobro (%) supera el saldo pendiente (%).',
        to_char(v_amount, 'FM999G999G990D00'), to_char(greatest(v_res.total_amount - v_paid, 0), 'FM999G999G990D00');
    end if;
    if p_method = 'voucher' then
      raise exception 'El voucher del restaurante solo se usa para devoluciones.';
    end if;
    if p_method = 'dolares' and v_amount > v_res.total_amount - v_paid and v_amount - (v_res.total_amount - v_paid) < greatest(1, v_rate * 0.01) then
      v_amount := v_res.total_amount - v_paid;  -- "todo el saldo": diferencia menor a un centavo de dólar
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

revoke all on function private.record_payment(uuid, uuid, text, numeric, text, uuid, text, text, uuid, numeric, numeric) from public, anon, authenticated;

-- Cobro en dólares desde Cobros o desde la reserva.
create or replace function public.register_payment_usd(
  p_workspace_id uuid, p_reservation_id uuid, p_usd numeric, p_rate numeric,
  p_idempotency_key uuid, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_member(p_workspace_id);
  v_id := private.record_payment(p_workspace_id, p_reservation_id, 'cobro', null, 'dolares',
                                 p_idempotency_key, p_note, null, null, p_usd, p_rate);
  return jsonb_build_object('payment_id', v_id, 'amount', (select amount from public.payments where id = v_id));
end $$;

-- El restaurante usó el voucher.
create or replace function public.use_voucher(p_voucher_id uuid, p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.restaurant_vouchers%rowtype;
begin
  select * into v from public.restaurant_vouchers where id = p_voucher_id for update;
  if not found then
    raise exception 'El voucher no existe.';
  end if;
  perform private.require_member(v.workspace_id);
  if v.status <> 'vigente' then
    raise exception 'Ese voucher ya está %.', v.status;
  end if;
  if v.version <> p_expected_version then
    raise exception 'Otro usuario modificó este voucher. Recargá la página.' using errcode = '40001';
  end if;
  update public.restaurant_vouchers
     set status = 'usado', used_at = now(), used_by = auth.uid(), version = version + 1
   where id = p_voucher_id;
  return jsonb_build_object('voucher_id', v.id, 'code', v.code);
end $$;

revoke all on function public.register_payment_usd(uuid, uuid, numeric, numeric, uuid, text),
  public.use_voucher(uuid, integer) from public, anon;
grant execute on function public.register_payment_usd(uuid, uuid, numeric, numeric, uuid, text),
  public.use_voucher(uuid, integer) to authenticated;

-- Nueva reserva: acepta cobro en dólares ("usd_amount" y "exchange_rate" dentro de p_payment).
create or replace function public.create_reservation_v2(
  p_workspace_id uuid, p_request_id uuid, p_customer_id uuid, p_start_date date, p_end_date date,
  p_segments jsonb, p_options jsonb default '{}'::jsonb, p_notes text default null, p_payment jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.reservations%rowtype;
  v_quote jsonb;
  v_res jsonb;
  v_courtesy boolean := coalesce((p_options ->> 'courtesy')::boolean, false);
begin
  perform private.require_member(p_workspace_id);

  select * into v_existing from public.reservations where workspace_id = p_workspace_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('reservation_id', v_existing.id, 'number', v_existing.number, 'repetida', true);
  end if;

  v_quote := private.compute_quote(p_workspace_id, p_start_date, p_end_date, p_segments, p_options);
  if not (v_quote ->> 'ok')::boolean then
    raise exception 'Faltan tarifas cargadas para algunas fechas. Cargalas en el Tarifario o usá un precio manual.'
      using hint = 'FALTAN_TARIFAS';
  end if;
  if v_courtesy and char_length(btrim(coalesce(p_options ->> 'courtesy_beneficiary', ''))) < 2 then
    raise exception 'Indicá el familiar beneficiario de la cortesía.';
  end if;

  -- Pago en dólares al reservar: el monto en dólares y la cotización viajan por la sesión.
  perform set_config('app.pay_usd', coalesce(p_payment ->> 'usd_amount', ''), true);
  perform set_config('app.pay_rate', coalesce(p_payment ->> 'exchange_rate', ''), true);

  v_res := private.create_reservation(
    p_workspace_id, p_request_id, p_customer_id, p_start_date, p_end_date, p_segments,
    v_quote -> 'charges',
    case when v_courtesy then '[]'::jsonb else v_quote -> 'discounts' end,
    v_courtesy, p_notes, p_payment);

  perform set_config('app.pay_usd', '', true);
  perform set_config('app.pay_rate', '', true);

  update public.reservations
     set courtesy_beneficiary = case when v_courtesy then btrim(p_options ->> 'courtesy_beneficiary') end,
         pricing_options = p_options - 'courtesy_beneficiary',
         version = version + 1
   where id = (v_res ->> 'reservation_id')::uuid;

  return v_res || jsonb_build_object('quote', v_quote);
end $$;

-- Caja: los dólares se informan aparte (no se suman al efectivo en pesos).
create or replace function public.cash_session_summary(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_s public.cash_sessions%rowtype;
  v_methods jsonb;
  v_cash_in numeric(14,2);
  v_cash_out numeric(14,2);
  v_usd_in numeric(14,2);
  v_usd_out numeric(14,2);
begin
  select * into v_s from public.cash_sessions where id = p_session_id;
  if not found then
    raise exception 'La caja no existe.';
  end if;
  perform private.require_member(v_s.workspace_id);

  select coalesce(sum(amount) filter (where direction = 'entrada' and method = 'efectivo'), 0),
         coalesce(sum(amount) filter (where direction = 'salida' and method = 'efectivo'), 0)
    into v_cash_in, v_cash_out
  from public.cash_movements where cash_session_id = p_session_id;

  select coalesce(sum(usd_amount) filter (where direction = 'entrada' and method = 'dolares'), 0),
         coalesce(sum(usd_amount) filter (where direction = 'salida' and method = 'dolares'), 0)
    into v_usd_in, v_usd_out
  from public.cash_movements where cash_session_id = p_session_id;

  select coalesce(jsonb_object_agg(m.method, jsonb_build_object(
           'entradas', coalesce(x.entradas, 0), 'salidas', coalesce(x.salidas, 0))), '{}'::jsonb)
    into v_methods
  from (values ('efectivo'), ('transferencia'), ('debito'), ('credito'), ('mercado_pago'), ('tarjeta'), ('dolares')) m(method)
  left join (
    select method,
           sum(amount) filter (where direction = 'entrada') as entradas,
           sum(amount) filter (where direction = 'salida') as salidas
    from public.cash_movements where cash_session_id = p_session_id group by method
  ) x on x.method = m.method;

  return jsonb_build_object(
    'session_id', v_s.id,
    'business_date', v_s.business_date,
    'opening_cash', v_s.opening_cash,
    'opened_at', v_s.opened_at,
    'opened_by', v_s.opened_by,
    'por_medio', v_methods,
    'efectivo_esperado', v_s.opening_cash + v_cash_in - v_cash_out,
    'dolares', jsonb_build_object('entradas', v_usd_in, 'salidas', v_usd_out, 'esperado', v_usd_in - v_usd_out),
    'closed_at', v_s.closed_at,
    'counted_cash', v_s.counted_cash,
    'difference', v_s.difference,
    'close_notes', v_s.close_notes,
    'version', v_s.version
  );
end $$;
