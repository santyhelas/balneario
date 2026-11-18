-- =====================================================================
-- 0069 · Paquetes de precio fijo dentro del tarifario, por quincena.
--   · En cada quincena, además del precio por día, se cargan precios cerrados por cantidad de días
--     (7, 10, 15, 30… días). Se elige por el día de entrada; los días que pasan del paquete
--     se suman al precio normal del tarifario (ej.: 7 días $700.000 → 8 días $700.000 + 1 día).
--   · Precio fijo es lo predeterminado. Si el balneario prefiere descuentos en %, apaga
--     «Paquetes de precio fijo» en Configuración: es uno u otro, no se suman.
--   · «Copiar tarifas» copia también los paquetes de esas quincenas.
-- =====================================================================

-- Predeterminado para los balnearios nuevos: paquetes de precio fijo.
alter table public.workspaces alter column features set default '{"paquetes": true}'::jsonb;
-- Los que ya existen pasan a precio fijo, salvo que ya hayan cobrado reservas con paquete en %.
update public.workspaces w set features = w.features || '{"paquetes": true}'::jsonb, version = w.version + 1
 where not coalesce((w.features ->> 'paquetes')::boolean, false)
   and not exists (select 1 from public.reservation_discounts d join public.reservations r on r.id = d.reservation_id
                    where d.workspace_id = w.id and d.kind = 'paquete' and r.status <> 'cancelada');

