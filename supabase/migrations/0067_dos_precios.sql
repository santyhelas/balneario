-- =====================================================================
-- 0067 · Dos precios acordados: con tarjeta/transferencia y en efectivo.
--   · Al reservar se guarda el precio de lista y la proporción del precio en efectivo.
--   · El descuento se aplica al COBRAR en efectivo, sobre lo que se paga en efectivo
--     (ej.: lista 980.000 / efectivo 882.000; seña 200.000 por transferencia →
--      quedan 780.000 de lista = 702.000 en efectivo).
--   · Si se anula ese cobro, el precio vuelve a como estaba.
-- =====================================================================
alter table public.reservations add column if not exists cash_ratio numeric(12,10)
  check (cash_ratio is null or (cash_ratio > 0 and cash_ratio < 1));
alter table public.reservation_discounts add column if not exists payment_id uuid references public.payments(id);
create index if not exists reservation_discounts_payment_idx on public.reservation_discounts (payment_id) where payment_id is not null;

-- Lo que hay que pagar con un medio para cancelar el saldo (en efectivo, con el precio de efectivo si lo hay).
create or replace function private.due_for_method(p_reservation_id uuid, p_method text) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when p_method = 'efectivo' and r.cash_ratio is not null
              then round(greatest(r.total_amount - coalesce(p.paid, 0), 0) * r.cash_ratio, 0)
              else greatest(r.total_amount - coalesce(p.paid, 0), 0) end
    from public.reservations r
    left join (select reservation_id, sum(signed_amount) as paid from public.payments group by reservation_id) p on p.reservation_id = r.id
   where r.id = p_reservation_id
$$;

CREATE OR REPLACE FUNCTION private.compute_quote(p_workspace_id uuid, p_start date, p_end date, p_segments jsonb, p_options jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- Precio manual acordado = precio final: no se le aplica ningún descuento.
  v_is_manual boolean := (coalesce(p_options, '{}'::jsonb) ? 'manual_base') and (p_options ->> 'manual_base') is not null;
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
    -- En el comprobante: «Carpa 12 × 15 días» (no «precio manual»).
    v_charges := jsonb_build_array(jsonb_build_object(
      'description', coalesce((
          select string_agg(l.label, ' → ' order by l.first_start)
            from (select private.space_label(sp.kind, sp.code) as label, min((e ->> 'start_date')::date) as first_start
                    from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) e
                    join public.spaces sp on sp.id = (e ->> 'space_id')::uuid and sp.workspace_id = p_workspace_id
                   group by 1) l), 'Estadía')
        || format(' × %s %s', v_total_days, case when v_total_days = 1 then 'día' else 'días' end),
      'start_date', p_start, 'end_date', p_end,
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
                            case v_kind when 'carpa' then 'carpa' when 'cochera' then 'cochera' else 'sombrilla' end),
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
  if not v_courtesy and not v_is_manual then
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
  if not v_courtesy and not v_is_manual and coalesce((v_opts ->> 'round')::boolean, false) and v_cur > 0 then
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
    'paquete_fijo', v_fixed,
    -- Precio en efectivo acordado a mano (se aplica al cobrar en efectivo, no al reservar).
    'precio_efectivo', case when v_is_manual and not v_courtesy and nullif(v_opts ->> 'manual_cash', '') is not null
                            then least(floor((v_opts ->> 'manual_cash')::numeric), v_cur) end
  );
end $function$;

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
    -- Precio en efectivo acordado: lo que se paga en efectivo cubre más saldo (en proporción).
    if p_method = 'efectivo' and v_res.cash_ratio is not null then
      v_due := v_res.total_amount - v_paid;
      v_due_cash := round(v_due * v_res.cash_ratio, 0);
      if v_amount > v_due_cash then
        raise exception 'El cobro (%) supera el saldo en efectivo (%).', private.ars(v_amount), private.ars(greatest(v_due_cash, 0));
      end if;
      v_disc := case when v_amount = v_due_cash then v_due - v_amount
                     else least(floor(v_amount / v_res.cash_ratio - v_amount), v_due - v_amount) end;
      v_disc := greatest(v_disc, 0);
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

  -- Dos precios acordados (tarjeta/transferencia y efectivo): se guarda la proporción.
  -- El descuento se aplica recién al cobrar en efectivo, sobre lo que se paga en efectivo.
  if nullif(p_options ->> 'manual_cash', '') is not null and nullif(p_options ->> 'manual_base', '') is not null
     and not coalesce((p_options ->> 'courtesy')::boolean, false) then
    if (p_options ->> 'manual_cash')::numeric <= 0 or (p_options ->> 'manual_cash')::numeric > (p_options ->> 'manual_base')::numeric then
      raise exception 'El precio en efectivo tiene que ser mayor a cero y no puede superar el precio con tarjeta o transferencia.';
    end if;
    if (p_options ->> 'manual_cash')::numeric < (p_options ->> 'manual_base')::numeric then
      update public.reservations
         set cash_ratio = floor((p_options ->> 'manual_cash')::numeric) / floor((p_options ->> 'manual_base')::numeric),
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

