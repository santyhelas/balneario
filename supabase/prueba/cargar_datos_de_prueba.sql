-- =====================================================================
--  DATOS DE PRUEBA · Balneario
--  Pegar TODO en Supabase → SQL Editor → Run.
--
--  Carga clientes, reservas, cobros, gastos y un mantenimiento inventados,
--  todos marcados con "(PRUEBA)", usando las mismas reglas que la página
--  (precios, descuentos, que no se superpongan reservas, caja).
--
--  Para borrarlos: pegar el archivo "borrar_datos_de_prueba.sql".
--  Si algo falla, no se carga nada (todo o nada).
-- =====================================================================
do $$
declare
  v_ws uuid;
  v_owner uuid;
  v_today date;
  v_session jsonb;
  v_parque uuid;
  v_custs uuid[] := '{}';
  v_cid uuid;
  v_res_ids uuid[] := '{}';
  v_res_kind text[] := '{}';
  v_i int;
  v_k int;
  v_kind text;
  v_start date;
  v_end date;
  v_len int;
  v_opts jsonb;
  v_pay jsonb;
  v_quote jsonb;
  v_total numeric;
  v_mode text;
  v_space uuid;
  v_segs jsonb;
  v_res jsonb;
  v_rid uuid;
  v_ok boolean;
  v_tries int;
  v_cat uuid;
  v_exp jsonb;
  v_rate jsonb;
  v_year int;
  v_month int;
  v_half int;
  v_price numeric;
  v_ver int;
  v_first text[] := array['Juan','María','Carlos','Laura','Diego','Sofía','Martín','Valentina','Pablo','Lucía',
                          'Federico','Camila','Nicolás','Florencia','Gustavo','Agustina','Hernán','Julieta','Sebastián','Paula',
                          'Ricardo','Carolina','Matías','Natalia','Esteban','Romina','Alejandro','Daniela','Facundo','Mariana'];
  v_last text[]  := array['González','Rodríguez','Fernández','López','Martínez','Pérez','Gómez','Sánchez','Romero','Díaz',
                          'Álvarez','Torres','Ruiz','Ramírez','Flores','Acosta','Benítez','Medina','Herrera','Suárez',
                          'Aguirre','Pereyra','Giménez','Molina','Castro','Ortiz','Silva','Rojas','Núñez','Luna'];
  v_cities text[] := array['Buenos Aires','La Plata','Mar del Plata','Rosario','Córdoba','Bahía Blanca','Tandil','Quilmes'];
  v_lens int[] := array[1, 3, 5, 7, 7, 10, 15, 15, 30];
  v_methods text[] := array['efectivo','transferencia','debito','credito','mercado_pago'];
