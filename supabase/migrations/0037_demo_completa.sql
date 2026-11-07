-- =====================================================================
-- 0037 · Demo mucho más completa (modo invitado).
--   El balneario de demostración se llena con datos inventados que cubren
--   todo lo que el sistema hace: un mes de historia con cajas abiertas y
--   cerradas (con alguna diferencia), cobros en efectivo, transferencia y
--   tarjeta, señas, pagos en cuotas, deudores, gastos de todas las
--   categorías, convenios (10% y 15%), descuento por efectivo, cortesías,
--   extras (reposeras, gazebo…), cambios de carpa por un día y por viento,
--   reservas pegadas una detrás de otra, mantenimiento, una cancelación con
--   devolución y reservas lejanas. Hoy y los próximos días, casi lleno.
--   Solo afecta a los balnearios de demostración (nunca a uno real).
-- =====================================================================

-- Cobro con fecha pasada, en la caja de ese día (solo para armar la demo).
create or replace function private.demo_pay(p_ws uuid, p_res uuid, p_amount numeric, p_method text, p_day date, p_at timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare v_session uuid; v_pid uuid; v_num bigint;
begin
  if not exists (select 1 from public.workspaces where id = p_ws and is_demo) then
    raise exception 'Solo para balnearios de demostración.';
  end if;
  if p_amount is null or p_amount <= 0 then return; end if;
  select id into v_session from public.cash_sessions where workspace_id = p_ws and business_date = p_day;
  if v_session is null then return; end if;
  select number into v_num from public.reservations where id = p_res;
  insert into public.payments (workspace_id, reservation_id, kind, amount, signed_amount, method, cash_session_id, idempotency_key, created_at)
  values (p_ws, p_res, 'cobro', p_amount, p_amount, p_method, v_session, gen_random_uuid(), p_at)
  returning id into v_pid;
  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, payment_id, created_at)
  values (p_ws, v_session, 'entrada', p_method, p_amount, 'cobro', format('Cobro reserva #%s', v_num), v_pid, p_at);
end $$;
revoke all on function private.demo_pay(uuid, uuid, numeric, text, date, timestamptz) from public, anon, authenticated;

-- Gasto con fecha pasada, en la caja de ese día.
create or replace function private.demo_expense(p_ws uuid, p_day date, p_at timestamptz, p_amount numeric, p_concept text,
  p_category text, p_method text, p_supplier text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_session uuid; v_cat uuid; v_id uuid;
begin
  if not exists (select 1 from public.workspaces where id = p_ws and is_demo) then
    raise exception 'Solo para balnearios de demostración.';
  end if;
  select id into v_session from public.cash_sessions where workspace_id = p_ws and business_date = p_day;
  select id into v_cat from public.expense_categories where workspace_id = p_ws and name = p_category;
  if v_session is null or v_cat is null then return; end if;
  insert into public.expenses (workspace_id, cash_session_id, amount, spent_on, concept, category_id, supplier, method, idempotency_key, created_at)
  values (p_ws, v_session, p_amount, p_day, p_concept, v_cat, p_supplier, p_method, gen_random_uuid(), p_at)
  returning id into v_id;
  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, expense_id, created_at)
  values (p_ws, v_session, 'salida', p_method, p_amount, 'gasto', left('Gasto: ' || p_concept, 200), v_id, p_at);
end $$;
revoke all on function private.demo_expense(uuid, date, timestamptz, numeric, text, text, text, text) from public, anon, authenticated;

create or replace function private.seed_demo(p_ws uuid) returns void
language plpgsql security definer set search_path = '' as $$
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
  v_ag10 uuid; v_ag15 uuid; v_agPB uuid; v_ex record; v_exr uuid; v_exs uuid; v_exg uuid; v_exm uuid;
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

  -- Tarifas: desde antes de la historia hasta después de las reservas lejanas
  for v_kind in select unnest(array['carpa','sombrilla']) loop
    for v_m in select generate_series(date_trunc('month', v_today - v_hist - 31), date_trunc('month', v_today + v_far + 31), interval '1 month')::date loop
      for v_half in 1..2 loop
        v_price := case extract(month from v_m) when 1 then 42000 when 2 then 38000 when 12 then 28000 when 3 then 24000 else 18000 end;
        if v_half = 2 and extract(month from v_m) = 12 then v_price := 36000; end if;
        if v_kind = 'sombrilla' then v_price := round(v_price * 0.55 / 500) * 500; end if;
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
  for v_kind in select unnest(array['carpa','sombrilla']) loop
    for v_m in select generate_series(v_ps, v_pe, interval '1 month')::date loop
      for v_half in 1..2 loop
        v_price := case extract(month from v_m) when 1 then 26000 when 2 then 24000 when 12 then 17000 else 15000 end;
        if v_half = 2 and extract(month from v_m) = 12 then v_price := 22000; end if;
        if v_kind = 'sombrilla' then v_price := round(v_price * 0.55 / 500) * 500; end if;
        perform public.set_rate(p_ws, v_kind, extract(year from v_m)::int, extract(month from v_m)::int, v_half::smallint, v_price);
      end loop;
    end loop;
  end loop;

  -- Convenios (el de Parque Bonito ya viene cargado)
  select id into v_agPB from public.agreements where workspace_id = p_ws and name = 'Parque Bonito';
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
  for v_sp in select id, kind, (row_number() over (partition by kind order by random())) <= (case kind when 'carpa' then 5 else 1 end) as libre
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
        when v_x < 0.24 then jsonb_build_object('agreement_id', v_agPB)
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
end $$;
revoke all on function private.seed_demo(uuid) from public, anon, authenticated;

-- El borrado de una demo incluye lo nuevo (extras y su uso en reservas).
create or replace function private.purge_demo_workspace(p_ws uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.workspaces where id = p_ws and is_demo) then
    raise exception 'Solo se pueden borrar balnearios de demostración.';
  end if;
  perform set_config('app.purge_ws', p_ws::text, true);
  delete from public.cash_movements where workspace_id = p_ws;
  delete from public.restaurant_vouchers where workspace_id = p_ws;
  delete from public.payments where workspace_id = p_ws;
  delete from public.expenses where workspace_id = p_ws;
  delete from public.reservation_extras where workspace_id = p_ws;
  delete from public.reservation_discounts where workspace_id = p_ws;
  delete from public.reservation_charges where workspace_id = p_ws;
  delete from public.reservation_segments where workspace_id = p_ws;
  delete from public.reservation_changes where workspace_id = p_ws;
  delete from public.reservations where workspace_id = p_ws;
  delete from public.maintenance_blocks where workspace_id = p_ws;
  delete from public.customers where workspace_id = p_ws;
  delete from public.rates where workspace_id = p_ws;
  delete from public.package_discounts where workspace_id = p_ws;
  delete from public.agreements where workspace_id = p_ws;
  delete from public.extras where workspace_id = p_ws;
  delete from public.expense_categories where workspace_id = p_ws;
  delete from public.cash_sessions where workspace_id = p_ws;
  delete from public.day_notes where workspace_id = p_ws;
  delete from public.backups where workspace_id = p_ws;
  delete from public.map_features where workspace_id = p_ws;
  delete from public.spaces where workspace_id = p_ws;
  delete from public.workspace_members where workspace_id = p_ws;
  delete from public.workspaces where id = p_ws;
  delete from public.audit_log where workspace_id = p_ws;
  perform set_config('app.purge_ws', '', true);
end $$;
revoke all on function private.purge_demo_workspace(uuid) from public, anon, authenticated;