-- Primer y último día de una quincena.
create or replace function private.half_bounds(p_year integer, p_month integer, p_half smallint, out v_from date, out v_to date)
language sql immutable set search_path = '' as $$
  select make_date(p_year, p_month, case when p_half = 1 then 1 else 16 end),
         case when p_half = 1 then make_date(p_year, p_month, 15)
              else (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date end
$$;

-- Precio de un paquete de N días en una quincena (p_price null = quitarlo). Control de edición simultánea.
create or replace function public.set_package_price(
  p_workspace_id uuid, p_space_kind text, p_year integer, p_month integer, p_half smallint,
  p_days integer, p_price numeric, p_expected_version integer default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.package_prices%rowtype;
  v_b record;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  if p_space_kind is null or p_space_kind not in ('carpa','sombrilla','cochera') then
    raise exception 'Tipo de espacio inválido.';
  end if;
  if p_month is null or p_month not between 1 and 12 or p_half is null or p_half not in (1, 2) or p_year is null then
    raise exception 'Quincena inválida.';
  end if;
  if p_days is null or p_days < 2 or p_days > 366 then
    raise exception 'Los días del paquete tienen que ser entre 2 y 366.';
  end if;
  if p_price is not null and p_price < 0 then
    raise exception 'El precio no puede ser negativo.';
  end if;
  select * into v_b from private.half_bounds(p_year, p_month, p_half);
  select * into v from public.package_prices
   where workspace_id = p_workspace_id and active and space_kind = p_space_kind and days = p_days
     and valid_from = v_b.v_from and valid_to = v_b.v_to
   order by created_at desc limit 1
   for update;
  if found then
    if p_expected_version is distinct from v.version then
      raise exception 'Este precio fue modificado desde otro dispositivo. Recargá e intentá de nuevo.'
        using errcode = '40001', hint = 'CONFLICTO_VERSION';
    end if;
    if p_price is null then
      update public.package_prices set active = false, version = v.version + 1 where id = v.id returning * into v;
    else
      update public.package_prices set price = round(p_price, 2), extra_day_price = null, version = v.version + 1
       where id = v.id returning * into v;
    end if;
  elsif p_expected_version is not null then
    raise exception 'Este precio fue modificado desde otro dispositivo. Recargá e intentá de nuevo.'
      using errcode = '40001', hint = 'CONFLICTO_VERSION';
  elsif p_price is not null then
    insert into public.package_prices (workspace_id, space_kind, days, price, extra_day_price, valid_from, valid_to)
    values (p_workspace_id, p_space_kind, p_days, round(p_price, 2), null, v_b.v_from, v_b.v_to) returning * into v;
  else
    return '{}'::jsonb;
  end if;
  return to_jsonb(v);
end $$;
revoke all on function public.set_package_price(uuid, text, integer, integer, smallint, integer, numeric, integer) from public, anon;
grant execute on function public.set_package_price(uuid, text, integer, integer, smallint, integer, numeric, integer) to authenticated;

-- Copiar tarifas: también copia los paquetes de precio fijo de esas quincenas.
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
  v_pexist public.package_prices%rowtype;
  v_price numeric(14,2);
  v_h smallint;
  v_src record;
  v_dst record;
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

  -- Paquetes de precio fijo de la(s) quincena(s) de origen.
  foreach v_h in array case when p_src_half is null then array[1, 2]::smallint[] else array[p_src_half] end loop
    select * into v_src from private.half_bounds(p_src_year, p_src_month, v_h);
    select * into v_dst from private.half_bounds(p_dst_year, p_dst_month, coalesce(p_dst_half, v_h));
    for r in select * from public.package_prices
              where workspace_id = p_workspace_id and active and valid_from = v_src.v_from and valid_to = v_src.v_to loop
      v_price := round(r.price * (1 + coalesce(p_adjust_percent, 0) / 100));
      select * into v_pexist from public.package_prices
       where workspace_id = p_workspace_id and active and space_kind = r.space_kind and days = r.days
         and valid_from = v_dst.v_from and valid_to = v_dst.v_to
       limit 1 for update;
      if found then
        if not p_overwrite then
          v_skipped := v_skipped + 1;
          continue;
        end if;
        update public.package_prices set price = v_price,
               extra_day_price = case when r.extra_day_price is null then null else round(r.extra_day_price * (1 + coalesce(p_adjust_percent, 0) / 100)) end,
               version = v_pexist.version + 1
         where id = v_pexist.id;
      else
        insert into public.package_prices (workspace_id, space_kind, days, price, extra_day_price, valid_from, valid_to)
        values (p_workspace_id, r.space_kind, r.days, v_price,
                case when r.extra_day_price is null then null else round(r.extra_day_price * (1 + coalesce(p_adjust_percent, 0) / 100)) end,
                v_dst.v_from, v_dst.v_to);
      end if;
      v_copied := v_copied + 1;
    end loop;
  end loop;
  return jsonb_build_object('copiados', v_copied, 'omitidos', v_skipped);
end $$;

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
  v_rate_from date;  -- con paquete fijo y días extra a precio de tarifario: desde qué día se usa el tarifario
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
         and coalesce((v_ws.features ->> 'paquetes')::boolean, false)  -- en modo % no se usan los precios fijos
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
    if v_extra > 0 and v_pack.extra_day_price is null then
      -- Días extra al precio normal del tarifario (se calculan abajo, día por día).
      v_rate_from := p_start + v_pack.days;
    elsif v_extra > 0 then
      v_charges := v_charges || jsonb_build_object(
        'description', format('%s %s extra × %s', v_extra, case when v_extra = 1 then 'día' else 'días' end, private.ars(v_pack.extra_day_price)),
        'space_kind', v_kind, 'start_date', p_start + v_pack.days, 'end_date', p_end,
        'days', v_extra, 'unit_price', v_pack.extra_day_price, 'amount', v_pack.extra_day_price * v_extra, 'is_manual', false,
        'rate_snapshot', jsonb_build_object('package_price_id', v_pack.id, 'extra_day_price', v_pack.extra_day_price));
      v_base := v_base + v_pack.extra_day_price * v_extra;
    end if;
  end if;
  if (not v_fixed and not v_is_manual) or v_rate_from is not null then
    for v_seg in select * from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) order by (value ->> 'start_date') loop
      select * into v_space from public.spaces where id = (v_seg ->> 'space_id')::uuid and workspace_id = p_workspace_id;
      if not found then
        raise exception 'Uno de los espacios elegidos no existe.';
      end if;
      v_d := greatest((v_seg ->> 'start_date')::date, coalesce(v_rate_from, (v_seg ->> 'start_date')::date));
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
      -- Con «paquetes de precio fijo» prendido, los paquetes en % no se usan (es uno u otro).
      and not coalesce((v_ws.features ->> 'paquetes')::boolean, false)
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