CREATE OR REPLACE FUNCTION public.create_reservation_group(p_workspace_id uuid, p_request_id uuid, p_customer_id uuid, p_start_date date, p_end_date date, p_segments jsonb, p_extra_spaces uuid[] DEFAULT '{}'::uuid[], p_options jsonb DEFAULT '{}'::jsonb, p_notes text DEFAULT NULL::text, p_payment jsonb DEFAULT NULL::jsonb, p_extras jsonb DEFAULT '[]'::jsonb, p_people integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_np integer;  -- espacios del mismo tipo que el principal (la cochera no lleva personas)
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
      -- Un espacio de otro tipo (la cochera de una carpa) no lleva el precio manual de la principal: va con su tarifa.
      case when (select kind from public.spaces where id = v_extra[v_i]) is distinct from
                (select sp.kind from public.spaces sp where sp.id = (p_segments -> 0 ->> 'space_id')::uuid)
           then v_opts - 'manual_base' - 'manual_cash' else v_opts end,
      p_notes, null, '[]'::jsonb) ->> 'reservation_id')::uuid;
    v_ids := array_append(v_ids, v_id);
  end loop;

  -- Personas repartidas entre las carpas (la principal se lleva el resto) y el grupo.
  v_np := 1 + (select count(*) from unnest(v_extra) as e(sid) join public.spaces sp on sp.id = e.sid
                where sp.kind = (select s2.kind from public.spaces s2 where s2.id = (p_segments -> 0 ->> 'space_id')::uuid));
  for v_i in 1 .. v_n loop
    v_people := case when p_people is null or v_i > v_np then null
                     else (p_people / v_np) + case when v_i <= p_people % v_np then 1 else 0 end end;
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
        select private.due_for_method(v_ids[v_i], p_payment ->> 'method') into v_due;
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
end $function$;

