-- ACTUALIZACIÓN 0009 · Tarifario por quincena, paquetes, convenios, medios de pago y cálculo de precio.
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0008).
begin;
-- =====================================================================
-- 0009 · Tarifario por quincena, paquetes, convenios con vigencia,
--        medios de pago ampliados y cálculo de precio en la base.
-- =====================================================================
-- ---------------------------------------------------------------------
-- Medios de pago: se agregan débito, crédito y Mercado Pago.
-- ("tarjeta" queda aceptado para registros anteriores.)
-- ---------------------------------------------------------------------
create or replace function private.valid_method(p text) returns boolean
language sql immutable as $$
  select p in ('efectivo','transferencia','debito','credito','mercado_pago','tarjeta')
$$;
grant execute on function private.valid_method(text) to authenticated;

alter table public.payments       drop constraint payments_method_check;
alter table public.expenses       drop constraint expenses_method_check;
alter table public.cash_movements drop constraint cash_movements_method_check;
alter table public.payments       add constraint payments_method_check       check (private.valid_method(method));
alter table public.expenses       add constraint expenses_method_check       check (private.valid_method(method));
alter table public.cash_movements add constraint cash_movements_method_check check (private.valid_method(method));

-- ---------------------------------------------------------------------
-- Datos nuevos de balneario, clientes, convenios y reservas
-- ---------------------------------------------------------------------
alter table public.workspaces
  add column cash_discount_percent numeric(5,2) not null default 10 check (cash_discount_percent >= 0 and cash_discount_percent <= 100),
  add column sea_bearing integer not null default 90 check (sea_bearing between 0 and 359),
  add column legal_id text check (char_length(legal_id) <= 30),
  add column phone text check (char_length(phone) <= 40),
  add column address text check (char_length(address) <= 200);
grant update (cash_discount_percent, sea_bearing, legal_id, phone, address) on public.workspaces to authenticated;

alter table public.customers add column locality text check (char_length(locality) <= 80);
grant insert (locality) on public.customers to authenticated;
grant update (locality) on public.customers to authenticated;

alter table public.agreements
  add column valid_from date,
  add column valid_to date,
  add column conditions text check (char_length(conditions) <= 500),
  add constraint agreements_validity check (valid_to is null or valid_from is null or valid_to >= valid_from);
grant insert (valid_from, valid_to, conditions) on public.agreements to authenticated;
grant update (valid_from, valid_to, conditions) on public.agreements to authenticated;

alter table public.reservations
  add column courtesy_beneficiary text check (char_length(courtesy_beneficiary) <= 120),
  add column pricing_options jsonb;

alter table public.reservation_discounts drop constraint reservation_discounts_kind_check;
alter table public.reservation_discounts add constraint reservation_discounts_kind_check
  check (kind in ('paquete','efectivo','convenio','manual','cortesia'));

-- ---------------------------------------------------------------------
-- Tarifario: precio por día, por quincena y por tipo de espacio.
-- La temporada se deriva de la fecha (julio a junio): ene 2027 → 2026/2027.
-- ---------------------------------------------------------------------
create table public.rates (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  space_kind   text not null check (space_kind in ('carpa','sombrilla')),
  year         integer not null check (year between 2000 and 2100),
  month        integer not null check (month between 1 and 12),
  half         smallint not null check (half in (1, 2)),
  season       text generated always as (
                 case when month >= 7 then year::text || '/' || (year + 1)::text
                      else (year - 1)::text || '/' || year::text end) stored,
  daily_price  numeric(14,2) not null check (daily_price >= 0),
  version      integer not null default 1,
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid(),
  unique (workspace_id, space_kind, year, month, half)
);
create index rates_season_idx on public.rates(workspace_id, season);

create trigger rates_version before update on public.rates
  for each row execute function private.check_version();
create trigger rates_audit after insert or update on public.rates
  for each row execute function private.audit();
create trigger rates_no_delete before delete on public.rates
  for each row execute function private.forbid_change();

-- Descuentos por cantidad de días (editables). Se aplica el escalón más alto alcanzado.
create table public.package_discounts (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  min_days     integer not null check (min_days between 2 and 366),
  percent      numeric(5,2) not null check (percent > 0 and percent <= 100),
  active       boolean not null default true,
  version      integer not null default 1,
  created_at   timestamptz not null default now()
);
create unique index package_discounts_days_unique on public.package_discounts(workspace_id, min_days) where active;

