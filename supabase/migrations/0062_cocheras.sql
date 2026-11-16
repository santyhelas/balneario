-- =====================================================================
-- 0062 · Cocheras: un tipo de espacio más, igual que carpas y sombrillas.
--   · Tienen número, lugar en el plano, disponibilidad por fecha, mantenimiento y tarifa por quincena.
--   · Se reservan solas o junto con la carpa (como grupo: misma reserva de grupo, un solo cobro).
--   · No cuentan para el plan contratado ni para el % de ocupación de la playa.
--   · La demo trae 12 cocheras en un estacionamiento.
--   · En un grupo, la cochera no toma el precio manual de la carpa principal.
-- =====================================================================
alter table public.spaces drop constraint if exists spaces_kind_check;
alter table public.spaces add constraint spaces_kind_check check (kind in ('carpa','sombrilla','cochera'));
alter table public.rates drop constraint if exists rates_space_kind_check;
alter table public.rates add constraint rates_space_kind_check check (space_kind in ('carpa','sombrilla','cochera'));
alter table public.package_prices drop constraint if exists package_prices_space_kind_check;
alter table public.package_prices add constraint package_prices_space_kind_check check (space_kind in ('carpa','sombrilla','cochera'));
alter table public.reservation_charges drop constraint if exists reservation_charges_space_kind_check;
alter table public.reservation_charges add constraint reservation_charges_space_kind_check check (space_kind in ('carpa','sombrilla','cochera'));

create or replace function private.space_label(p_kind text, p_code text) returns text
language sql immutable as $$
  select case p_kind when 'sombrilla' then 'Sombrilla ' when 'cochera' then 'Cochera ' else 'Carpa ' end || p_code
$$;

CREATE OR REPLACE FUNCTION private.enforce_space_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_max integer;
  v_n integer;