CREATE OR REPLACE FUNCTION public.report_summary(p_workspace_id uuid, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_res jsonb := '{}'::jsonb;
begin
  perform private.require_member(p_workspace_id);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Elegí un período válido (hasta 400 días).';
  end if;

  -- Ocupación por día (espacios ocupados sobre espacios activos de cada tipo)
  v_res := v_res || jsonb_build_object('ocupacion', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'dia', d.day,
             'carpas', coalesce(o.carpas, 0), 'sombrillas', coalesce(o.sombrillas, 0),
             'cortesias', coalesce(o.cortesias, 0)) order by d.day), '[]'::jsonb)
    from (select gs::date as day from generate_series(p_from, p_to, interval '1 day') gs) d
    left join lateral (
      select count(*) filter (where sp.kind = 'carpa') as carpas,
             count(*) filter (where sp.kind = 'sombrilla') as sombrillas,
             count(*) filter (where r.is_courtesy) as cortesias
      from public.reservation_segments s
      join public.spaces sp on sp.id = s.space_id
      join public.reservations r on r.id = s.reservation_id
      where s.workspace_id = p_workspace_id and s.active and d.day between s.start_date and s.end_date
    ) o on true));
  v_res := v_res || jsonb_build_object('activos', (
    select jsonb_build_object('carpas', count(*) filter (where kind = 'carpa' and active),
                              'sombrillas', count(*) filter (where kind = 'sombrilla' and active))
    from public.spaces where workspace_id = p_workspace_id));

  -- Contratado: reservas confirmadas que comienzan en el período
  v_res := v_res || jsonb_build_object('contratado', (
    select jsonb_build_object(
      'reservas', count(*),
      'precio_lista', coalesce(sum(list_amount), 0),
      'descuentos', coalesce(sum(discount_amount), 0),
      'total', coalesce(sum(total_amount), 0),
      'cortesias', count(*) filter (where is_courtesy),
      'cortesias_dias', coalesce(sum(end_date - start_date + 1) filter (where is_courtesy), 0),
      'cortesias_valor', coalesce(sum(list_amount) filter (where is_courtesy), 0),
      'canceladas', (select count(*) from public.reservations c where c.workspace_id = p_workspace_id
                     and c.status = 'cancelada' and c.start_date between p_from and p_to))
    from public.reservations
    where workspace_id = p_workspace_id and status = 'confirmada' and start_date between p_from and p_to));

  -- Cobrado (caja): por tipo y medio de pago
  v_res := v_res || jsonb_build_object('caja_movimientos', (
    select coalesce(jsonb_agg(jsonb_build_object('categoria', category, 'medio', method, 'sentido', direction,
                                                 'importe', total, 'cantidad', n)), '[]'::jsonb)
    from (
      select m.category, m.method, m.direction, sum(m.amount) as total, count(*) as n
      from public.cash_movements m join public.cash_sessions s on s.id = m.cash_session_id
      where s.workspace_id = p_workspace_id and s.business_date between p_from and p_to
      group by m.category, m.method, m.direction
    ) x));

  -- Cobrado por día (entradas por cobros y otros ingresos, menos devoluciones y anulaciones de cobros)
  v_res := v_res || jsonb_build_object('cobrado_por_dia', (
    select coalesce(jsonb_agg(jsonb_build_object('dia', business_date, 'cobrado', cobrado, 'gastos', gastos) order by business_date), '[]'::jsonb)
    from (
      select s.business_date,
             coalesce(sum(case when m.category in ('cobro','otro_ingreso','anulacion_devolucion') then m.amount
                               when m.category in ('devolucion','anulacion_cobro') then -m.amount end), 0) as cobrado,
             coalesce(sum(case when m.category = 'gasto' then m.amount when m.category = 'anulacion_gasto' then -m.amount end), 0) as gastos
      from public.cash_sessions s left join public.cash_movements m on m.cash_session_id = s.id
      where s.workspace_id = p_workspace_id and s.business_date between p_from and p_to
      group by s.business_date
    ) x));

  -- Gastos por categoría (no anulados)
  v_res := v_res || jsonb_build_object('gastos', (
    select coalesce(jsonb_agg(jsonb_build_object('categoria', c.name, 'importe', t.total, 'cantidad', t.n,
                                                 'efectivo', t.efectivo) order by t.total desc), '[]'::jsonb)
    from (select e.category_id, sum(e.amount) as total, count(*) as n,
                 sum(e.amount) filter (where e.method = 'efectivo') as efectivo
          from public.expenses e
          where e.workspace_id = p_workspace_id and e.voided_at is null and e.spent_on between p_from and p_to
          group by e.category_id) t
    join public.expense_categories c on c.id = t.category_id));

  -- Cierres de caja y diferencias
  v_res := v_res || jsonb_build_object('cierres', (
    select coalesce(jsonb_agg(jsonb_build_object('fecha', business_date, 'apertura', opening_cash, 'esperado', expected_cash,
                                                 'contado', counted_cash, 'diferencia', difference, 'notas', close_notes)
                              order by business_date), '[]'::jsonb)
    from public.cash_sessions
    where workspace_id = p_workspace_id and business_date between p_from and p_to and closed_at is not null));

  -- Descuentos aplicados (reservas confirmadas que comienzan en el período)
  v_res := v_res || jsonb_build_object('descuentos', (
    select coalesce(jsonb_agg(jsonb_build_object('tipo', kind, 'detalle', label, 'importe', total, 'cantidad', n)
                              order by total desc), '[]'::jsonb)
    from (select d.kind, d.label, sum(d.amount) as total, count(*) as n
          from public.reservation_discounts d join public.reservations r on r.id = d.reservation_id
          where r.workspace_id = p_workspace_id and r.status = 'confirmada' and r.start_date between p_from and p_to
            and (d.payment_id is null or not exists (select 1 from public.payments v where v.voids_payment_id = d.payment_id))
          group by d.kind, d.label) x));

  -- Deudas pendientes hoy (no dependen del período)
  v_res := v_res || jsonb_build_object('deudas', (
    select coalesce(jsonb_agg(jsonb_build_object('reserva', r.number, 'reservation_id', r.id,
             'cliente', btrim(c.first_name || ' ' || c.last_name), 'telefono', c.phone,
             'desde', r.start_date, 'hasta', r.end_date, 'total', r.total_amount, 'saldo', b.due_amount)
             order by r.end_date), '[]'::jsonb)
    from public.reservation_balances b
    join public.reservations r on r.id = b.reservation_id
    join public.customers c on c.id = r.customer_id
    where b.workspace_id = p_workspace_id and b.due_amount > 0));

  -- Clientes frecuentes (2 o más reservas confirmadas en total)
  v_res := v_res || jsonb_build_object('frecuentes', (
    select coalesce(jsonb_agg(x order by (x ->> 'reservas')::int desc, (x ->> 'pagado')::numeric desc), '[]'::jsonb)
    from (
      select jsonb_build_object('cliente', btrim(c.first_name || ' ' || c.last_name), 'customer_id', c.id, 'telefono', c.phone,
               'reservas', count(r.id), 'dias', sum(r.end_date - r.start_date + 1),
               'pagado', coalesce(sum(b.paid_amount), 0), 'ultima', max(r.start_date)) as x
      from public.customers c
      join public.reservations r on r.customer_id = c.id and r.status = 'confirmada'
      join public.reservation_balances b on b.reservation_id = r.id
      where c.workspace_id = p_workspace_id
      group by c.id
      having count(r.id) >= 2
      order by count(r.id) desc
      limit 30
    ) t));

  return v_res;
end $function$;