create trigger package_discounts_version before update on public.package_discounts
  for each row execute function private.check_version();
create trigger package_discounts_audit after insert or update on public.package_discounts
  for each row execute function private.audit();
create trigger package_discounts_no_delete before delete on public.package_discounts
  for each row execute function private.forbid_change();

alter table public.rates enable row level security;
alter table public.package_discounts enable row level security;
create policy "miembros leen tarifas" on public.rates for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen paquetes" on public.package_discounts for select to authenticated using (private.is_member(workspace_id));
create policy "admins crean paquetes" on public.package_discounts for insert to authenticated
  with check (private.has_role(workspace_id, array['propietario','administrador']));
create policy "admins editan paquetes" on public.package_discounts for update to authenticated
  using (private.has_role(workspace_id, array['propietario','administrador']))
  with check (private.has_role(workspace_id, array['propietario','administrador']));
revoke all on public.rates, public.package_discounts from anon, authenticated;
grant select on public.rates, public.package_discounts to authenticated;
grant insert (workspace_id, min_days, percent, active) on public.package_discounts to authenticated;
grant update (percent, active, version) on public.package_discounts to authenticated;

-- Escalones iniciales para balnearios existentes (editables desde el Tarifario).
insert into public.package_discounts (workspace_id, min_days, percent)
select w.id, v.d, v.p from public.workspaces w
cross join (values (5, 5), (7, 8), (15, 12), (30, 20)) v(d, p)
where not exists (select 1 from public.package_discounts x where x.workspace_id = w.id);

