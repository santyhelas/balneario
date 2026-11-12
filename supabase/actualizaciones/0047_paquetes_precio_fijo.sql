begin;

-- 0047 · Paquetes con precio fijo por cantidad de días (Descuentos y convenios).
--
-- El dueño puede fijar, por tipo de espacio, el precio de un paquete (ej. carpa 5 días = $90.000)
-- y el precio de cada día extra (ej. $20.000: 6 días = $110.000) hasta el próximo paquete.
-- Opcionalmente con vigencia (desde/hasta): sin fechas vale siempre. Se toma el paquete más largo
-- que entra en la estadía, vigente el día de entrada. Con paquete fijo no se usa el tarifario por día
-- ni el paquete en %, pero sí se suman convenio, efectivo y descuento manual según la regla del balneario.
-- Las reservas ya hechas no cambian: guardan su precio y el paquete usado.

create table if not exists public.package_prices (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  space_kind      text not null check (space_kind in ('carpa','sombrilla')),
  days            integer not null check (days between 1 and 366),
  price           numeric(14,2) not null check (price >= 0),
  extra_day_price numeric(14,2) not null check (extra_day_price >= 0),
  valid_from      date,
  valid_to        date,
  active          boolean not null default true,
  version         integer not null default 1,
  created_at      timestamptz not null default now(),
  unique (workspace_id, id),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);
create index if not exists package_prices_ws_idx on public.package_prices(workspace_id, space_kind, days) where active;

drop trigger if exists package_prices_version on public.package_prices;
create trigger package_prices_version before update on public.package_prices
  for each row execute function private.check_version();
drop trigger if exists package_prices_audit on public.package_prices;
create trigger package_prices_audit after insert or update on public.package_prices
  for each row execute function private.audit();
-- No se borran: se desactivan (sin permiso de borrado). En pausa no se pueden cambiar.
drop trigger if exists package_prices_pausa on public.package_prices;
create trigger package_prices_pausa before insert or update or delete on public.package_prices
  for each row execute function private.block_if_paused();

alter table public.package_prices enable row level security;
drop policy if exists "miembros leen paquetes fijos" on public.package_prices;
create policy "miembros leen paquetes fijos" on public.package_prices for select to authenticated
  using (private.is_member(workspace_id));
drop policy if exists "administradores crean paquetes fijos" on public.package_prices;
create policy "administradores crean paquetes fijos" on public.package_prices for insert to authenticated
  with check (private.has_role(workspace_id, array['propietario','administrador']));
drop policy if exists "administradores cambian paquetes fijos" on public.package_prices;
create policy "administradores cambian paquetes fijos" on public.package_prices for update to authenticated
  using (private.has_role(workspace_id, array['propietario','administrador']))
  with check (private.has_role(workspace_id, array['propietario','administrador']));
revoke all on public.package_prices from anon, authenticated;
grant select on public.package_prices to authenticated;
grant insert (workspace_id, space_kind, days, price, extra_day_price, valid_from, valid_to) on public.package_prices to authenticated;
grant update (price, extra_day_price, valid_from, valid_to, active, version) on public.package_prices to authenticated;

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

-- Las copias de seguridad incluyen los paquetes con precio fijo.
create or replace function private.snapshot(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb := '{}'::jsonb;
  t text;
  v_rows jsonb;
begin
  foreach t in array array[
    'spaces','map_features','customers','agreements','expense_categories','package_discounts','package_prices','rates','extras',
    'reservations','reservation_changes','reservation_segments','reservation_charges','reservation_discounts','reservation_extras',
    'maintenance_blocks','cash_sessions','payments','expenses','cash_movements','restaurant_vouchers','day_notes',
    'renewal_marks','workspace_members','audit_log'
  ] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(snap_row)), ''[]''::jsonb) from public.%I as snap_row where snap_row.workspace_id = $1', t)
      into v_rows using p_ws;
    v := v || jsonb_build_object(t, v_rows);
  end loop;
  select v || jsonb_build_object('workspace', to_jsonb(w) - 'logo_data') into v from public.workspaces w where w.id = p_ws;
  return v;
end $$;

create or replace function private.restore_tables() returns text[]
language sql immutable as $$
  select array['spaces','map_features','customers','agreements','expense_categories','package_discounts','package_prices','rates','extras',
               'reservations','reservation_changes','reservation_segments','reservation_charges','reservation_discounts','reservation_extras',
               'maintenance_blocks','cash_sessions','payments','expenses','cash_movements','restaurant_vouchers','day_notes',
               'renewal_marks']
$$;

commit;
