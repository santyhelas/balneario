-- ACTUALIZACIÓN 0033 · Plano más grande, tope de descuento y límite de efectivo en caja.
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0032).
begin;
-- =====================================================================
-- 0033 · Plano más grande, tope de descuento y límite de efectivo en caja.
--   · Agrandar (o achicar) el plano del balneario sin perder la ubicación de nada:
--     lo que está cerca del mar queda cerca del mar; el lugar nuevo se suma del lado de tierra.
--   · Tope de descuento (% del precio base) configurable por balneario.
--   · Límite de efectivo en caja: por encima, se avisa que conviene hacer un depósito.
--     El depósito se registra como salida de efectivo (no es un gasto) y se puede anular.
-- =====================================================================

alter table public.workspaces add column if not exists discount_cap_percent numeric(5,2)
  check (discount_cap_percent is null or (discount_cap_percent > 0 and discount_cap_percent <= 100));
alter table public.workspaces add column if not exists cash_limit numeric(14,2) check (cash_limit is null or cash_limit > 0);
grant update (discount_cap_percent, cash_limit) on public.workspaces to authenticated;

-- ---------------------------------------------------------------------
-- Depósitos de efectivo (sacar plata de la caja para llevarla al banco)
-- ---------------------------------------------------------------------
alter table public.cash_movements add column if not exists voids_movement_id uuid unique references public.cash_movements(id);
alter table public.cash_movements drop constraint if exists cash_movements_category_check;
alter table public.cash_movements add constraint cash_movements_category_check check (category in (
  'cobro','devolucion','anulacion_cobro','anulacion_devolucion','gasto','anulacion_gasto','otro_ingreso','deposito','anulacion_deposito'));
alter table public.cash_movements add constraint cash_movements_deposito_check check (
  category not in ('deposito','anulacion_deposito') or (method = 'efectivo' and idempotency_key is not null));
alter table public.cash_movements add constraint cash_movements_anulacion_deposito_check check (
  (category = 'anulacion_deposito') = (voids_movement_id is not null));

create or replace function public.register_cash_deposit(p_workspace_id uuid, p_idempotency_key uuid, p_amount numeric, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing uuid;
  v_session uuid;
  v_open numeric;
  v_cash numeric;
  v_id uuid;
begin
  perform private.require_member(p_workspace_id);
  if p_idempotency_key is null then raise exception 'Falta la clave de operación.'; end if;
  select id into v_existing from public.cash_movements where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('movement_id', v_existing, 'repetida', true); end if;
  if p_amount is null or p_amount <= 0 then raise exception 'El importe debe ser mayor a cero.'; end if;
  v_session := private.today_session(p_workspace_id);
  perform 1 from public.cash_sessions where id = v_session for update;
  select opening_cash into v_open from public.cash_sessions where id = v_session;
  select v_open + coalesce(sum(case when direction = 'entrada' then amount else -amount end), 0) into v_cash
  from public.cash_movements where cash_session_id = v_session and method = 'efectivo';
  if round(p_amount, 2) > v_cash then
    raise exception 'El depósito (%) supera el efectivo que tiene que haber en la caja (%).', private.ars(p_amount), private.ars(v_cash);
  end if;
  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, idempotency_key)
  values (p_workspace_id, v_session, 'salida', 'efectivo', round(p_amount, 2), 'deposito',
          left('Depósito de efectivo' || coalesce(' · ' || nullif(btrim(p_note), ''), ''), 200), p_idempotency_key)
  returning id into v_id;
  return jsonb_build_object('movement_id', v_id, 'repetida', false);
end $$;

create or replace function public.void_cash_deposit(p_movement_id uuid, p_idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.cash_movements%rowtype;
  v_session uuid;
  v_id uuid;
begin
  select * into m from public.cash_movements where id = p_movement_id;
  if not found or m.category <> 'deposito' then raise exception 'El depósito no existe.'; end if;
  perform private.require_member(m.workspace_id, array['propietario','administrador']);
  select id into v_id from public.cash_movements where voids_movement_id = m.id;
  if found then raise exception 'Ese depósito ya fue anulado.'; end if;
  v_session := private.today_session(m.workspace_id);
  if v_session <> m.cash_session_id then raise exception 'Solo se puede anular un depósito de la caja de hoy.'; end if;
  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, idempotency_key, voids_movement_id)
  values (m.workspace_id, v_session, 'entrada', 'efectivo', m.amount, 'anulacion_deposito', 'Anulación de depósito de efectivo', p_idempotency_key, m.id)
  returning id into v_id;
  return jsonb_build_object('movement_id', v_id);
end $$;

revoke all on function public.register_cash_deposit(uuid, uuid, numeric, text), public.void_cash_deposit(uuid, uuid) from public, anon;
grant execute on function public.register_cash_deposit(uuid, uuid, numeric, text), public.void_cash_deposit(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Agrandar o achicar el plano
-- ---------------------------------------------------------------------
create or replace function public.resize_map(p_workspace_id uuid, p_width integer, p_height integer, p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  w public.workspaces%rowtype;
  dx numeric;
  dy numeric;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  select * into w from public.workspaces where id = p_workspace_id for update;
  if w.version <> p_expected_version then
    raise exception 'Otra persona cambió la configuración recién. Volvé a intentar.' using errcode = '40001';
  end if;
  if p_width is null or p_height is null or p_width not between 400 and 20000 or p_height not between 400 and 20000 then
    raise exception 'El plano tiene que medir entre 400 y 20.000 de ancho y de alto.';
  end if;
  -- El lado del mar queda fijo: lo nuevo se agrega del lado de tierra (y a lo ancho, repartido a los costados).
  dx := case w.sea_side when 'left' then 0 when 'right' then p_width - w.map_width else round((p_width - w.map_width) / 2.0) end;
  dy := case w.sea_side when 'top' then 0 when 'bottom' then p_height - w.map_height else round((p_height - w.map_height) / 2.0) end;
  if exists (select 1 from public.spaces where workspace_id = p_workspace_id and active
             and (x + dx < 0 or x + dx > p_width or y + dy < 0 or y + dy > p_height))
     or exists (select 1 from public.map_features where workspace_id = p_workspace_id and active
             and (x + dx < 0 or x + dx > p_width or y + dy < 0 or y + dy > p_height)) then
    raise exception 'Hay carpas o elementos que quedarían fuera del plano. Movelos hacia el centro antes de achicarlo.';
  end if;
  if dx <> 0 or dy <> 0 then
    update public.spaces set x = x + dx, y = y + dy, version = version + 1 where workspace_id = p_workspace_id;
    update public.map_features set x = x + dx, y = y + dy, version = version + 1 where workspace_id = p_workspace_id;
  end if;
  update public.workspaces set map_width = p_width, map_height = p_height, version = version + 1 where id = p_workspace_id;
  return jsonb_build_object('ancho', p_width, 'alto', p_height);
end $$;
revoke all on function public.resize_map(uuid, integer, integer, integer) from public, anon;
grant execute on function public.resize_map(uuid, integer, integer, integer) to authenticated;

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
    select percent into v_pct from public.package_discounts
    where workspace_id = p_workspace_id and active and min_days <= v_total_days
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
    'tope_aplicado', v_capped
  );
end $$;

commit;