begin
  -- ¿Qué balneario y qué usuario?
  select id into v_ws from public.workspaces order by created_at limit 1;
  if v_ws is null then raise exception 'Todavía no hay un balneario creado.'; end if;
  select user_id into v_owner from public.workspace_members where workspace_id = v_ws order by (role = 'propietario') desc, created_at limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_today := private.ws_today(v_ws);

  if to_regclass('prueba.marcas') is not null then
    raise exception 'Los datos de prueba ya están cargados. Si querés cargarlos de nuevo, primero pegá "borrar_datos_de_prueba.sql".';
  end if;
  create schema prueba;
  create table prueba.marcas (tabla text not null, id uuid not null);
  revoke all on schema prueba from public;

  -- Caja de hoy (los cobros se registran en la caja del día)
  begin
    v_session := public.open_cash_session(v_ws, 50000, 'Apertura (PRUEBA)');
  exception when others then
    raise exception 'No se pudo abrir la caja de hoy: %  Resolvelo en la página (Caja) y volvé a pegar este archivo.', sqlerrm;
  end;
  if not (v_session ->> 'already_open')::boolean then
    insert into prueba.marcas values ('cash_sessions', (v_session ->> 'session_id')::uuid);
  end if;

  -- Tarifas de octubre a marzo (solo las que falten; no pisa las tuyas)
  for v_kind in select unnest(array['carpa','sombrilla']) loop
    for v_k in 0..11 loop
      v_month := ((9 + v_k / 2) % 12) + 1;           -- 10, 10, 11, 11, 12, 12, 1, 1, 2, 2, 3, 3
      v_year  := case when v_month >= 10 then 2026 else 2027 end;
      v_half  := (v_k % 2) + 1;
      v_price := case v_month when 10 then 15000 when 11 then 18000 when 12 then (case v_half when 1 then 22000 else 30000 end)
                              when 1 then (case v_half when 1 then 42000 else 45000 end)
                              when 2 then (case v_half when 1 then 40000 else 32000 end) else 20000 end;
      if v_kind = 'sombrilla' then v_price := round(v_price * 0.55 / 500) * 500; end if;
      if not exists (select 1 from public.rates where workspace_id = v_ws and space_kind = v_kind and year = v_year and month = v_month and half = v_half) then
        v_rate := public.set_rate(v_ws, v_kind, v_year, v_month, v_half::smallint, v_price);
        insert into prueba.marcas select 'rates', id from public.rates
          where workspace_id = v_ws and space_kind = v_kind and year = v_year and month = v_month and half = v_half;
      end if;
    end loop;
  end loop;

  -- Convenio Parque Bonito (si está activo)
  select id into v_parque from public.agreements where workspace_id = v_ws and active and name ilike '%parque bonito%' limit 1;

  -- 30 clientes
  for v_i in 1..30 loop
    insert into public.customers (workspace_id, first_name, last_name, phone, locality, notes)
    values (v_ws, v_first[v_i], v_last[v_i] || ' (PRUEBA)',
            '11 ' || (4000 + v_i * 37) || '-' || lpad((1000 + v_i * 211 % 9000)::text, 4, '0'),
            v_cities[1 + v_i % array_length(v_cities, 1)],
            case when v_i % 9 = 0 then 'Prefiere carpa cerca del mar' when v_i % 11 = 0 then 'Viene con mascota' end)
    returning id into v_cid;
    v_custs := v_custs || v_cid;
    insert into prueba.marcas values ('customers', v_cid);
  end loop;

  perform setseed(0.42);

  -- 45 reservas
  for v_i in 1..45 loop
    v_kind := case when v_i % 6 = 0 then 'sombrilla' else 'carpa' end;
    -- Las primeras, alrededor de hoy (para ver el panel, las alertas y el mapa con datos)
    case v_i
      when 1 then v_start := v_today - 4; v_end := v_today;          -- termina hoy, con deuda
      when 2 then v_start := v_today;     v_end := v_today + 6;
      when 3 then v_start := v_today;     v_end := v_today + 2;
      when 4 then v_start := v_today - 1; v_end := v_today + 13;
      when 5 then v_start := v_today + 3; v_end := v_today + 9;
      when 6 then v_start := v_today;     v_end := v_today + 4;
      else
        v_len := v_lens[1 + floor(random() * array_length(v_lens, 1))::int];
        v_start := date '2026-12-01' + floor(random() * 85)::int;
        v_end := least(v_start + v_len - 1, date '2027-03-15');
    end case;

    v_mode := case when v_i in (12, 27) then 'cortesia'
                   when v_i = 1 then 'sena'
                   when v_i % 5 = 0 then 'pagada_efectivo'
                   when v_i % 5 = 1 then 'pagada_otro'
                   when v_i % 5 = 2 then 'sena'
                   when v_i % 5 = 3 then 'despues'
                   else 'pagada_otro' end;

    v_opts := '{}'::jsonb;
    if v_mode = 'cortesia' then
      v_opts := jsonb_build_object('courtesy', true, 'courtesy_beneficiary', 'Familiar de prueba');
    else
      if v_mode = 'pagada_efectivo' then v_opts := v_opts || '{"cash": true}'; end if;
      if v_parque is not null and v_i % 7 = 0 then v_opts := v_opts || jsonb_build_object('agreement_id', v_parque); end if;
    end if;

    -- Buscar un espacio libre para toda la estadía
    v_ok := false;
    v_tries := 0;
    for v_space in
      select s.id from public.spaces s
      where s.workspace_id = v_ws and s.active and s.kind = v_kind
        and not exists (select 1 from public.reservation_segments g join public.reservations r on r.id = g.reservation_id
                        where g.space_id = s.id and g.active and r.status <> 'cancelada'
                          and g.start_date <= v_end and g.end_date >= v_start)
        and not exists (select 1 from public.maintenance_blocks m
                        where m.space_id = s.id and m.active and m.start_date <= v_end and m.end_date >= v_start)
      order by random()
    loop
      v_tries := v_tries + 1;
      exit when v_tries > 10;
      v_segs := jsonb_build_array(jsonb_build_object('space_id', v_space, 'start_date', v_start, 'end_date', v_end));
      v_quote := public.quote_reservation(v_ws, v_start, v_end, v_segs, v_opts - 'courtesy' - 'courtesy_beneficiary');
      v_total := coalesce((v_quote ->> 'total')::numeric, 0);
      v_pay := case
        when v_mode in ('cortesia', 'despues') or v_total <= 0 then null
        when v_mode = 'pagada_efectivo' then jsonb_build_object('amount', v_total, 'method', 'efectivo', 'idempotency_key', gen_random_uuid())
        when v_mode = 'pagada_otro' then jsonb_build_object('amount', v_total, 'method', v_methods[2 + v_i % 4], 'idempotency_key', gen_random_uuid())
        else jsonb_build_object('amount', greatest(1000, floor(v_total * 0.3 / 1000) * 1000), 'method', case when v_i % 2 = 0 then 'efectivo' else 'transferencia' end, 'idempotency_key', gen_random_uuid())
      end;
      begin
        v_res := public.create_reservation_v2(v_ws, gen_random_uuid(), v_custs[1 + (v_i * 7) % 30], v_start, v_end, v_segs, v_opts,
                   case when v_i % 8 = 0 then 'Pidió sombra (PRUEBA)' else '(PRUEBA)' end, v_pay);
        v_ok := true;
      exception when others then
        v_ok := false;
      end;
      exit when v_ok;
    end loop;

    if v_ok then
      v_rid := (v_res ->> 'reservation_id')::uuid;
      v_res_ids[v_i] := v_rid;
      v_res_kind[v_i] := v_mode;
      insert into prueba.marcas values ('reservations', v_rid);
    end if;
  end loop;

  -- Segundos pagos en algunas reservas con seña (quedan con saldo menor)
  v_k := 0;
  for v_i in 1..coalesce(array_length(v_res_ids, 1), 0) loop
    if v_res_ids[v_i] is not null and v_res_kind[v_i] = 'sena' and v_i > 1 and v_k < 4 then
      select due_amount into v_total from public.reservation_balances where reservation_id = v_res_ids[v_i];
      if v_total > 2000 then
        perform public.register_payment(v_ws, v_res_ids[v_i], floor(v_total / 2 / 1000) * 1000,
                  case when v_k % 2 = 0 then 'efectivo' else 'transferencia' end, gen_random_uuid(), 'Segundo pago (PRUEBA)');
        v_k := v_k + 1;
      end if;
    end if;
  end loop;

  -- Cambios de carpa: uno por un solo día y otro por el resto de la estadía
  for v_i in 1..2 loop
    v_rid := v_res_ids[case v_i when 1 then 2 else 4 end];
    continue when v_rid is null;
    select start_date, end_date, version into v_start, v_end, v_ver from public.reservations where id = v_rid;
    if v_i = 1 then v_start := v_today + 2; v_end := v_today + 2; else v_start := v_today + 7; end if;
    continue when v_start > v_end;
    for v_space in
      select s.id from public.spaces s
      where s.workspace_id = v_ws and s.active and s.kind = 'carpa'
        and not exists (select 1 from public.reservation_segments g where g.space_id = s.id and g.active
                          and g.start_date <= v_end and g.end_date >= v_start)
      order by s.code desc
    loop
      begin
        perform public.relocate_reservation(v_rid, v_space, v_start, v_end, v_ver,
                  case v_i when 1 then 'Quería estar cerca de amigos solo ese día (PRUEBA)' else 'Pidió más sombra (PRUEBA)' end);
        exit;
      exception when others then
        null;
      end;
    end loop;
  end loop;

  -- Una carpa en mantenimiento en diciembre
  select s.id into v_space from public.spaces s
  where s.workspace_id = v_ws and s.active and s.kind = 'carpa'
    and not exists (select 1 from public.reservation_segments g where g.space_id = s.id and g.active
                      and g.start_date <= date '2026-12-14' and g.end_date >= date '2026-12-10')
  order by s.code limit 1;
  if v_space is not null then
    insert into public.maintenance_blocks (workspace_id, space_id, start_date, end_date, reason, notes)
    values (v_ws, v_space, '2026-12-10', '2026-12-14', 'Cambio de lona (PRUEBA)', 'Dato de prueba')
    returning id into v_rid;
    insert into prueba.marcas values ('maintenance_blocks', v_rid);
  end if;

  -- Gastos del día
  for v_i in 1..5 loop
    select id into v_cat from public.expense_categories
    where workspace_id = v_ws and name = (array['Limpieza','Proveedores e insumos','Reparaciones','Mantenimiento','Otros gastos'])[v_i];
    if v_cat is null then
      select id into v_cat from public.expense_categories where workspace_id = v_ws order by name limit 1;
    end if;
    v_exp := public.register_expense(v_ws, gen_random_uuid(),
              (array[8500, 42000, 15000, 23000, 4800])[v_i], v_today,
              (array['Lavandina y trapos','Agua y hielo para el bar','Arreglo de una lona','Pintura de caminos','Bolsas de residuos'])[v_i] || ' (PRUEBA)',
              v_cat, (array['efectivo','transferencia','efectivo','debito','efectivo'])[v_i],
              case when v_i = 2 then 'Distribuidora La Costa' end, null);
    insert into prueba.marcas values ('expenses', (v_exp ->> 'expense_id')::uuid);
  end loop;

  raise notice 'Listo: % clientes, % reservas, 5 gastos y 1 mantenimiento de prueba.',
    array_length(v_custs, 1), (select count(*) from prueba.marcas where tabla = 'reservations');
end $$;

-- Resumen de lo cargado
select
  (select count(*) from prueba.marcas where tabla = 'customers')    as clientes_de_prueba,
  (select count(*) from prueba.marcas where tabla = 'reservations') as reservas_de_prueba,
  (select count(*) from public.payments p join prueba.marcas m on m.tabla = 'reservations' and m.id = p.reservation_id) as cobros_de_prueba,
  (select count(*) from prueba.marcas where tabla = 'expenses')     as gastos_de_prueba,
  (select count(*) from prueba.marcas where tabla = 'rates')        as tarifas_cargadas;