begin
  if not new.active then return new; end if;
  -- Las cocheras no cuentan para el plan (que es de carpas y sombrillas).
  if new.kind = 'cochera' then return new; end if;
  if tg_op = 'UPDATE' and old.active and old.kind = new.kind then return new; end if;
  if coalesce(private.restoring(new.workspace_id::text), false) or coalesce(private.purging(new.workspace_id::text), false) or private.is_platform_admin() then return new; end if;
  select case new.kind when 'carpa' then max_tents else max_umbrellas end into v_max
    from public.workspaces where id = new.workspace_id;
  if v_max is null then return new; end if;
  -- De a una por balneario, para que dos compus no se pasen juntas.
  perform pg_advisory_xact_lock(hashtextextended('espacios:' || new.workspace_id::text, 0));
  select count(*) into v_n from public.spaces
   where workspace_id = new.workspace_id and kind = new.kind and active and id <> new.id;
  if v_n + 1 > v_max then
    raise exception 'Tu plan incluye % %. Podés desactivar una y activar otra, pero para sumar más escribinos.',
      v_max, case new.kind when 'carpa' then case when v_max = 1 then 'carpa' else 'carpas' end else case when v_max = 1 then 'sombrilla' else 'sombrillas' end end
      using errcode = 'P0001', hint = 'LIMITE_ESPACIOS';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.season_stats(p_workspace_id uuid, p_start_year integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_from date := make_date(p_start_year, 7, 1);
  v_to date := make_date(p_start_year + 1, 6, 30);
begin
  perform private.require_member(p_workspace_id);
  if p_start_year < 2000 or p_start_year > 2100 then raise exception 'Temporada inválida.'; end if;
  return (
    with meses as (
      select gs::date as desde, (gs + interval '1 month' - interval '1 day')::date as hasta
      from generate_series(v_from, v_to, interval '1 month') gs
    ),
    capacidad as (select count(*) filter (where active) as espacios from public.spaces where workspace_id = p_workspace_id and kind <> 'cochera')
    select jsonb_build_object(
      'temporada', p_start_year || '/' || (p_start_year + 1),
      'espacios', (select espacios from capacidad),
      'meses', jsonb_agg(jsonb_build_object(
        'mes', to_char(m.desde, 'YYYY-MM'),
        'dias_ocupados', (
          select coalesce(sum(least(s.end_date, m.hasta) - greatest(s.start_date, m.desde) + 1), 0)
          from public.reservation_segments s join public.reservations r on r.id = s.reservation_id
          join public.spaces sp on sp.id = s.space_id and sp.kind <> 'cochera'
          where s.workspace_id = p_workspace_id and s.active and r.status = 'confirmada'
            and s.start_date <= m.hasta and s.end_date >= m.desde),
        'dias_posibles', (select espacios from capacidad) * (m.hasta - m.desde + 1),
        'reservas', (select count(*) from public.reservations r where r.workspace_id = p_workspace_id
                     and r.status = 'confirmada' and r.start_date between m.desde and m.hasta),
        'contratado', (select coalesce(sum(r.total_amount), 0) from public.reservations r where r.workspace_id = p_workspace_id
                       and r.status = 'confirmada' and r.start_date between m.desde and m.hasta),
        'cobrado', (select coalesce(sum(case when mv.category in ('cobro','otro_ingreso','anulacion_devolucion') then mv.amount
                                             when mv.category in ('devolucion','anulacion_cobro') then -mv.amount end), 0)
                    from public.cash_sessions cs join public.cash_movements mv on mv.cash_session_id = cs.id
                    where cs.workspace_id = p_workspace_id and cs.business_date between m.desde and m.hasta),
        'gastos', (select coalesce(sum(e.amount), 0) from public.expenses e where e.workspace_id = p_workspace_id
                   and e.voided_at is null and e.spent_on between m.desde and m.hasta)
      ) order by m.desde)
    )
    from meses m
  );
end $function$;

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
end $function$;

CREATE OR REPLACE FUNCTION private.seed_demo(p_ws uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_today date := private.ws_today(p_ws);
  v_tz text := (select timezone from public.workspaces where id = p_ws);
  v_hist int := 30;          -- días de historia
  v_far int := 80;           -- hasta dónde llegan las reservas lejanas
  v_first text[] := array['Juan','María','Carlos','Laura','Diego','Sofía','Martín','Valentina','Pablo','Lucía','Federico','Camila',
    'Nicolás','Florencia','Gustavo','Agustina','Hernán','Julieta','Sebastián','Paula','Ricardo','Silvina','Alejandro','Mariana',
    'Gonzalo','Carolina','Matías','Romina','Andrés','Natalia','Leandro','Verónica','Facundo','Daniela','Ezequiel','Gabriela',
    'Tomás','Micaela','Ignacio','Rocío','Marcelo','Claudia','Esteban','Lorena','Rodrigo','Analía','Franco','Belén','Javier','Cecilia'];
  v_last text[] := array['González','Rodríguez','Fernández','López','Martínez','Pérez','Gómez','Sánchez','Romero','Díaz','Álvarez',
    'Torres','Ruiz','Ramírez','Flores','Acosta','Benítez','Medina','Herrera','Suárez','Aguirre','Giménez','Molina','Castro','Ortiz',
    'Silva','Núñez','Luna','Juárez','Cabrera','Ríos','Ferreyra','Godoy','Morales','Domínguez','Moreno','Peralta','Vega','Carrizo','Quiroga'];
  v_towns text[] := array['Mar de Ajó','San Bernardo','Buenos Aires','La Plata','Córdoba','Rosario','Mendoza','San Juan','Tandil','Bahía Blanca','Lomas de Zamora','Quilmes'];
  v_cnotes text[] := array['Prefiere primera fila','Viene con perro (chico)','Pide sombra a la tarde','Cliente de hace años','Paga siempre por transferencia',
    'Familia numerosa: pide carpas juntas','Le molesta el viento: ubicar resguardado','Avisar si se libera la carpa de siempre'];
  v_n_cust int := 230;
  v_custs uuid[] := '{}';
  v_cid uuid; v_i int; v_j int; v_d date; v_end date; v_len int; v_kind text; v_m date; v_price numeric; v_half int;
  v_sp record; v_r record; v_res jsonb; v_rid uuid; v_total numeric; v_paid numeric; v_amt numeric; v_amt2 numeric;
  v_opts jsonb; v_segs jsonb; v_book date; v_method text; v_p numeric; v_x numeric; v_gap int;
  v_ag10 uuid; v_ag15 uuid; v_ex record; v_exr uuid; v_exs uuid; v_exg uuid; v_exm uuid;
  v_target uuid; v_ver int; v_sess uuid; v_exp numeric; v_diff numeric; v_pay uuid; v_cnt int;
  v_lens int[] := array[1,2,3,3,5,5,5,7,7,7,7,10,10,14,15,15,15,21,30];
  v_methods text[] := array['efectivo','efectivo','transferencia','transferencia','tarjeta'];
  v_plan jsonb := '[]'::jsonb;  -- cobros a registrar día por día
  v_ps date;                    -- temporada pasada: desde el 1/12 …
  v_pe date;                    -- … hasta el 31/3
  v_plan2 jsonb := '[]'::jsonb; -- cobros de la temporada pasada
begin
  if not exists (select 1 from public.workspaces where id = p_ws and is_demo) then
    raise exception 'Solo para balnearios de demostración.';
  end if;
  perform setseed(0.27);

  -- ── Configuración ────────────────────────────────────────────────
  update public.workspaces set cash_limit = 400000, version = version + 1 where id = p_ws;

  -- Cocheras: 12 lugares en el estacionamiento, del lado de la calle (arriba a la derecha del plano).
  insert into public.map_features (workspace_id, kind, label, x, y, width, height, layer)
  values (p_ws, 'sector', 'Estacionamiento', 2500, 400, 760, 470, -1);
  insert into public.spaces (workspace_id, kind, code, x, y)
    select p_ws, 'cochera', 'C' || i, 2200 + ((i - 1) % 6) * 120, case when i <= 6 then 275 else 525 end
      from generate_series(1, 12) i
     where not exists (select 1 from public.spaces s where s.workspace_id = p_ws and s.kind = 'cochera');

  -- Tarifas: desde antes de la historia hasta después de las reservas lejanas
  for v_kind in select unnest(array['carpa','sombrilla','cochera']) loop
    for v_m in select generate_series(date_trunc('month', v_today - v_hist - 31), date_trunc('month', v_today + v_far + 31), interval '1 month')::date loop
      for v_half in 1..2 loop
        v_price := case extract(month from v_m) when 1 then 42000 when 2 then 38000 when 12 then 28000 when 3 then 24000 else 18000 end;
        if v_half = 2 and extract(month from v_m) = 12 then v_price := 36000; end if;
        if v_kind = 'sombrilla' then v_price := round(v_price * 0.55 / 500) * 500; end if;
        if v_kind = 'cochera' then v_price := round(v_price * 0.3 / 500) * 500; end if;
        perform public.set_rate(p_ws, v_kind, extract(year from v_m)::int, extract(month from v_m)::int, v_half::smallint, v_price);
      end loop;
    end loop;
  end loop;

  -- Tarifas de la temporada pasada (más baratas: así se ve la diferencia al comparar temporadas)
  v_ps := make_date(extract(year from v_today)::int - case when extract(month from v_today) >= 7 then 1 else 2 end, 12, 1);
  v_pe := make_date(extract(year from v_ps)::int + 1, 3, 31);
  -- La temporada pasada arranca el mismo día que la historia de esta, un año antes: así «Comparar temporadas»
  -- tiene con qué comparar también los meses flojos del principio.
  v_ps := least(v_ps, ((v_today - v_hist) - interval '1 year')::date);
  for v_kind in select unnest(array['carpa','sombrilla','cochera']) loop
    for v_m in select generate_series(v_ps, v_pe, interval '1 month')::date loop
      for v_half in 1..2 loop
        v_price := case extract(month from v_m) when 1 then 26000 when 2 then 24000 when 12 then 17000 else 15000 end;
        if v_half = 2 and extract(month from v_m) = 12 then v_price := 22000; end if;
        if v_kind = 'sombrilla' then v_price := round(v_price * 0.55 / 500) * 500; end if;
        if v_kind = 'cochera' then v_price := round(v_price * 0.3 / 500) * 500; end if;
        perform public.set_rate(p_ws, v_kind, extract(year from v_m)::int, extract(month from v_m)::int, v_half::smallint, v_price);
      end loop;
    end loop;
  end loop;

  -- Convenios: en la demo solo los dos inventados (el de Parque Bonito que trae todo balneario nuevo se saca).
  update public.agreements set deleted_at = now(), active = false, version = version + 1 where workspace_id = p_ws and name = 'Parque Bonito';
  insert into public.agreements (workspace_id, name, percent) values (p_ws, 'Club Náutico Las Gaviotas', 10) returning id into v_ag10;
  insert into public.agreements (workspace_id, name, percent) values (p_ws, 'Mutual Docentes del Sur', 15) returning id into v_ag15;

  -- Extras
  insert into public.extras (workspace_id, name, price, per_day) values (p_ws, 'Reposera', 3000, true) returning id into v_exr;
  insert into public.extras (workspace_id, name, price, per_day) values (p_ws, 'Sombrilla adicional', 5000, true) returning id into v_exs;
  insert into public.extras (workspace_id, name, price, per_day) values (p_ws, 'Gazebo', 9000, true) returning id into v_exg;
  insert into public.extras (workspace_id, name, price, per_day) values (p_ws, 'Mesa y 4 sillas', 15000, false) returning id into v_exm;

  -- ── Clientes ─────────────────────────────────────────────────────
  for v_i in 1..v_n_cust loop
    v_j := 1 + floor(random() * array_length(v_first, 1))::int;
    v_kind := v_last[1 + floor(random() * array_length(v_last, 1))::int];
    insert into public.customers (workspace_id, first_name, last_name, phone, email, locality, notes)
    values (p_ws, v_first[v_j], v_kind,
            '+54 9 ' || (array['2257','11','351','341','264','2255','221'])[1 + floor(random() * 7)::int] || ' ' || (4000000 + floor(random() * 5999999)::int),
            case when random() < 0.45 then lower(translate(v_first[v_j] || '.' || v_kind, 'áéíóúÁÉÍÓÚñÑ ', 'aeiouAEIOUnN')) || (array['@gmail.com','@hotmail.com','@yahoo.com.ar','@outlook.com'])[1 + floor(random() * 4)::int] end,
            v_towns[1 + floor(random() * array_length(v_towns, 1))::int],
            case when random() < 0.12 then v_cnotes[1 + floor(random() * array_length(v_cnotes, 1))::int] end)
    returning id into v_cid;
    v_custs := v_custs || v_cid;
  end loop;
  -- Dos personas con el mismo nombre (el sistema lo permite y avisa).
  insert into public.customers (workspace_id, first_name, last_name, phone, locality)
  values (p_ws, 'Juan', 'Pérez', '+54 9 11 5550101', 'Buenos Aires'), (p_ws, 'Juan', 'Pérez', '+54 9 351 5550202', 'Córdoba');

  -- Mientras se cargan las reservas de ejemplo no se llena el historial de cambios (es todo inventado y
  -- lo hace más lento). La disponibilidad igual se controla: create_reservation revisa cada carpa.
  perform set_config('app.restore_ws', p_ws::text, true);

  -- ── Reservas: carpa por carpa, a lo largo del tiempo ─────────────
  -- Casi lleno, pero 5 carpas y 1 sombrilla quedan libres desde hoy por 10 días, para poder probar una reserva.
  for v_sp in select id, kind, (row_number() over (partition by kind order by random())) <= (case kind when 'carpa' then 5 when 'cochera' then 3 else 1 end) as libre
                from public.spaces where workspace_id = p_ws and active order by random() loop
    v_d := v_today - v_hist + floor(random() * 4)::int;
    loop
      exit when v_d > v_today + v_far;
      if v_sp.libre and v_d between v_today and v_today + 10 then v_d := v_today + 11; continue; end if;
      -- Qué tan lleno: la historia bastante, hoy y la semana casi completo, más adelante cada vez menos.
      v_p := case when v_d < v_today - 12 then 0.75 when v_d <= v_today + 8 then 0.93 when v_d <= v_today + 25 then 0.5 else 0.14 end;
      if random() > v_p then
        v_d := v_d + 1 + floor(random() * (case when v_d > v_today + 25 then 8 else 3 end))::int;
        continue;
      end if;
      v_len := v_lens[1 + floor(random() * array_length(v_lens, 1))::int];
      v_end := v_d + v_len - 1;
      -- Algunas estadías terminan hoy (para ver las salidas del día).
      if v_d < v_today and v_end > v_today and random() < 0.15 then v_end := v_today; end if;
      if v_sp.libre and v_d < v_today and v_end >= v_today then v_end := v_today - 1; end if;

      -- Cliente: los primeros de la lista vuelven más seguido (clientes frecuentes).
      v_cid := v_custs[1 + floor(power(random(), 1.25) * v_n_cust)::int];

      -- Descuentos: convenios, efectivo, manual o cortesía.
      v_x := random();
      v_opts := case
        when v_x < 0.03 then jsonb_build_object('courtesy', true, 'courtesy_beneficiary', (array['Hermana del dueño','Sobrinos del dueño','Padres del encargado'])[1 + floor(random() * 3)::int])
        when v_x < 0.14 then jsonb_build_object('agreement_id', v_ag10)
        when v_x < 0.21 then jsonb_build_object('agreement_id', v_ag15)
        when v_x < 0.27 then jsonb_build_object('manual', jsonb_build_object('type', 'monto', 'value', 5000, 'reason', 'Cliente de muchos años'))
        when v_x < 0.50 then jsonb_build_object('cash', true)
        else '{}'::jsonb end;
      v_segs := jsonb_build_array(jsonb_build_object('space_id', v_sp.id, 'start_date', v_d, 'end_date', v_end));
      v_rid := null;
      begin
        v_res := public.create_reservation_v2(p_ws, gen_random_uuid(), v_cid, v_d, v_end, v_segs, v_opts,
          case when v_opts ? 'courtesy' then 'Familia del dueño' when random() < 0.08 then 'Llega a la tarde' end, null);
        v_rid := (v_res ->> 'reservation_id')::uuid;
      exception when others then
        v_rid := null;
      end;

      if v_rid is not null then
        -- Extras: reposeras sobre todo
        if not (v_opts ? 'courtesy') and random() < 0.22 then
          v_x := random();
          perform public.add_reservation_extra(v_rid, case when v_x < 0.6 then v_exr when v_x < 0.8 then v_exs when v_x < 0.9 then v_exg else v_exm end,
                                               case when v_x < 0.6 then 1 + floor(random() * 3)::int else 1 end, null);
        end if;

        -- Cuándo reservó (y pagó): antes de llegar, nunca antes de la historia ni después de hoy.
        v_book := greatest(v_today - v_hist, least(v_today, v_d - floor(random() * 12)::int));
        if v_d > v_today + 10 then v_book := greatest(v_today - v_hist, v_today - floor(random() * 25)::int); end if;
        update public.reservations set created_at = (v_book::timestamp + interval '10 hours' + floor(random() * 480) * interval '1 minute') at time zone v_tz,
               version = version + 1 where id = v_rid;

        select total_amount into v_total from public.reservations where id = v_rid;
        v_method := case when v_opts ? 'cash' then 'efectivo' else v_methods[1 + floor(random() * 5)::int] end;
        v_x := random();
        if v_total > 0 then
          if v_x < 0.55 then
            -- Pagada completa al reservar
            if v_book < v_today then
              v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_total, 'm', v_method, 'd', v_book, 't', (v_book::timestamp + interval '11 hours' + floor(random() * 420) * interval '1 minute') at time zone v_tz);
            else
              v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_total, 'm', v_method, 'd', v_today);
            end if;
          elsif v_x < 0.82 then
            -- Seña (30 a 50%) y el resto al llegar… o queda debiendo
            v_amt := floor(v_total * (0.3 + random() * 0.2) / 1000) * 1000;
            if v_amt > 0 then
              if v_book < v_today then
                v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_amt, 'm', case when random() < 0.6 then 'transferencia' else v_method end, 'd', v_book, 't', (v_book::timestamp + interval '10 hours' + floor(random() * 480) * interval '1 minute') at time zone v_tz);
              else
                v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_amt, 'm', 'transferencia', 'd', v_today, 'n', 'Seña');
              end if;
            end if;
            if v_d < v_today and v_d > v_book and random() < 0.9 then
              -- Saldo al llegar (a veces en dos medios distintos)
              v_amt2 := v_total - v_amt;
              if random() < 0.3 and v_amt2 > 4000 then
                v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', floor(v_amt2 / 2), 'm', 'efectivo', 'd', v_d, 't', (v_d::timestamp + interval '10 hours 15 minutes') at time zone v_tz);
                v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_amt2 - floor(v_amt2 / 2), 'm', 'tarjeta', 'd', v_d, 't', (v_d::timestamp + interval '10 hours 20 minutes') at time zone v_tz);
              else
                v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_amt2, 'm', v_methods[1 + floor(random() * 5)::int], 'd', v_d, 't', (v_d::timestamp + interval '10 hours 30 minutes') at time zone v_tz);
              end if;
            end if;
          elsif v_x < 0.93 then
            -- Cobrar después: paga cuando llega (o sigue debiendo)
            if v_d < v_today and random() < 0.88 then
              v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_total, 'm', v_methods[1 + floor(random() * 5)::int], 'd', v_d, 't', (v_d::timestamp + interval '12 hours') at time zone v_tz);
            end if;
          else
            -- Paga en cuotas: tres pagos con distintos medios
            v_amt := floor(v_total / 3);
            if v_book < v_today then
              v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_amt, 'm', 'transferencia', 'd', v_book, 't', (v_book::timestamp + interval '9 hours 50 minutes') at time zone v_tz);
            end if;
            if v_d < v_today and v_d > v_book then
              v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_amt, 'm', 'efectivo', 'd', v_d, 't', (v_d::timestamp + interval '11 hours') at time zone v_tz);
              if v_d + 2 < v_today and v_d + 2 <= v_end then
                v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_total - 2 * v_amt, 'm', 'tarjeta', 'd', v_d + 2, 't', (v_d::timestamp + interval '2 days 17 hours') at time zone v_tz);
              end if;
            end if;
          end if;
        end if;

        -- La próxima: a veces pegada (sale uno y entra otro al día siguiente), a veces con días libres.
        v_x := random();
        v_gap := case when v_x < 0.35 or (v_end between v_today - 12 and v_today + 6 and v_x < 0.85) then 0 when v_x < 0.7 then 1 + floor(random() * 2)::int else 3 + floor(random() * 5)::int end;
        v_d := v_end + 1 + v_gap;
      else
        v_d := v_d + 1;
      end if;
    end loop;
  end loop;

  -- ── Temporada pasada (para «Comparar temporadas» y los informes de meses anteriores) ──
  for v_sp in select id, kind from public.spaces where workspace_id = p_ws and active order by random() loop
    v_d := v_ps + floor(random() * 10)::int;
    loop
      exit when v_d > v_pe;
      -- Enero y la primera quincena de febrero, casi llenos; diciembre y marzo, flojos.
      v_p := case when extract(month from v_d) = 1 or (extract(month from v_d) = 2 and extract(day from v_d) <= 15) then 0.8
                  when extract(month from v_d) = 2 then 0.45 when extract(month from v_d) in (10, 11) then 0.08 else 0.22 end;
      if random() > v_p then v_d := v_d + 1 + floor(random() * 6)::int; continue; end if;
      -- En plena temporada la mayoría alquila por quincena o por mes.
      v_len := (array[7,10,15,15,15,15,30,30])[1 + floor(random() * 8)::int];
      v_end := least(v_pe, v_d + v_len - 1);
      v_cid := v_custs[1 + floor(power(random(), 1.25) * v_n_cust)::int];
      v_x := random();
      v_opts := case when v_x < 0.1 then jsonb_build_object('agreement_id', v_ag10) when v_x < 0.15 then jsonb_build_object('agreement_id', v_ag15)
                     when v_x < 0.45 then jsonb_build_object('cash', true) else '{}'::jsonb end;
      v_rid := null;
      begin
        v_res := public.create_reservation_v2(p_ws, gen_random_uuid(), v_cid, v_d, v_end,
          jsonb_build_array(jsonb_build_object('space_id', v_sp.id, 'start_date', v_d, 'end_date', v_end)), v_opts, null, null);
        v_rid := (v_res ->> 'reservation_id')::uuid;
      exception when others then v_rid := null;
      end;
      if v_rid is not null then
        v_book := greatest(v_ps, v_d - floor(random() * 15)::int);
        update public.reservations set created_at = (v_book::timestamp + interval '10 hours' + floor(random() * 480) * interval '1 minute') at time zone v_tz,
               version = version + 1 where id = v_rid;
        select total_amount into v_total from public.reservations where id = v_rid;
        v_plan2 := v_plan2 || jsonb_build_object('r', v_rid, 'a', v_total, 'm', case when v_opts ? 'cash' then 'efectivo' else v_methods[1 + floor(random() * 5)::int] end,
          'd', v_book, 't', (v_book::timestamp + interval '11 hours' + floor(random() * 420) * interval '1 minute') at time zone v_tz);
        v_d := v_end + 1 + (case when random() < 0.5 then 0 else floor(random() * 4)::int end);
      else
        v_d := v_d + 1;
      end if;
    end loop;
  end loop;
  -- Cajas día por día: apertura, cobros, algún gasto y cierre (cuadra justo, salvo algún día).
  for v_d in select generate_series(v_ps, v_pe, interval '1 day')::date loop
    insert into public.cash_sessions (workspace_id, business_date, opening_cash, opened_at)
    values (p_ws, v_d, 40000, (v_d::timestamp + interval '8 hours 45 minutes') at time zone v_tz)
    returning id into v_sess;
    for v_r in select * from jsonb_to_recordset(v_plan2) as x(r uuid, a numeric, m text, d date, t timestamptz) where x.d = v_d order by x.t loop
      perform private.demo_pay(p_ws, v_r.r, v_r.a, v_r.m, v_d, v_r.t);
    end loop;
    if random() < 0.6 then
      perform private.demo_expense(p_ws, v_d, (v_d::timestamp + interval '12 hours') at time zone v_tz, e.a::numeric, e.c, e.k, e.m, e.s)
      from (select * from (values
        (round((8000 + random() * 9000) / 100) * 100, 'Hielo para el parador', 'Proveedores e insumos', 'efectivo', 'Hielos del Sur'),
        (round((30000 + random() * 30000) / 100) * 100, 'Bebidas para el parador', 'Proveedores e insumos', 'transferencia', 'Distribuidora Costa Atlántica'),
        (round((6000 + random() * 6000) / 100) * 100, 'Artículos de limpieza', 'Limpieza', 'efectivo', 'Limpieza Total'),
        (round((15000 + random() * 20000) / 100) * 100, 'Arreglo de carpa', 'Reparaciones', 'efectivo', 'Herrería Gómez'),
        (round((20000 + random() * 15000) / 100) * 100, 'Lona para carpa', 'Mantenimiento', 'transferencia', 'Lonas del Mar'),
        (round((5000 + random() * 8000) / 100) * 100, 'Herramientas varias', 'Materiales y herramientas', 'efectivo', 'Ferretería El Tornillo'),
        (round((12000 + random() * 10000) / 100) * 100, 'Combustible del cuatriciclo', 'Otros gastos', 'tarjeta', 'YPF Ruta 11')
      ) t(a, c, k, m, s) order by random() limit 1) e;
    end if;
    select 40000 + coalesce(sum(amount) filter (where direction = 'entrada' and method = 'efectivo'), 0)
                 - coalesce(sum(amount) filter (where direction = 'salida' and method = 'efectivo'), 0)
      into v_exp from public.cash_movements where cash_session_id = v_sess;
    v_diff := case when random() < 0.9 or v_exp < 1000 then 0 else -500 end;
    update public.cash_sessions
       set closed_at = (v_d::timestamp + interval '20 hours 10 minutes') at time zone v_tz,
           counted_cash = v_exp + v_diff, expected_cash = v_exp, difference = v_diff,
           close_notes = case when v_diff < 0 then 'Faltó cambio chico' end, version = version + 1
     where id = v_sess;
  end loop;

  -- Números de reserva en el orden en que se reservaron (como en un balneario real).
  update public.reservations set number = number + 1000000, version = version + 1 where workspace_id = p_ws;
  update public.reservations r set number = m.n, version = r.version + 1
    from (select id, row_number() over (order by created_at, id) as n from public.reservations where workspace_id = p_ws) m
   where m.id = r.id;
  perform set_config('app.restore_ws', '', true);

  -- ── Cambios de carpa ─────────────────────────────────────────────
  -- Por viento: el resto de la estadía en otra carpa libre.
  v_cnt := 0;
  for v_r in
    select r.id, r.version, r.end_date, g.space_id, sp.kind from public.reservations r
      join public.reservation_segments g on g.reservation_id = r.id and g.active
      join public.spaces sp on sp.id = g.space_id
     where r.workspace_id = p_ws and r.status = 'confirmada' and r.start_date < v_today and r.end_date > v_today + 2
     order by random() limit 12
  loop
    select s.id into v_target from public.spaces s where s.workspace_id = p_ws and s.active and s.kind = v_r.kind and s.id <> v_r.space_id
      and not exists (select 1 from public.reservation_segments g where g.space_id = s.id and g.active and g.start_date <= v_r.end_date and g.end_date >= v_today)
      order by random() limit 1;
    continue when v_target is null;
    begin
      perform public.relocate_reservation(v_r.id, v_target, v_today, v_r.end_date, v_r.version,
        (array['Mucho viento del sur: pidió una carpa más resguardada', 'Viento fuerte: se pasó cerca del parador', 'Prefiere estar más cerca del mar'])[1 + v_cnt % 3]);
      v_cnt := v_cnt + 1;
    exception when others then null;
    end;
    exit when v_cnt >= 4;
  end loop;
  -- Por un solo día (mañana), y vuelve a su carpa.
  v_cnt := 0;
  for v_r in
    select r.id, r.version, g.space_id, sp.kind from public.reservations r
      join public.reservation_segments g on g.reservation_id = r.id and g.active and g.start_date <= v_today + 1 and g.end_date >= v_today + 2
      join public.spaces sp on sp.id = g.space_id
     where r.workspace_id = p_ws and r.status = 'confirmada' and r.start_date <= v_today
     order by random() limit 12
  loop
    select s.id into v_target from public.spaces s where s.workspace_id = p_ws and s.active and s.kind = v_r.kind and s.id <> v_r.space_id
      and not exists (select 1 from public.reservation_segments g where g.space_id = s.id and g.active and g.start_date <= v_today + 1 and g.end_date >= v_today + 1)
      order by random() limit 1;
    continue when v_target is null;
    begin
      perform public.relocate_reservation(v_r.id, v_target, v_today + 1, v_today + 1, v_r.version,
        (array['Mañana viene con amigos: pidió una carpa más grande por el día', 'Por un día, al lado de la familia', 'Mañana quiere sol de mañana'])[1 + v_cnt % 3]);
      v_cnt := v_cnt + 1;
    exception when others then null;
    end;
    exit when v_cnt >= 3;
  end loop;

  -- ── Mantenimiento ────────────────────────────────────────────────
  v_cnt := 0;
  for v_sp in select s.id from public.spaces s where s.workspace_id = p_ws and s.active and s.kind = 'carpa'
                and not exists (select 1 from public.reservation_segments g where g.space_id = s.id and g.active and g.start_date <= v_today + 4 and g.end_date >= v_today + 2)
              order by random() limit 2 loop
    insert into public.maintenance_blocks (workspace_id, space_id, start_date, end_date, reason, notes)
    values (p_ws, v_sp.id, v_today + 2, v_today + 4, (array['Cambio de lona', 'Arreglo de la estructura'])[1 + v_cnt], 'Lo hace Herrería Gómez');
    v_cnt := v_cnt + 1;
  end loop;

  -- ── Días pasados: caja abierta, cobros, gastos y cierre (la mayoría sin diferencia) ──
  for v_i in reverse v_hist..1 loop
    v_d := v_today - v_i;
    insert into public.cash_sessions (workspace_id, business_date, opening_cash, opening_notes, opened_at)
    values (p_ws, v_d, 50000, case when v_i = v_hist then 'Primer día de la temporada' end,
            (v_d::timestamp + interval '8 hours 40 minutes') at time zone v_tz)
    returning id into v_sess;
    for v_r in select * from jsonb_to_recordset(v_plan) as x(r uuid, a numeric, m text, d date, t timestamptz, n text) where x.d = v_d order by x.t loop
      perform private.demo_pay(p_ws, v_r.r, v_r.a, v_r.m, v_d, v_r.t + floor(random() * 80) * interval '1 minute');
    end loop;
    for v_j in 1..(1 + floor(random() * 3.5)::int) loop
      v_x := random();
      perform private.demo_expense(p_ws, v_d, (v_d::timestamp + interval '9 hours' + floor(random() * 540) * interval '1 minute') at time zone v_tz,
        e.amount::numeric, e.concept, e.category, e.method, e.supplier)
      from (select * from (values
        (0.12, round((12000 + random() * 14000) / 100) * 100, 'Hielo para el parador', 'Proveedores e insumos', 'efectivo', 'Hielos del Sur'),
        (0.22, round((45000 + random() * 50000) / 100) * 100, 'Bebidas para el parador', 'Proveedores e insumos', 'transferencia', 'Distribuidora Costa Atlántica'),
        (0.30, round((6000 + random() * 6000) / 100) * 100, 'Bolsas de residuos', 'Proveedores e insumos', 'efectivo', null),
        (0.38, round((8000 + random() * 9000) / 100) * 100, 'Lavandina, detergente y trapos', 'Limpieza', 'efectivo', 'Limpieza Total'),
        (0.45, 25000, 'Limpieza de baños (turno tarde)', 'Limpieza', 'efectivo', null),
        (0.52, round((15000 + random() * 25000) / 100) * 100, 'Arreglo de estructura de carpa', 'Reparaciones', 'efectivo', 'Herrería Gómez'),
        (0.57, round((30000 + random() * 30000) / 100) * 100, 'Plomero: pérdida en duchas', 'Reparaciones', 'transferencia', 'Plomería Ruiz'),
        (0.64, round((38000 + random() * 20000) / 100) * 100, 'Lona nueva para carpa', 'Mantenimiento', 'transferencia', 'Lonas del Mar'),
        (0.70, round((12000 + random() * 8000) / 100) * 100, 'Pintura para sombrillas', 'Mantenimiento', 'tarjeta', 'Pinturería Centro'),
        (0.76, round((9000 + random() * 12000) / 100) * 100, 'Sogas, estacas y precintos', 'Materiales y herramientas', 'efectivo', 'Ferretería El Tornillo'),
        (0.81, round((18000 + random() * 15000) / 100) * 100, 'Rastrillo y palas', 'Materiales y herramientas', 'tarjeta', 'Ferretería El Tornillo'),
        (0.88, round((20000 + random() * 15000) / 100) * 100, 'Combustible del cuatriciclo', 'Otros gastos', 'tarjeta', 'YPF Ruta 11'),
        (0.93, 35000, 'Publicidad en radio local', 'Otros gastos', 'transferencia', 'FM Costa'),
        (0.97, 28000, 'Recarga de matafuegos', 'Otros gastos', 'efectivo', 'Seguridad Atlántica'),
        (1.01, round((5000 + random() * 5000) / 100) * 100, 'Viáticos del personal', 'Otros gastos', 'efectivo', null)
      ) t(upto, amount, concept, category, method, supplier) where upto >= v_x order by upto limit 1) e;
    end loop;
    select 50000 + coalesce(sum(amount) filter (where direction = 'entrada' and method = 'efectivo'), 0)
                 - coalesce(sum(amount) filter (where direction = 'salida' and method = 'efectivo'), 0)
      into v_exp from public.cash_movements where cash_session_id = v_sess;
    -- Si junta mucho efectivo, a la tarde se deposita en el banco (y la caja queda con el fondo).
    if v_exp > 400000 and random() < 0.8 then
      v_amt := floor((v_exp - 50000) / 10000) * 10000;
      insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, idempotency_key, created_at)
      values (p_ws, v_sess, 'salida', 'efectivo', v_amt, 'deposito', 'Depósito de efectivo · Banco Provincia', gen_random_uuid(),
              (v_d::timestamp + interval '19 hours 30 minutes') at time zone v_tz);
      v_exp := v_exp - v_amt;
    end if;
    v_x := random();
    v_diff := case when v_x < 0.75 then 0 when v_x < 0.85 then -500 when v_x < 0.92 then 200 when v_x < 0.97 then -1000 else -2500 end;
    if v_exp + v_diff < 0 then v_diff := 0; end if;
    update public.cash_sessions
       set closed_at = (v_d::timestamp + interval '20 hours' + floor(random() * 60) * interval '1 minute') at time zone v_tz,
           counted_cash = v_exp + v_diff, expected_cash = v_exp, difference = v_diff,
           close_notes = case when v_diff < -1500 then 'Faltante: se revisa con el encargado' when v_diff < 0 then 'Faltó cambio chico'
                              when v_diff > 0 then 'Sobró: un cliente no esperó el vuelto' end,
           version = version + 1
     where id = v_sess;
  end loop;

  -- ── Hoy ──────────────────────────────────────────────────────────
  perform public.open_cash_session(p_ws, 50000, 'Apertura de demostración');
  for v_r in select * from jsonb_to_recordset(v_plan) as x(r uuid, a numeric, m text, d date, t timestamptz, n text) where x.d = v_today loop
    perform private.record_payment(p_ws, v_r.r, 'cobro', v_r.a, v_r.m, gen_random_uuid(), v_r.n, null);
  end loop;
  -- Algunos deudores pagan hoy.
  for v_r in
    select r.id, r.total_amount - coalesce((select sum(signed_amount) from public.payments p where p.reservation_id = r.id), 0) as due
      from public.reservations r
     where r.workspace_id = p_ws and r.status = 'confirmada' and r.start_date <= v_today and r.end_date >= v_today and not r.is_courtesy
     order by random()
  loop
    continue when v_r.due <= 0;
    v_cnt := coalesce(v_cnt, 0);
    exit when random() < 0.12;
    perform private.record_payment(p_ws, v_r.id, 'cobro', v_r.due, v_methods[1 + floor(random() * 5)::int], gen_random_uuid(), null, null);
  end loop;

  -- Un cobro cargado mal y anulado (queda registrado), y después el correcto.
  select r.id, r.total_amount - coalesce((select sum(signed_amount) from public.payments p where p.reservation_id = r.id), 0)
    into v_rid, v_amt from public.reservations r
   where r.workspace_id = p_ws and r.status = 'confirmada' and r.start_date > v_today and not r.is_courtesy
     and r.total_amount - coalesce((select sum(signed_amount) from public.payments p where p.reservation_id = r.id), 0) > 10000
   order by random() limit 1;
  if v_rid is not null then
    v_pay := private.record_payment(p_ws, v_rid, 'cobro', 10000, 'tarjeta', gen_random_uuid(), null, null);
    perform public.void_payment(p_ws, v_pay, gen_random_uuid(), 'Se pasó la tarjeta equivocada');
    perform private.record_payment(p_ws, v_rid, 'cobro', 10000, 'transferencia', gen_random_uuid(), 'Seña', null);
  end if;

  -- Una cancelación con devolución de la seña.
  select r.id, r.version, coalesce((select sum(signed_amount) from public.payments p where p.reservation_id = r.id), 0)
    into v_rid, v_ver, v_amt from public.reservations r
   where r.workspace_id = p_ws and r.status = 'confirmada' and r.start_date > v_today + 5
     and coalesce((select sum(signed_amount) from public.payments p where p.reservation_id = r.id), 0) > 0
   order by random() limit 1;
  if v_rid is not null then
    begin
      perform public.refund_payment(p_ws, v_rid, v_amt, 'efectivo', gen_random_uuid(), 'Canceló por un problema familiar');
      select version into v_ver from public.reservations where id = v_rid;
      perform public.cancel_reservation(v_rid, v_ver, 'Canceló por un problema familiar: se devolvió la seña');
    exception when others then null;
    end;
  end if;

  -- Gastos y otros ingresos de hoy (uno anulado por error de carga).
  perform public.register_expense(p_ws, gen_random_uuid(), 18500, v_today, 'Hielo para el parador', (select id from public.expense_categories where workspace_id = p_ws and name = 'Proveedores e insumos'), 'efectivo', 'Hielos del Sur', null);
  perform public.register_expense(p_ws, gen_random_uuid(), 9200, v_today, 'Lavandina y trapos', (select id from public.expense_categories where workspace_id = p_ws and name = 'Limpieza'), 'efectivo', null, null);
  v_res := public.register_expense(p_ws, gen_random_uuid(), 92000, v_today, 'Lona nueva', (select id from public.expense_categories where workspace_id = p_ws and name = 'Mantenimiento'), 'efectivo', 'Lonas del Mar', null);
  begin
    perform public.void_expense(p_ws, (v_res ->> 'expense_id')::uuid, 'Se cargó dos veces');
  exception when others then null;
  end;
  perform public.register_other_income(p_ws, gen_random_uuid(), 8000, 'efectivo', 'Alquiler de tabla de surf por el día');

  insert into public.day_notes (workspace_id, day, text) values
    (p_ws, v_today, 'Esto es una demostración: probá agregar, tildar o quitar notas'),
    (p_ws, v_today, 'Hoy viene el proveedor de hielo'),
    (p_ws, v_today, 'Pronóstico: viento sur por la tarde. Ofrecer carpas cerca del parador'),
    (p_ws, v_today + 1, 'Llamar a la herrería por las carpas en mantenimiento');
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
           then v_opts - 'manual_base' else v_opts end,
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
end $function$;