-- Guardar un precio (con control de edición simultánea).
create or replace function public.set_rate(
  p_workspace_id uuid, p_space_kind text, p_year integer, p_month integer, p_half smallint,
  p_daily_price numeric, p_expected_version integer default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.rates%rowtype;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  if p_daily_price is null or p_daily_price < 0 then
    raise exception 'El precio no puede ser negativo.';
  end if;
  select * into v from public.rates
  where workspace_id = p_workspace_id and space_kind = p_space_kind and year = p_year and month = p_month and half = p_half
  for update;
  if found then
    if p_expected_version is distinct from v.version then
      raise exception 'Este precio fue modificado desde otro dispositivo. Recargá e intentá de nuevo.'
        using errcode = '40001', hint = 'CONFLICTO_VERSION';
    end if;
    update public.rates set daily_price = round(p_daily_price, 2), version = v.version + 1, updated_at = now(), updated_by = auth.uid()
    where id = v.id returning * into v;
  else
    insert into public.rates (workspace_id, space_kind, year, month, half, daily_price)
    values (p_workspace_id, p_space_kind, p_year, p_month, p_half, round(p_daily_price, 2)) returning * into v;
  end if;
  return to_jsonb(v);
end $$;

-- Copiar precios de un período/mes a otro, con ajuste porcentual opcional (ej. inflación).
-- p_src_half / p_dst_half en null = las dos quincenas.
create or replace function public.copy_rates(
  p_workspace_id uuid, p_src_year integer, p_src_month integer, p_src_half smallint,
  p_dst_year integer, p_dst_month integer, p_dst_half smallint,
  p_adjust_percent numeric default 0, p_overwrite boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_dst_half smallint;
  v_copied integer := 0;
  v_skipped integer := 0;
  v_existing public.rates%rowtype;
  v_price numeric(14,2);
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  if (p_src_half is null) <> (p_dst_half is null) then
    raise exception 'Elegí una quincena de origen y una de destino, o el mes completo en ambos.';
  end if;
  for r in select * from public.rates
           where workspace_id = p_workspace_id and year = p_src_year and month = p_src_month
             and (p_src_half is null or half = p_src_half) loop
    v_dst_half := coalesce(p_dst_half, r.half);
    v_price := round(r.daily_price * (1 + coalesce(p_adjust_percent, 0) / 100));
    select * into v_existing from public.rates
    where workspace_id = p_workspace_id and space_kind = r.space_kind and year = p_dst_year and month = p_dst_month and half = v_dst_half
    for update;
    if found then
      if not p_overwrite then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      update public.rates set daily_price = v_price, version = v_existing.version + 1, updated_at = now(), updated_by = auth.uid()
      where id = v_existing.id;
    else
      insert into public.rates (workspace_id, space_kind, year, month, half, daily_price)
      values (p_workspace_id, r.space_kind, p_dst_year, p_dst_month, v_dst_half, v_price);
    end if;
    v_copied := v_copied + 1;
  end loop;
  return jsonb_build_object('copiados', v_copied, 'omitidos', v_skipped);
end $$;

-- Copiar toda una temporada (ej. 2026/2027 → 2027/2028) con ajuste porcentual.
create or replace function public.copy_season(
  p_workspace_id uuid, p_src_season text, p_dst_season text,
  p_adjust_percent numeric default 0, p_overwrite boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_offset integer;
  r record;
  v_copied integer := 0;
  v_skipped integer := 0;
  v_res jsonb;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  if p_src_season !~ '^\d{4}/\d{4}$' or p_dst_season !~ '^\d{4}/\d{4}$' then
    raise exception 'Temporada inválida (formato 2026/2027).';
  end if;
  v_offset := split_part(p_dst_season, '/', 1)::integer - split_part(p_src_season, '/', 1)::integer;
  if v_offset = 0 then
    raise exception 'Elegí una temporada de destino distinta.';
  end if;
  for r in select distinct year, month from public.rates where workspace_id = p_workspace_id and season = p_src_season loop
    v_res := public.copy_rates(p_workspace_id, r.year, r.month, null, r.year + v_offset, r.month, null, p_adjust_percent, p_overwrite);
    v_copied := v_copied + (v_res ->> 'copiados')::integer;
    v_skipped := v_skipped + (v_res ->> 'omitidos')::integer;
  end loop;
  return jsonb_build_object('copiados', v_copied, 'omitidos', v_skipped);
end $$;

-- ---------------------------------------------------------------------
-- Cálculo del precio (lo hace siempre la base: nadie puede alterarlo desde la pantalla)
--   1. Precio base: cada día al precio de su quincena y tipo de espacio.
--   2. Descuento por paquete: el escalón más alto que alcance la estadía.
--   3. Convenio: % sobre lo que queda.
--   4. Pago en efectivo: % (10 por defecto) sobre lo que queda.
--   5. Descuento manual: monto o % sobre lo que queda (solo administradores, con motivo).
--   Cada descuento se redondea hacia abajo al peso entero.
-- p_options: {"agreement_id", "cash": bool, "manual": {"type":"monto|porcentaje","value","reason"},
--             "courtesy": bool, "courtesy_beneficiary", "manual_base": numeric}
-- ---------------------------------------------------------------------
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
  v_month_names text[] := array['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
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
                                  '$' || to_char(v_rate.daily_price, 'FM999G999G990')),
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
  if not v_courtesy then
    -- 2. Paquete por cantidad de días
    select percent into v_pct from public.package_discounts
    where workspace_id = p_workspace_id and active and min_days <= v_total_days
    order by min_days desc limit 1;
    if found and v_cur > 0 then
      v_amt := floor(v_cur * v_pct / 100);
      v_discounts := v_discounts || jsonb_build_object('kind', 'paquete', 'percent', v_pct, 'amount', v_amt,
                       'label', format('Paquete %s días (%s%%)', v_total_days, to_char(v_pct, 'FM990D##')));
      v_cur := v_cur - v_amt;
    end if;

    -- 3. Convenio
    if (v_opts ->> 'agreement_id') is not null then
      select * into v_agreement from public.agreements
      where id = (v_opts ->> 'agreement_id')::uuid and workspace_id = p_workspace_id;
      if not found or not v_agreement.active
         or (v_agreement.valid_from is not null and p_start < v_agreement.valid_from)
         or (v_agreement.valid_to is not null and p_start > v_agreement.valid_to) then
        raise exception 'El convenio elegido no está vigente para esas fechas.';
      end if;
      v_amt := floor(v_cur * v_agreement.percent / 100);
      v_discounts := v_discounts || jsonb_build_object('kind', 'convenio', 'agreement_id', v_agreement.id,
                       'percent', v_agreement.percent, 'amount', v_amt);
      v_cur := v_cur - v_amt;
    end if;

    -- 4. Pago en efectivo
    if coalesce((v_opts ->> 'cash')::boolean, false) and v_ws.cash_discount_percent > 0 then
      v_amt := floor(v_cur * v_ws.cash_discount_percent / 100);
      v_discounts := v_discounts || jsonb_build_object('kind', 'efectivo', 'percent', v_ws.cash_discount_percent, 'amount', v_amt);
      v_cur := v_cur - v_amt;
    end if;

    -- 5. Descuento manual
    if v_manual is not null and coalesce((v_manual ->> 'value')::numeric, 0) > 0 then
      if char_length(btrim(coalesce(v_manual ->> 'reason', ''))) < 3 then
        raise exception 'Los descuentos manuales necesitan un motivo.';
      end if;
      if v_manual ->> 'type' = 'porcentaje' then
        v_pct := (v_manual ->> 'value')::numeric;
        if v_pct > 100 then
          raise exception 'El porcentaje no puede superar 100.';
        end if;
        v_amt := floor(v_cur * v_pct / 100);
      else
        v_pct := null;
        v_amt := least(floor((v_manual ->> 'value')::numeric), v_cur);
      end if;
      v_discounts := v_discounts || jsonb_build_object('kind', 'manual', 'percent', v_pct, 'amount', v_amt,
                       'reason', btrim(v_manual ->> 'reason'));
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
    'total', case when v_courtesy then 0 else v_cur end
  );
end $$;

-- Presupuesto para mostrar en pantalla antes de confirmar.
create or replace function public.quote_reservation(
  p_workspace_id uuid, p_start date, p_end date, p_segments jsonb, p_options jsonb default '{}'::jsonb
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id);
  return private.compute_quote(p_workspace_id, p_start, p_end, p_segments, p_options);
end $$;

-- ---------------------------------------------------------------------
-- Funciones de dinero actualizadas para los nuevos medios de pago
-- ---------------------------------------------------------------------
create or replace function private.record_payment(
  p_workspace_id uuid, p_reservation_id uuid, p_kind text, p_amount numeric, p_method text,
  p_idempotency_key uuid, p_note text, p_reason text, p_voids_payment_id uuid default null
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
begin
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
    v_signed := v_amount;
    v_category := 'cobro';
    v_concept := format('Cobro reserva #%s', v_res.number);

  elsif p_kind = 'devolucion' then
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
    v_amount := v_orig.amount;
    p_method := v_orig.method;
    v_signed := -v_orig.signed_amount;
    v_category := case v_orig.kind when 'cobro' then 'anulacion_cobro' else 'anulacion_devolucion' end;
    v_concept := format('Anulación de %s · reserva #%s', v_orig.kind, v_res.number);
  else
    raise exception 'Tipo de pago inválido.';
  end if;

  if p_method is null or not private.valid_method(p_method) then
    raise exception 'Medio de pago inválido.';
  end if;

  insert into public.payments (workspace_id, reservation_id, kind, amount, signed_amount, method,
                               voids_payment_id, cash_session_id, idempotency_key, note, reason)
  values (p_workspace_id, p_reservation_id, p_kind, v_amount, v_signed, p_method,
          p_voids_payment_id, v_session, p_idempotency_key, nullif(btrim(p_note), ''), nullif(btrim(p_reason), ''))
  returning id into v_id;

  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, payment_id)
  values (p_workspace_id, v_session, case when v_signed > 0 then 'entrada' else 'salida' end,
          p_method, v_amount, v_category, v_concept, v_id);

  return v_id;
end $$;

create or replace function public.register_expense(
  p_workspace_id uuid, p_idempotency_key uuid, p_amount numeric, p_spent_on date, p_concept text,
  p_category_id uuid, p_method text, p_supplier text default null, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.expenses%rowtype;
  v_session uuid;
  v_id uuid;
begin
  perform private.require_member(p_workspace_id);

  select * into v_existing from public.expenses
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('expense_id', v_existing.id, 'repetida', true);
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El importe debe ser mayor a cero.';
  end if;
  if p_spent_on is null or p_spent_on > private.ws_today(p_workspace_id) then
    raise exception 'Solo se registran gastos ya pagados (la fecha no puede ser futura).';
  end if;
  if p_method is null or not private.valid_method(p_method) then
    raise exception 'Medio de pago inválido.';
  end if;
  if not exists (select 1 from public.expense_categories c
                 where c.id = p_category_id and c.workspace_id = p_workspace_id and c.active) then
    raise exception 'Elegí una categoría válida.';
  end if;

  v_session := private.today_session(p_workspace_id);

  insert into public.expenses (workspace_id, cash_session_id, amount, spent_on, concept, category_id,
                               supplier, method, notes, idempotency_key)
  values (p_workspace_id, v_session, round(p_amount, 2), p_spent_on, btrim(p_concept), p_category_id,
          nullif(btrim(p_supplier), ''), p_method, nullif(btrim(p_notes), ''), p_idempotency_key)
  returning id into v_id;

  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, expense_id)
  values (p_workspace_id, v_session, 'salida', p_method, round(p_amount, 2), 'gasto', left('Gasto: ' || btrim(p_concept), 200), v_id);

  return jsonb_build_object('expense_id', v_id, 'repetida', false);
end $$;

create or replace function public.register_other_income(
  p_workspace_id uuid, p_idempotency_key uuid, p_amount numeric, p_method text, p_concept text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing uuid;
  v_session uuid;
  v_id uuid;
begin
  perform private.require_member(p_workspace_id);
  select id into v_existing from public.cash_movements
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('movement_id', v_existing, 'repetida', true);
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'El importe debe ser mayor a cero.';
  end if;
  if char_length(btrim(coalesce(p_concept, ''))) < 3 then
    raise exception 'Indicá el concepto del ingreso.';
  end if;
  if p_method is null or not private.valid_method(p_method) then
    raise exception 'Medio de pago inválido.';
  end if;
  v_session := private.today_session(p_workspace_id);
  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, idempotency_key)
  values (p_workspace_id, v_session, 'entrada', p_method, round(p_amount, 2), 'otro_ingreso', btrim(p_concept), p_idempotency_key)
  returning id into v_id;
  return jsonb_build_object('movement_id', v_id, 'repetida', false);
end $$;

create or replace function public.cash_session_summary(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_s public.cash_sessions%rowtype;
  v_methods jsonb;
  v_cash_in numeric(14,2);
  v_cash_out numeric(14,2);
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

  select coalesce(jsonb_object_agg(m.method, jsonb_build_object(
           'entradas', coalesce(x.entradas, 0), 'salidas', coalesce(x.salidas, 0))), '{}'::jsonb)
    into v_methods
  from (values ('efectivo'), ('transferencia'), ('debito'), ('credito'), ('mercado_pago'), ('tarjeta')) m(method)
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
    'closed_at', v_s.closed_at,
    'counted_cash', v_s.counted_cash,
    'difference', v_s.difference,
    'close_notes', v_s.close_notes,
    'version', v_s.version
  );
end $$;

-- Panel: nuevos indicadores (ocupación, ingresos del mes, saldo pendiente, efectivo en caja)
create or replace function public.dashboard_summary(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date;
  v_counts jsonb;
  v_starting jsonb;
  v_ending jsonb;
  v_debtors integer;
  v_session public.cash_sessions%rowtype;
  v_old_open public.cash_sessions%rowtype;
  v_income jsonb;
  v_expenses numeric(14,2);
begin
  perform private.require_member(p_workspace_id);
  v_today := private.ws_today(p_workspace_id);

  select jsonb_object_agg(kind, x) into v_counts from (
    select kind, jsonb_build_object(
      'total_activos', count(*) filter (where state <> 'desactivada'),
      'ocupados', count(*) filter (where state in ('ocupada','cortesia')),
      'cortesias', count(*) filter (where state = 'cortesia'),
      'disponibles', count(*) filter (where state in ('disponible','reservada_futura')),
      'mantenimiento', count(*) filter (where state = 'mantenimiento'),
      'desactivados', count(*) filter (where state = 'desactivada')
    ) as x
    from public.map_day_status(p_workspace_id, v_today) group by kind
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object(
           'reservation_id', r.id, 'number', r.number,
           'customer', btrim(c.first_name || ' ' || c.last_name), 'phone', c.phone,
           'start_date', r.start_date, 'end_date', r.end_date,
           'spaces', (select string_agg(sp.code, ', ' order by s.start_date) from public.reservation_segments s
                      join public.spaces sp on sp.id = s.space_id where s.reservation_id = r.id and s.active),
           'due_amount', b.due_amount, 'is_courtesy', r.is_courtesy) order by r.number), '[]'::jsonb)
    into v_starting
  from public.reservations r
  join public.customers c on c.id = r.customer_id
  join public.reservation_balances b on b.reservation_id = r.id
  where r.workspace_id = p_workspace_id and r.status = 'confirmada' and r.start_date = v_today;

  select coalesce(jsonb_agg(jsonb_build_object(
           'reservation_id', r.id, 'number', r.number,
           'customer', btrim(c.first_name || ' ' || c.last_name), 'phone', c.phone,
           'start_date', r.start_date, 'end_date', r.end_date,
           'spaces', (select string_agg(sp.code, ', ' order by s.start_date) from public.reservation_segments s
                      join public.spaces sp on sp.id = s.space_id where s.reservation_id = r.id and s.active),
           'due_amount', b.due_amount, 'is_courtesy', r.is_courtesy) order by b.due_amount desc, r.number), '[]'::jsonb)
    into v_ending
  from public.reservations r
  join public.customers c on c.id = r.customer_id
  join public.reservation_balances b on b.reservation_id = r.id
  where r.workspace_id = p_workspace_id and r.status = 'confirmada' and r.end_date = v_today;

  select count(distinct r.customer_id) into v_debtors
  from public.reservations r join public.reservation_balances b on b.reservation_id = r.id
  where r.workspace_id = p_workspace_id and b.due_amount > 0;

  select * into v_session from public.cash_sessions
  where workspace_id = p_workspace_id and business_date = v_today;
  select * into v_old_open from public.cash_sessions
  where workspace_id = p_workspace_id and closed_at is null and business_date < v_today;

  -- Cobrado hoy = cobros de reservas y otros ingresos (sin contar anulaciones ni la apertura)
  select jsonb_build_object(
           'efectivo', coalesce(sum(amount) filter (where method = 'efectivo'), 0),
           'otros_medios', coalesce(sum(amount) filter (where method <> 'efectivo'), 0),
           'total', coalesce(sum(amount), 0))
    into v_income
  from public.cash_movements
  where cash_session_id = v_session.id and direction = 'entrada' and category in ('cobro','otro_ingreso');

  select coalesce(sum(e.amount), 0) into v_expenses
  from public.expenses e where e.workspace_id = p_workspace_id and e.spent_on = v_today and e.voided_at is null;

  return jsonb_build_object(
    'fecha', v_today,
    'espacios', coalesce(v_counts, '{}'::jsonb),
    'ingresan_hoy', v_starting,
    'finalizan_hoy', v_ending,
    'clientes_con_deuda', v_debtors,
    'ingresos_hoy', coalesce(v_income, jsonb_build_object('efectivo', 0, 'otros_medios', 0, 'total', 0)),
    'gastos_hoy', v_expenses,
    'ingresos_mes', (select coalesce(sum(m.amount), 0) from public.cash_movements m
                     join public.cash_sessions cs on cs.id = m.cash_session_id
                     where cs.workspace_id = p_workspace_id and m.direction = 'entrada' and m.category in ('cobro','otro_ingreso')
                       and date_trunc('month', cs.business_date) = date_trunc('month', v_today)),
    'saldo_pendiente_total', (select coalesce(sum(b.due_amount), 0) from public.reservation_balances b
                              where b.workspace_id = p_workspace_id),
    'efectivo_en_caja', case when v_session.id is not null and v_session.closed_at is null
                             then (public.cash_session_summary(v_session.id) ->> 'efectivo_esperado')::numeric end,
    'caja', case
              when v_session.id is null then jsonb_build_object('estado', 'sin_abrir')
              when v_session.closed_at is null then jsonb_build_object('estado', 'abierta', 'session_id', v_session.id)
              else jsonb_build_object('estado', 'cerrada', 'session_id', v_session.id)
            end,
    'caja_anterior_sin_cerrar', case when v_old_open.id is not null
              then jsonb_build_object('session_id', v_old_open.id, 'fecha', v_old_open.business_date) end
  );
end $$;

-- ---------------------------------------------------------------------
-- Alta de reservas
--   public.create_reservation_v2 → la que usa la pantalla: calcula el precio en la base.
--   public.create_reservation    → carga con importes manuales, solo administradores.
-- ---------------------------------------------------------------------
alter function public.create_reservation(uuid, uuid, uuid, date, date, jsonb, jsonb, jsonb, boolean, text, jsonb) set schema private;
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
    elsif v_kind not in ('efectivo','paquete') then
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
                     when 'paquete' then coalesce(nullif(v_item ->> 'label', ''), 'Descuento por paquete') else null end;
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

revoke all on function private.create_reservation(uuid, uuid, uuid, date, date, jsonb, jsonb, jsonb, boolean, text, jsonb) from public, anon, authenticated;

create or replace function public.create_reservation(
  p_workspace_id uuid, p_request_id uuid, p_customer_id uuid, p_start_date date, p_end_date date,
  p_segments jsonb, p_charges jsonb, p_discounts jsonb default '[]'::jsonb, p_is_courtesy boolean default false,
  p_notes text default null, p_payment jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  return private.create_reservation(p_workspace_id, p_request_id, p_customer_id, p_start_date, p_end_date,
                                    p_segments, p_charges, p_discounts, p_is_courtesy, p_notes, p_payment);
end $$;

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

  v_res := private.create_reservation(
    p_workspace_id, p_request_id, p_customer_id, p_start_date, p_end_date, p_segments,
    v_quote -> 'charges',
    case when v_courtesy then '[]'::jsonb else v_quote -> 'discounts' end,
    v_courtesy, p_notes, p_payment);

  update public.reservations
     set courtesy_beneficiary = case when v_courtesy then btrim(p_options ->> 'courtesy_beneficiary') end,
         pricing_options = p_options - 'courtesy_beneficiary',
         version = version + 1
   where id = (v_res ->> 'reservation_id')::uuid;

  return v_res || jsonb_build_object('quote', v_quote);
end $$;

revoke all on function public.create_reservation(uuid, uuid, uuid, date, date, jsonb, jsonb, jsonb, boolean, text, jsonb),
  public.create_reservation_v2(uuid, uuid, uuid, date, date, jsonb, jsonb, text, jsonb),
  public.quote_reservation(uuid, date, date, jsonb, jsonb),
  public.set_rate(uuid, text, integer, integer, smallint, numeric, integer),
  public.copy_rates(uuid, integer, integer, smallint, integer, integer, smallint, numeric, boolean),
  public.copy_season(uuid, text, text, numeric, boolean)
  from public, anon;
grant execute on function public.create_reservation(uuid, uuid, uuid, date, date, jsonb, jsonb, jsonb, boolean, text, jsonb),
  public.create_reservation_v2(uuid, uuid, uuid, date, date, jsonb, jsonb, text, jsonb),
  public.quote_reservation(uuid, date, date, jsonb, jsonb),
  public.set_rate(uuid, text, integer, integer, smallint, numeric, integer),
  public.copy_rates(uuid, integer, integer, smallint, integer, integer, smallint, numeric, boolean),
  public.copy_season(uuid, text, text, numeric, boolean)
  to authenticated;
revoke all on function private.compute_quote(uuid, date, date, jsonb, jsonb) from public, anon, authenticated;

-- Alta de balneario: incluye los escalones de paquete iniciales
create or replace function public.create_workspace(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_user uuid := auth.uid();
  v_email text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email';
begin
  if v_user is null then
    raise exception 'Tenés que iniciar sesión.' using errcode = '28000';
  end if;
  if exists (select 1 from public.workspace_members where user_id = v_user) then
    raise exception 'Tu cuenta ya pertenece a un balneario.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('alta-balneario', 0));
  if exists (select 1 from public.workspaces) then
    raise exception 'El balneario ya fue creado. Pedile al propietario que te invite.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'Ingresá el nombre del balneario.';
  end if;

  insert into public.workspaces (name, created_by, map_width, map_height, sea_side, latitude, longitude)
  values (btrim(p_name), v_user, 3050, 2300, 'bottom', -37.263900, -56.973100)
  returning id into v_ws;
  insert into public.workspace_members (workspace_id, user_id, role, email) values (v_ws, v_user, 'propietario', v_email);

  insert into public.spaces (workspace_id, kind, code, x, y)
  select v_ws, p.kind, p.code, p.x, p.y from private.parador_spaces() p order by p.code;

  insert into public.map_features (workspace_id, kind, label, x, y, width, height, color)
  select v_ws, f.kind, f.label, f.x, f.y, f.width, f.height, f.color from private.parador_features() f;

  insert into public.expense_categories (workspace_id, name) values
    (v_ws, 'Proveedores e insumos'), (v_ws, 'Mantenimiento'), (v_ws, 'Reparaciones'),
    (v_ws, 'Limpieza'), (v_ws, 'Materiales y herramientas'), (v_ws, 'Personal'),
    (v_ws, 'Servicios'), (v_ws, 'Otros gastos');

  insert into public.agreements (workspace_id, name, percent) values (v_ws, 'Parque Bonito', 30);
  insert into public.package_discounts (workspace_id, min_days, percent)
  values (v_ws, 5, 5), (v_ws, 7, 8), (v_ws, 15, 12), (v_ws, 30, 20);
  insert into public.user_preferences (user_id) values (v_user) on conflict (user_id) do nothing;
  return v_ws;
end $$;
commit;
