-- =====================================================================
-- Pruebas de la base de datos (casos normales y excepcionales).
-- Se ejecutan con:  ./tests/run.sh
-- =====================================================================
\set ON_ERROR_STOP 1
set client_min_messages = warning;
\o /dev/null

-- Utilidades de prueba ------------------------------------------------
create schema t;
create table t.results (n serial, name text, ok boolean, detail text);
create table t.ctx (k text primary key, v text);
grant usage on schema t to authenticated, anon, service_role;
grant all on t.results, t.ctx, t.results_n_seq to authenticated, anon, service_role;

create function t.ok(cond boolean, name text, detail text default null) returns void
language plpgsql as $$
begin
  insert into t.results (name, ok, detail) values (name, coalesce(cond, false), detail);
end $$;

-- Ejecuta SQL y verifica que falle con un mensaje que contenga el patrón.
create function t.throws(sql text, pattern text, name text) returns void
language plpgsql as $$
begin
  execute sql;
  insert into t.results (name, ok, detail) values (name, false, 'no falló');
exception when others then
  insert into t.results (name, ok, detail)
  values (name, sqlerrm ilike '%' || pattern || '%', sqlerrm);
end $$;

create function t.set(k text, v text) returns void language sql as $$
  insert into t.ctx values (k, v) on conflict (k) do update set v = excluded.v
$$;
create function t.get(k text) returns text language sql stable as $$ select v from t.ctx where t.ctx.k = $1 $$;
create function t.uid(k text) returns uuid language sql stable as $$ select v::uuid from t.ctx where t.ctx.k = $1 $$;
create function t.space(code text) returns uuid language sql stable as $$
  select id from public.spaces where workspace_id = t.uid('ws') and spaces.code = $1
$$;
grant execute on all functions in schema t to authenticated, anon, service_role;

-- Usuarios
insert into auth.users values
  ('11111111-1111-1111-1111-111111111111', 'duenio@test.com'),
  ('22222222-2222-2222-2222-222222222222', 'extranio@test.com'),
  ('33333333-3333-3333-3333-333333333333', 'operador@test.com');

-- Fechas de prueba: siempre en el futuro respecto de "hoy".
select t.set('d0', ((now() at time zone 'America/Argentina/San_Juan')::date + 60)::text);

-- =====================================================================
-- 1. Alta del balneario
-- =====================================================================
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);

select t.set('ws', public.create_workspace('Balneario de Prueba')::text);
select t.ok((select count(*) from public.spaces where kind = 'carpa') = 79, 'Alta: 79 carpas iniciales (01–79, como el plano)');
select t.ok((select count(*) from public.spaces where kind = 'sombrilla') = 10, 'Alta: 10 sombrillas iniciales (80–89)');
select t.ok((select count(*) from public.expense_categories) = 8, 'Alta: 8 categorías de gasto');
select t.ok((select percent from public.agreements where name = 'Parque Bonito') = 30, 'Alta: convenio Parque Bonito 30%');
select t.ok((select sea_side = 'bottom' and map_width = 3050 from public.workspaces), 'Plano: el mar queda abajo, como en el plano del parador');
select t.ok((select count(*) from public.map_features where label = 'Bar') = 1, 'Plano: se dibuja el parador (Bar)');
select t.ok((select code from public.spaces where kind = 'sombrilla' order by code limit 1) = '80', 'Plano: las sombrillas son 80 a 89');
update public.spaces set x = 5, y = 5, version = version + 1 where code = '17';
select t.ok((public.apply_parador_layout(t.uid('ws')) ->> 'espacios_ubicados')::int = 89, 'Diseño Parador: ubica los 89 espacios del plano');
select t.ok((select x <> 5 from public.spaces where code = '17'), 'Diseño Parador: la carpa 17 vuelve a su lugar');
select t.ok((select count(*) from public.map_features where active and label = 'Bar') = 1, 'Diseño Parador: no duplica el dibujo del plano');
select t.throws($$select public.create_workspace('Otro')$$, 'ya pertenece', 'Alta: no se crea un segundo balneario');

-- =====================================================================
-- 2. Seguridad: extraños y anónimos no ven nada
-- =====================================================================
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","email":"extranio@test.com"}', false);
select t.throws($$select public.create_workspace('Intruso')$$, 'ya fue creado', 'Seguridad: un extraño no puede crear otro balneario');
select t.ok((select count(*) from public.spaces) = 0, 'Seguridad: un extraño no ve espacios');
select t.ok((select count(*) from public.workspaces) = 0, 'Seguridad: un extraño no ve el balneario');
select t.throws(format($$select public.dashboard_summary(%L)$$, t.get('ws')), 'No tenés permiso', 'Seguridad: un extraño no puede consultar el panel');
select t.throws(format($$insert into public.customers (workspace_id, first_name) values (%L, 'X')$$, t.get('ws')),
  'row-level security', 'Seguridad: un extraño no puede crear clientes');
reset role;
set role anon;
select t.throws($$select count(*) from public.customers$$, 'permission denied', 'Seguridad: sin sesión no se accede a clientes');
select t.throws($$select count(*) from public.payments$$, 'permission denied', 'Seguridad: sin sesión no se accede a pagos');
reset role;

-- Operador (rol limitado) para pruebas posteriores
insert into public.workspace_members (workspace_id, user_id, role, email)
values (t.uid('ws'), '33333333-3333-3333-3333-333333333333', 'operador', 'operador@test.com');

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);

select t.throws(format($$insert into public.reservations (workspace_id, customer_id, start_date, end_date, list_amount, total_amount, request_id)
  values (%L, gen_random_uuid(), current_date, current_date, 0, 0, gen_random_uuid())$$, t.get('ws')),
  'permission denied', 'Seguridad: no se escriben reservas por fuera de las funciones validadas');
select t.throws($$update public.payments set amount = 1$$, 'permission denied', 'Seguridad: no se pueden editar pagos');

-- =====================================================================
-- 3. Clientes
-- =====================================================================
insert into public.customers (workspace_id, first_name, last_name, phone)
values (t.uid('ws'), 'Ana', 'Pérez', '264 155-1234'),
       (t.uid('ws'), 'Ana', 'Pérez', null),
       (t.uid('ws'), 'Juan', 'Gómez', '2645001122'),
       (t.uid('ws'), 'Luis', 'Díaz', null),
       (t.uid('ws'), 'Marta', 'Ruiz', null);
select t.ok((select count(*) from public.customers where first_name = 'Ana') = 2, 'Clientes: se permiten nombres repetidos');
select t.ok((select count(*) from public.find_similar_customers(t.uid('ws'), 'ana', 'pérez', null)) = 2,
  'Clientes: advierte posibles duplicados por nombre');
select t.ok((select count(*) from public.find_similar_customers(t.uid('ws'), 'Otro', 'Nombre', '+54 9 264 155 1234')) = 1,
  'Clientes: advierte posibles duplicados por teléfono');
select t.set('ana', (select id::text from public.customers where first_name = 'Ana' and phone is not null));
select t.set('juan', (select id::text from public.customers where first_name = 'Juan'));
select t.set('luis', (select id::text from public.customers where first_name = 'Luis'));
select t.set('marta', (select id::text from public.customers where first_name = 'Marta'));

select t.throws(format($$update public.customers set notes = 'x' where id = %L$$, t.get('ana')),
  'otro dispositivo', 'Concurrencia: editar sin la versión correcta se rechaza');
update public.customers set notes = 'Prefiere sombra', version = version + 1 where id = t.uid('ana');
select t.ok((select version from public.customers where id = t.uid('ana')) = 2, 'Concurrencia: edición con versión correcta funciona');

-- =====================================================================
-- 4. Caja: apertura
-- =====================================================================
select t.throws(format($$select public.register_payment(%L, gen_random_uuid(), 100, 'efectivo', gen_random_uuid())$$, t.get('ws')),
  'no está abierta', 'Caja: no se cobra con la caja sin abrir');
select t.ok((public.open_cash_session(t.uid('ws'), 50000) ->> 'already_open')::boolean = false, 'Caja: apertura con $50.000');
select t.ok((public.open_cash_session(t.uid('ws'), 99999) ->> 'already_open')::boolean = true, 'Caja: no pide otra apertura el mismo día');
select t.set('session', (select id::text from public.cash_sessions));
select t.ok((select opening_cash from public.cash_sessions) = 50000, 'Caja: la segunda apertura no cambia el efectivo inicial');

-- =====================================================================
-- 5. Reservas y disponibilidad parcial
-- =====================================================================
-- Reserva A: C17 desde d0+3 (día 4) por 7 días, seña de $50.000 en efectivo
select t.set('resA', (public.create_reservation(
  t.uid('ws'), gen_random_uuid(), t.uid('ana'), t.get('d0')::date + 3, t.get('d0')::date + 9,
  jsonb_build_array(jsonb_build_object('space_id', t.space('17'), 'start_date', t.get('d0')::date + 3, 'end_date', t.get('d0')::date + 9)),
  '[{"description":"Carpa 7 días","amount":150000}]'::jsonb, '[]'::jsonb, false, null,
  jsonb_build_object('amount', 50000, 'method', 'efectivo', 'idempotency_key', gen_random_uuid())
) ->> 'reservation_id'));
select t.ok((select due_amount from public.reservation_balances where reservation_id = t.uid('resA')) = 100000,
  'Reserva A: total 150.000, seña 50.000 → saldo 100.000');

-- Reserva B: del día 1 al 5 completo en C17 → conflicto
select t.throws(format($$select public.create_reservation(%L, gen_random_uuid(), %L, %L, %L,
  jsonb_build_array(jsonb_build_object('space_id', %L, 'start_date', %L, 'end_date', %L)),
  '[{"amount":100000}]'::jsonb)$$,
  t.get('ws'), t.get('juan'), t.get('d0'), t.get('d0')::date + 4, t.space('17'), t.get('d0'), t.get('d0')::date + 4),
  'Carpa 17 está ocupada', 'Disponibilidad: rechaza C17 completa cuando hay superposición, con detalle');

-- Reserva B partida: C17 días 1-3 y C24 días 4-5 → una sola reserva
select t.set('reqB', gen_random_uuid()::text);
select t.set('resB', (public.create_reservation(
  t.uid('ws'), t.uid('reqB'), t.uid('juan'), t.get('d0')::date, t.get('d0')::date + 4,
  jsonb_build_array(
    jsonb_build_object('space_id', t.space('17'), 'start_date', t.get('d0')::date, 'end_date', t.get('d0')::date + 2),
    jsonb_build_object('space_id', t.space('24'), 'start_date', t.get('d0')::date + 3, 'end_date', t.get('d0')::date + 4)),
  '[{"amount":60000},{"amount":40000}]'::jsonb, '[]'::jsonb, false, null, null
) ->> 'reservation_id'));
select t.ok((select count(*) from public.reservation_segments where reservation_id = t.uid('resB') and active) = 2,
  'Reserva B: una sola reserva con dos tramos (C17 y C24)');
select t.ok((select due_amount from public.reservation_balances where reservation_id = t.uid('resB')) = 100000,
  'Reserva B: "Cobrar después" deja todo el saldo pendiente');
select t.ok((select count(*) from public.payments where reservation_id = t.uid('resB')) = 0,
  'Reserva B: "Cobrar después" no registra un ingreso ficticio');

-- Reintento de la misma operación
select t.ok((public.create_reservation(
  t.uid('ws'), t.uid('reqB'), t.uid('juan'), t.get('d0')::date, t.get('d0')::date + 4,
  '[]'::jsonb, '[]'::jsonb) ->> 'repetida')::boolean,
  'Duplicados: reintentar la misma reserva no crea otra');
select t.ok((select count(*) from public.reservations where customer_id = t.uid('juan')) = 1, 'Duplicados: sigue habiendo una sola reserva B');

-- Tramos con hueco
select t.throws(format($$select public.create_reservation(%L, gen_random_uuid(), %L, %L, %L,
  jsonb_build_array(jsonb_build_object('space_id', %L, 'start_date', %L, 'end_date', %L),
                    jsonb_build_object('space_id', %L, 'start_date', %L, 'end_date', %L)),
  '[{"amount":1}]'::jsonb)$$,
  t.get('ws'), t.get('luis'), t.get('d0')::date + 20, t.get('d0')::date + 25,
  t.space('40'), t.get('d0')::date + 20, t.get('d0')::date + 21,
  t.space('41'), t.get('d0')::date + 23, t.get('d0')::date + 25),
  'días sin asignar', 'Tramos: rechaza huecos dentro de la estadía');

-- Superposición dentro de la misma reserva
select t.throws(format($$select public.create_reservation(%L, gen_random_uuid(), %L, %L, %L,
  jsonb_build_array(jsonb_build_object('space_id', %L, 'start_date', %L, 'end_date', %L),
                    jsonb_build_object('space_id', %L, 'start_date', %L, 'end_date', %L)),
  '[{"amount":1}]'::jsonb)$$,
  t.get('ws'), t.get('luis'), t.get('d0')::date + 20, t.get('d0')::date + 25,
  t.space('40'), t.get('d0')::date + 20, t.get('d0')::date + 23,
  t.space('41'), t.get('d0')::date + 22, t.get('d0')::date + 25),
  'superpon', 'Tramos: rechaza dos carpas el mismo día en una reserva');

-- Disponibilidad por día
select t.ok((select free from public.availability_grid(t.uid('ws'), t.get('d0')::date, t.get('d0')::date + 9, 'carpa')
             where code = '17' and day = t.get('d0')::date + 5) = false, 'Disponibilidad: C17 ocupada el día 6');
select t.ok((select count(*) from public.availability_grid(t.uid('ws'), t.get('d0')::date, t.get('d0')::date + 9, 'carpa')
             where code = '30' and free) = 10, 'Disponibilidad: C30 libre los 10 días');
select t.ok((select state from public.map_day_status(t.uid('ws'), t.get('d0')::date - 1) where code = '17') = 'reservada_futura',
  'Mapa: C17 figura "reservada para fecha futura" el día anterior');
select t.ok((select state from public.map_day_status(t.uid('ws'), t.get('d0')::date + 5) where code = '17') = 'ocupada',
  'Mapa: C17 ocupada el día 6');
select t.ok((select days_remaining from public.map_day_status(t.uid('ws'), t.get('d0')::date + 5) where code = '17') = 4,
  'Mapa: días restantes correctos');

-- =====================================================================
-- 6. Pagos y deudas
-- =====================================================================
select t.set('pkey', gen_random_uuid()::text);
select t.set('p2', (public.register_payment(t.uid('ws'), t.uid('resA'), 30000, 'transferencia', t.uid('pkey')) ->> 'payment_id'));
select t.ok((public.register_payment(t.uid('ws'), t.uid('resA'), 30000, 'transferencia', t.uid('pkey')) ->> 'payment_id') = t.get('p2'),
  'Pagos: reintentar el mismo pago devuelve el mismo registro');
select t.ok((select count(*) from public.payments where reservation_id = t.uid('resA')) = 2, 'Pagos: no se duplicó el pago');
select t.ok((select due_amount from public.reservation_balances where reservation_id = t.uid('resA')) = 70000,
  'Pagos: 150.000 − 50.000 − 30.000 = saldo 70.000');
select t.throws(format($$select public.register_payment(%L, %L, 80000, 'efectivo', gen_random_uuid())$$, t.get('ws'), t.get('resA')),
  'supera el saldo', 'Pagos: no se puede cobrar más que el saldo');
select t.throws(format($$select public.register_payment(%L, %L, 1000, 'cheque', gen_random_uuid())$$, t.get('ws'), t.get('resA')),
  'Medio de pago', 'Pagos: medio de pago inválido');

-- Anulación de pago
select t.set('void', (public.void_payment(t.uid('ws'), t.uid('p2'), gen_random_uuid(), 'Cargado por error') ->> 'payment_id'));
select t.ok((select due_amount from public.reservation_balances where reservation_id = t.uid('resA')) = 100000,
  'Anulación: el saldo vuelve a 100.000');
select t.ok((select count(*) from public.payments where id = t.uid('p2')) = 1, 'Anulación: el pago original no se borra');
select t.throws(format($$select public.void_payment(%L, %L, gen_random_uuid(), 'otra vez')$$, t.get('ws'), t.get('p2')),
  'ya fue anulado', 'Anulación: no se anula dos veces');
select t.throws(format($$select public.void_payment(%L, %L, gen_random_uuid(), '')$$, t.get('ws'), t.get('void')),
  'anulación no se puede anular', 'Anulación: una anulación no se anula');

-- =====================================================================
-- 7. Descuentos, convenios, cortesía
-- =====================================================================
select t.throws(format($$select public.create_reservation(%L, gen_random_uuid(), %L, %L, %L,
  jsonb_build_array(jsonb_build_object('space_id', %L, 'start_date', %L, 'end_date', %L)),
  '[{"amount":10000}]'::jsonb, '[{"kind":"manual","amount":1000}]'::jsonb)$$,
  t.get('ws'), t.get('luis'), t.get('d0')::date + 30, t.get('d0')::date + 30, t.space('50'), t.get('d0')::date + 30, t.get('d0')::date + 30),
  'necesitan un motivo', 'Descuentos: el manual exige motivo');

select t.set('resConv', (public.create_reservation(
  t.uid('ws'), gen_random_uuid(), t.uid('luis'), t.get('d0')::date + 30, t.get('d0')::date + 30,
  jsonb_build_array(jsonb_build_object('space_id', t.space('50'), 'start_date', t.get('d0')::date + 30, 'end_date', t.get('d0')::date + 30)),
  '[{"amount":10000}]'::jsonb,
  jsonb_build_array(jsonb_build_object('kind', 'convenio', 'agreement_id', (select id from public.agreements limit 1), 'amount', 3000))
) ->> 'reservation_id'));
select t.ok((select total_amount from public.reservations where id = t.uid('resConv')) = 7000, 'Convenio: 10.000 − 30% = 7.000');
select t.ok((select label || ' ' || percent from public.reservation_discounts where reservation_id = t.uid('resConv')) = 'Convenio Parque Bonito 30.00',
  'Convenio: queda registrada la foto del convenio aplicado');

update public.agreements set active = false, version = version + 1;
select t.throws(format($$select public.create_reservation(%L, gen_random_uuid(), %L, %L, %L,
  jsonb_build_array(jsonb_build_object('space_id', %L, 'start_date', %L, 'end_date', %L)),
  '[{"amount":10000}]'::jsonb, jsonb_build_array(jsonb_build_object('kind','convenio','agreement_id',%L,'amount',3000)))$$,
  t.get('ws'), t.get('luis'), t.get('d0')::date + 31, t.get('d0')::date + 31, t.space('50'), t.get('d0')::date + 31, t.get('d0')::date + 31,
  (select id from public.agreements limit 1)),
  'no está vigente', 'Convenio: desactivado deja de ofrecerse');
select t.ok((select total_amount from public.reservations where id = t.uid('resConv')) = 7000, 'Convenio: desactivarlo no cambia reservas anteriores');

select t.set('resCort', (public.create_reservation(
  t.uid('ws'), gen_random_uuid(), t.uid('marta'), t.get('d0')::date, t.get('d0')::date + 14,
  jsonb_build_array(jsonb_build_object('space_id', t.space('60'), 'start_date', t.get('d0')::date, 'end_date', t.get('d0')::date + 14)),
  '[{"amount":200000}]'::jsonb, '[]'::jsonb, true
) ->> 'reservation_id'));
select t.ok((select total_amount = 0 and list_amount = 200000 from public.reservations where id = t.uid('resCort')),
  'Cortesía: importe cero, conserva el valor de lista');
select t.ok((select due_amount from public.reservation_balances where reservation_id = t.uid('resCort')) = 0, 'Cortesía: no genera deuda');
select t.ok((select state from public.map_day_status(t.uid('ws'), t.get('d0')::date + 1) where code = '60') = 'cortesia',
  'Cortesía: el espacio figura ocupado por cortesía');
select t.throws(format($$select public.register_payment(%L, %L, 100, 'efectivo', gen_random_uuid())$$, t.get('ws'), t.get('resCort')),
  'supera el saldo', 'Cortesía: no admite cobros');

-- Operador: no anula pagos
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"operador@test.com"}', false);
select t.throws(format($$select public.void_payment(%L, %L, gen_random_uuid(), 'x')$$, t.get('ws'), t.get('p2')),
  'No tenés permiso', 'Permisos: un operador no anula pagos');
select t.throws(format($$select public.create_reservation(%L, gen_random_uuid(), %L, '2027-06-01', '2027-06-01',
  jsonb_build_array(jsonb_build_object('space_id', %L, 'start_date', '2027-06-01', 'end_date', '2027-06-01')), '[{"amount":1}]'::jsonb)$$,
  t.get('ws'), t.get('luis'), t.space('50')),
  'No tenés permiso', 'Permisos: un operador no carga importes a mano (usa el cálculo de tarifas)');

-- =====================================================================
-- 7b. Tarifario y cálculo de precio en la base
-- =====================================================================
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);
select public.set_rate(t.uid('ws'), 'carpa', 2027, 1, 1::smallint, 10000);
select public.set_rate(t.uid('ws'), 'carpa', 2027, 1, 2::smallint, 12000);
select public.set_rate(t.uid('ws'), 'carpa', 2027, 2, 1::smallint, 11000);
select public.set_rate(t.uid('ws'), 'sombrilla', 2027, 1, 1::smallint, 6000);
select t.ok((select season from public.rates where year = 2027 and month = 1 limit 1) = '2026/2027', 'Tarifas: enero 2027 pertenece a la temporada 2026/2027');
select t.throws(format($$select public.set_rate(%L, 'carpa', 2027, 1, 1::smallint, 9000, 99)$$, t.get('ws')),
  'otro dispositivo', 'Tarifas: no se pisa un precio editado desde otro dispositivo');

select t.set('seg70', jsonb_build_array(jsonb_build_object('space_id', t.space('70'), 'start_date', '2027-01-13', 'end_date', '2027-01-17'))::text);
select t.set('q1', public.quote_reservation(t.uid('ws'), '2027-01-13', '2027-01-17', t.get('seg70')::jsonb)::text);
select t.ok((t.get('q1')::jsonb ->> 'precio_base')::numeric = 54000,
  'Precio: 13 al 17/01 cruza quincenas → 3 × 10.000 + 2 × 12.000 = 54.000');
select t.ok(jsonb_array_length(t.get('q1')::jsonb -> 'charges') = 2, 'Precio: un renglón por quincena');
select t.ok((t.get('q1')::jsonb ->> 'total')::numeric = 51300, 'Paquete: 5 días → 5% (54.000 − 2.700 = 51.300)');

insert into public.agreements (workspace_id, name, percent, valid_from, valid_to) values (t.uid('ws'), 'Hotel Prueba', 30, '2027-01-01', '2027-02-28');
select t.set('hotel', (select id::text from public.agreements where name = 'Hotel Prueba'));
select t.set('q2', public.quote_reservation(t.uid('ws'), '2027-01-13', '2027-01-17', t.get('seg70')::jsonb,
  jsonb_build_object('agreement_id', t.get('hotel'), 'cash', true, 'manual', jsonb_build_object('type','monto','value',1000,'reason','Cliente de años')))::text);
select t.ok((t.get('q2')::jsonb ->> 'total')::numeric = 31319,
  'Cascada: 54.000 → paquete 51.300 → convenio 30% 35.910 → efectivo 10% 32.319 → manual −1.000 = 31.319');
select t.ok((select string_agg(d ->> 'kind', '>') from jsonb_array_elements(t.get('q2')::jsonb -> 'discounts') d) = 'paquete>convenio>efectivo>manual',
  'Cascada: orden paquete → convenio → efectivo → manual');
select t.throws(format($$select public.quote_reservation(%L, '2027-03-02', '2027-03-03', %L::jsonb, jsonb_build_object('agreement_id', %L))$$,
  t.get('ws'), jsonb_build_array(jsonb_build_object('space_id', t.space('70'), 'start_date', '2027-03-02', 'end_date', '2027-03-03')), t.get('hotel')),
  'no está vigente', 'Convenio: fuera de sus fechas de vigencia no se aplica');
select t.ok((public.quote_reservation(t.uid('ws'), '2027-01-10', '2027-01-19',
  jsonb_build_array(jsonb_build_object('space_id', t.space('70'), 'start_date', '2027-01-10', 'end_date', '2027-01-19'))) -> 'discounts' -> 0 ->> 'percent')::numeric = 8,
  'Paquete: 10 días toma el escalón de 7 días (8%)');
select t.ok((public.quote_reservation(t.uid('ws'), '2027-03-01', '2027-03-02',
  jsonb_build_array(jsonb_build_object('space_id', t.space('70'), 'start_date', '2027-03-01', 'end_date', '2027-03-02'))) ->> 'ok')::boolean = false,
  'Precio: avisa cuando falta la tarifa de una quincena');

-- Alta con precio calculado en la base, pago en Mercado Pago
select t.set('resP', (public.create_reservation_v2(t.uid('ws'), gen_random_uuid(), t.uid('luis'), '2027-01-13', '2027-01-17',
  t.get('seg70')::jsonb, jsonb_build_object('agreement_id', t.get('hotel'), 'cash', true),
  null, jsonb_build_object('amount', 10000, 'method', 'mercado_pago', 'idempotency_key', gen_random_uuid())) ->> 'reservation_id'));
select t.ok((select total_amount from public.reservations where id = t.uid('resP')) = 32319, 'Alta: el total lo calcula la base (32.319)');
select t.ok((select count(*) from public.reservation_discounts where reservation_id = t.uid('resP')) = 3, 'Alta: quedan registrados los 3 descuentos aplicados');
select t.ok((select due_amount from public.reservation_balances where reservation_id = t.uid('resP')) = 22319, 'Alta: seña por Mercado Pago, saldo 22.319');
select public.set_rate(t.uid('ws'), 'carpa', 2027, 1, 1::smallint, 99999, (select version from public.rates where space_kind = 'carpa' and year = 2027 and month = 1 and half = 1));
select t.ok((select total_amount from public.reservations where id = t.uid('resP')) = 32319, 'Fotografía: cambiar la tarifa no altera reservas ya hechas');
select t.throws(format($$select public.create_reservation_v2(%L, gen_random_uuid(), %L, '2027-03-01', '2027-03-02', %L::jsonb)$$,
  t.get('ws'), t.get('luis'), jsonb_build_array(jsonb_build_object('space_id', t.space('71'), 'start_date', '2027-03-01', 'end_date', '2027-03-02'))),
  'Faltan tarifas', 'Alta: sin tarifa cargada no se reserva (salvo precio manual)');
select t.ok((public.create_reservation_v2(t.uid('ws'), gen_random_uuid(), t.uid('luis'), '2027-03-01', '2027-03-02',
  jsonb_build_array(jsonb_build_object('space_id', t.space('71'), 'start_date', '2027-03-01', 'end_date', '2027-03-02')),
  '{"manual_base": 25000}'::jsonb) ->> 'reservation_id') is not null, 'Alta: el administrador puede fijar un precio manual');
select t.throws(format($$select public.create_reservation_v2(%L, gen_random_uuid(), %L, '2027-01-20', '2027-01-21', %L::jsonb, '{"courtesy": true}'::jsonb)$$,
  t.get('ws'), t.get('marta'), jsonb_build_array(jsonb_build_object('space_id', t.space('72'), 'start_date', '2027-01-20', 'end_date', '2027-01-21'))),
  'beneficiario', 'Cortesía: pide el familiar beneficiario');

-- Copias de tarifas
select t.ok((public.copy_rates(t.uid('ws'), 2027, 1, null, 2027, 12, null, 10) ->> 'copiados')::int = 3, 'Copiar mes: enero → diciembre (3 precios)');
select t.ok((select daily_price from public.rates where year = 2027 and month = 12 and half = 2 and space_kind = 'carpa') = 13200, 'Copiar con ajuste: 12.000 + 10% = 13.200');
select t.ok((public.copy_rates(t.uid('ws'), 2027, 1, null, 2027, 12, null, 10) ->> 'omitidos')::int = 3, 'Copiar: no pisa precios existentes salvo que se pida');
select t.ok((public.copy_season(t.uid('ws'), '2026/2027', '2027/2028', 0) ->> 'copiados')::int = 4, 'Copiar temporada 2026/2027 → 2027/2028');

-- Operador: no edita tarifas ni aplica descuentos manuales
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"operador@test.com"}', false);
select t.throws(format($$select public.set_rate(%L, 'carpa', 2027, 2, 2::smallint, 1)$$, t.get('ws')), 'No tenés permiso', 'Permisos: un operador no cambia tarifas');
select t.throws(format($$select public.create_reservation_v2(%L, gen_random_uuid(), %L, '2027-01-22', '2027-01-22', %L::jsonb,
  '{"manual": {"type": "monto", "value": 500, "reason": "amigo"}}'::jsonb)$$,
  t.get('ws'), t.get('luis'), jsonb_build_array(jsonb_build_object('space_id', t.space('73'), 'start_date', '2027-01-22', 'end_date', '2027-01-22'))),
  'Solo un administrador', 'Permisos: un operador no aplica descuentos manuales');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);

-- =====================================================================
-- 8. Cambios de carpa durante la estadía
-- =====================================================================
-- Reserva C: C12 por 15 días (días 1 a 15 = d0+40 .. d0+54)
select t.set('c1', (t.get('d0')::date + 40)::text);
select t.set('resC', (public.create_reservation(
  t.uid('ws'), gen_random_uuid(), t.uid('luis'), t.get('c1')::date, t.get('c1')::date + 14,
  jsonb_build_array(jsonb_build_object('space_id', t.space('12'), 'start_date', t.get('c1')::date, 'end_date', t.get('c1')::date + 14)),
  '[{"amount":300000}]'::jsonb, '[]'::jsonb, false, null,
  jsonb_build_object('amount', 300000, 'method', 'tarjeta', 'idempotency_key', gen_random_uuid())
) ->> 'reservation_id'));

select t.throws(format($$select public.relocate_reservation(%L, %L, %L, %L, 99)$$, t.get('resC'), t.space('20'), t.get('c1')::date + 2, t.get('c1')::date + 2),
  'otro dispositivo', 'Cambio de carpa: versión desactualizada se rechaza');

-- Cambio por un solo día (día 3) a la 20
select t.set('nres', (select count(*) from public.reservations)::text);
select t.set('chg1', (public.relocate_reservation(t.uid('resC'), t.space('20'), t.get('c1')::date + 2, t.get('c1')::date + 2,
  (select version from public.reservations where id = t.uid('resC'))) ->> 'change_id'));
select t.ok((select string_agg(sp.code || ':' || (s.start_date - t.get('c1')::date + 1) || '-' || (s.end_date - t.get('c1')::date + 1), ',' order by s.start_date)
             from public.reservation_segments s join public.spaces sp on sp.id = s.space_id
             where s.reservation_id = t.uid('resC') and s.active) = '12:1-2,20:3-3,12:4-15',
  'Cambio por un día: C12 días 1-2, C20 día 3, vuelve a C12 desde el día 4');
select t.ok((select state from public.map_day_status(t.uid('ws'), t.get('c1')::date + 2) where code = '12') <> 'ocupada',
  'Cambio por un día: C12 queda libre ese día');
select t.ok((select count(*) from public.reservations)::text = t.get('nres'),
  'Cambio por un día: no se crea otra reserva');
select t.ok((select paid_amount from public.reservation_balances where reservation_id = t.uid('resC')) = 300000,
  'Cambio de carpa: los pagos se conservan');

-- Cambio por el resto de la estadía (desde el día 10) a C21
select t.set('chg2', (public.relocate_reservation(t.uid('resC'), t.space('21'), t.get('c1')::date + 9, t.get('c1')::date + 14,
  (select version from public.reservations where id = t.uid('resC'))) ->> 'change_id'));
select t.ok((select string_agg(sp.code || ':' || (s.start_date - t.get('c1')::date + 1) || '-' || (s.end_date - t.get('c1')::date + 1), ',' order by s.start_date)
             from public.reservation_segments s join public.spaces sp on sp.id = s.space_id
             where s.reservation_id = t.uid('resC') and s.active) = '12:1-2,20:3-3,12:4-9,21:10-15',
  'Cambio por el resto: pasa a C21 desde el día 10');

-- Destino ocupado
select t.throws(format($$select public.relocate_reservation(%L, %L, %L, %L, %s)$$, t.get('resC'), t.space('17'),
  t.get('d0')::date + 5, t.get('d0')::date + 5, (select version from public.reservations where id = t.uid('resC'))),
  'dentro de la estadía', 'Cambio de carpa: fechas fuera de la estadía se rechazan');

-- =====================================================================
-- 9. Historial: deshacer y revertir
-- =====================================================================
select t.ok((public.last_reversible_change(t.uid('ws')) ->> 'change_id') = t.get('chg2'), 'Deshacer: identifica el último cambio');
select t.throws(format($$select public.revert_change(%L)$$, t.get('chg1')), 'cambios posteriores',
  'Revertir: bloquea revertir un cambio viejo si hay cambios posteriores encima');
select public.revert_change(t.uid('chg2'), 'Prueba');
select public.revert_change(t.uid('chg1'), 'Prueba');
select t.ok((select string_agg(sp.code || ':' || (s.start_date - t.get('c1')::date + 1) || '-' || (s.end_date - t.get('c1')::date + 1), ',' order by s.start_date)
             from public.reservation_segments s join public.spaces sp on sp.id = s.space_id
             where s.reservation_id = t.uid('resC') and s.active) = '12:1-15',
  'Revertir: tras revertir ambos cambios vuelve a C12 días 1-15');
select t.ok((select count(*) from public.reservation_changes where reservation_id = t.uid('resC')) = 5,
  'Revertir: los cambios originales no se borran (5 eventos)');
select t.throws(format($$select public.revert_change(%L)$$, t.get('chg2')), 'ya fue revertido', 'Revertir: no se revierte dos veces');

-- Reversión con conflicto: muevo el día 5 a C30, otro cliente toma C12 ese día, intento revertir
select t.set('chg3', (public.relocate_reservation(t.uid('resC'), t.space('30'), t.get('c1')::date + 4, t.get('c1')::date + 4,
  (select version from public.reservations where id = t.uid('resC'))) ->> 'change_id'));
select public.create_reservation(t.uid('ws'), gen_random_uuid(), t.uid('juan'), t.get('c1')::date + 4, t.get('c1')::date + 4,
  jsonb_build_array(jsonb_build_object('space_id', t.space('12'), 'start_date', t.get('c1')::date + 4, 'end_date', t.get('c1')::date + 4)),
  '[{"amount":20000}]'::jsonb);
select t.throws(format($$select public.revert_change(%L)$$, t.get('chg3')), 'Carpa 12 está ocupada',
  'Revertir: bloquea la reversión si la carpa fue tomada por otra reserva, y explica por qué');

-- =====================================================================
-- 10. Mantenimiento
-- =====================================================================
select t.throws(format($$insert into public.maintenance_blocks (workspace_id, space_id, start_date, end_date, reason)
  values (%L, %L, %L, %L, 'Lona rota')$$, t.get('ws'), t.space('17'), t.get('d0')::date + 5, t.get('d0')::date + 6),
  'choca con: reserva', 'Mantenimiento: advierte conflicto con una reserva existente');
insert into public.maintenance_blocks (workspace_id, space_id, start_date, end_date, reason)
values (t.uid('ws'), t.space('80'), t.get('d0')::date, t.get('d0')::date + 5, 'Cambio de lona');
select t.throws(format($$select public.create_reservation(%L, gen_random_uuid(), %L, %L, %L,
  jsonb_build_array(jsonb_build_object('space_id', %L, 'start_date', %L, 'end_date', %L)), '[{"amount":1}]'::jsonb)$$,
  t.get('ws'), t.get('luis'), t.get('d0')::date + 3, t.get('d0')::date + 3, t.space('80'), t.get('d0')::date + 3, t.get('d0')::date + 3),
  'mantenimiento', 'Mantenimiento: no se puede reservar durante el bloqueo');
select t.ok((select state from public.map_day_status(t.uid('ws'), t.get('d0')::date + 1) where code = '80') = 'mantenimiento',
  'Mantenimiento: figura en el mapa');

-- =====================================================================
-- 11. Inventario
-- =====================================================================
insert into public.spaces (workspace_id, kind, code, x, y) values (t.uid('ws'), 'carpa', '91', 1800, 400);
select t.ok((select count(*) from public.spaces where kind = 'carpa') = 80, 'Inventario: se agregan carpas');
select t.throws(format($$insert into public.spaces (workspace_id, kind, code) values (%L, 'carpa', ' 17')$$, t.get('ws')),
  'duplicate key', 'Inventario: no se repiten códigos');
select t.throws(format($$update public.spaces set active = false, version = version + 1 where id = %L$$, t.space('17')),
  'tiene reservas pendientes', 'Inventario: no se desactiva una carpa con reservas futuras');
update public.spaces set active = false, version = version + 1 where code = '91';
select t.ok((select state from public.map_day_status(t.uid('ws'), t.get('d0')::date) where code = '91') = 'desactivada', 'Inventario: carpa desactivada');
select t.throws(format($$select public.create_reservation(%L, gen_random_uuid(), %L, %L, %L,
  jsonb_build_array(jsonb_build_object('space_id', %L, 'start_date', %L, 'end_date', %L)), '[{"amount":1}]'::jsonb)$$,
  t.get('ws'), t.get('luis'), t.get('d0')::date + 3, t.get('d0')::date + 3, t.space('91'), t.get('d0')::date + 3, t.get('d0')::date + 3),
  'desactivad', 'Inventario: no se reserva una carpa desactivada');
update public.spaces set x = 5, y = 5, version = version + 1 where code = '01';
select t.ok((select x = 5 and y = 5 from public.spaces where code = '01'), 'Mapa: la posición se guarda');

-- =====================================================================
-- 12. Cancelación
-- =====================================================================
select public.cancel_reservation(t.uid('resA'), (select version from public.reservations where id = t.uid('resA')), 'El cliente desistió');
select t.ok((select state from public.map_day_status(t.uid('ws'), t.get('d0')::date + 5) where code = '17') = 'disponible',
  'Cancelación: libera la carpa');
select t.ok((select count(*) from public.payments where reservation_id = t.uid('resA')) = 3, 'Cancelación: conserva los pagos');
select t.ok((select due_amount = 0 and credit_amount = 50000 from public.reservation_balances where reservation_id = t.uid('resA')),
  'Cancelación: sin deuda y $50.000 a favor del cliente');
select t.set('cancelChg', (select id::text from public.reservation_changes where reservation_id = t.uid('resA') and kind = 'cancelacion'));
select public.create_reservation(t.uid('ws'), gen_random_uuid(), t.uid('luis'), t.get('d0')::date + 5, t.get('d0')::date + 5,
  jsonb_build_array(jsonb_build_object('space_id', t.space('17'), 'start_date', t.get('d0')::date + 5, 'end_date', t.get('d0')::date + 5)),
  '[{"amount":20000}]'::jsonb);
select t.throws(format($$select public.revert_change(%L)$$, t.get('cancelChg')), 'Carpa 17 está ocupada',
  'Cancelación: no se revierte si la carpa ya se volvió a alquilar');

-- =====================================================================
-- 13. Gastos, otros ingresos y cierre de caja
-- =====================================================================
select t.set('gasto', (public.register_expense(t.uid('ws'), gen_random_uuid(), 30000, (now() at time zone 'America/Argentina/San_Juan')::date,
  'Lavandina y bolsas', (select id from public.expense_categories where name = 'Limpieza'), 'efectivo') ->> 'expense_id'));
select public.register_expense(t.uid('ws'), gen_random_uuid(), 12000, (now() at time zone 'America/Argentina/San_Juan')::date,
  'Repuesto', (select id from public.expense_categories where name = 'Reparaciones'), 'transferencia');
select t.throws(format($$select public.register_expense(%L, gen_random_uuid(), 100, %L, 'Futuro', %L, 'efectivo')$$,
  t.get('ws'), t.get('d0'), (select id from public.expense_categories limit 1)),
  'ya pagados', 'Gastos: no se registran gastos futuros');
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"operador@test.com"}', false);
select t.throws(format($$select public.void_expense(%L, %L, 'error')$$, t.get('ws'), t.get('gasto')),
  'No tenés permiso', 'Permisos: un operador no anula gastos');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);

-- Efectivo esperado: 50.000 apertura + 50.000 seña efectivo − 30.000 gasto efectivo = 70.000
-- (transferencias y tarjeta no cuentan como efectivo; la anulación fue de una transferencia)
select t.ok((public.cash_session_summary(t.uid('session')) ->> 'efectivo_esperado')::numeric = 70000,
  'Caja: efectivo esperado = apertura + cobros efectivo − gastos efectivo');
select t.ok(((public.cash_session_summary(t.uid('session')) -> 'por_medio' -> 'tarjeta' ->> 'entradas')::numeric) = 300000,
  'Caja: el cobro con tarjeta figura aparte');

select public.void_expense(t.uid('ws'), t.uid('gasto'), 'Era de otra caja');
select t.ok((public.cash_session_summary(t.uid('session')) ->> 'efectivo_esperado')::numeric = 100000,
  'Gastos: anular un gasto en efectivo lo compensa en caja');
select t.ok((select count(*) from public.expenses where id = t.uid('gasto')) = 1, 'Gastos: el gasto anulado no se borra');

select t.ok((select (x ->> 'difference')::numeric = -500 from public.close_cash_session(t.uid('session'), 99500, 1, 'Faltante menor') x),
  'Cierre: contado 99.500 vs esperado 100.000 → diferencia −500');
select t.throws(format($$select public.register_payment(%L, %L, 1000, 'efectivo', gen_random_uuid())$$, t.get('ws'), t.get('resB')),
  'no está abierta', 'Cierre: con la caja cerrada no se aceptan cobros');
select t.throws(format($$select public.open_cash_session(%L, 0)$$, t.get('ws')), 'abierta y cerrada', 'Cierre: no se reabre la caja del día');
reset role;
select t.throws($$update public.payments set amount = 1$$, 'no se puede modificar', 'Inmutabilidad: ni un administrador de base edita pagos');
select t.throws($$delete from public.cash_movements$$, 'no se puede modificar', 'Inmutabilidad: no se borran movimientos de caja');
set role authenticated;

-- =====================================================================
-- 14. Panel principal
-- =====================================================================
select t.ok((public.dashboard_summary(t.uid('ws')) -> 'espacios' -> 'carpa' ->> 'total_activos')::int = 79,
  'Panel: cuenta carpas activas desde la base (79 tras desactivar la 91)');
select t.ok((public.dashboard_summary(t.uid('ws')) -> 'caja' ->> 'estado') = 'cerrada', 'Panel: estado de caja');
select t.ok((public.dashboard_summary(t.uid('ws')) ->> 'gastos_hoy')::numeric = 12000, 'Panel: gastos del día excluyen los anulados');

-- =====================================================================
-- 15. Configuración, copias de seguridad e informes
-- =====================================================================
update public.workspaces set name = 'Balneario Eólico', subtitle = 'Gestión Costa Atlántica',
  logo_data = 'data:image/png;base64,AAAA', version = version + 1;
select t.ok((select name = 'Balneario Eólico' and logo_data like 'data:image/%' from public.workspaces), 'Configuración: se cambian nombre y logo');
select t.throws($$update public.workspaces set logo_data = 'http://otro.sitio/logo.png', version = version + 1$$, 'check', 'Configuración: el logo debe ser una imagen guardada en la base');
insert into public.user_preferences (user_id, display_name) values ('11111111-1111-1111-1111-111111111111', 'Santi')
  on conflict (user_id) do update set display_name = excluded.display_name;
select t.ok((select display_name from public.user_preferences where user_id = '11111111-1111-1111-1111-111111111111') = 'Santi', 'Perfil: nombre visible del usuario');

select t.set('bk', public.create_backup(t.uid('ws'), 'manual', 'Prueba')::text);
select t.ok((t.get('bk')::jsonb -> 'counts' ->> 'reservations')::int = (select count(*) from public.reservations), 'Copia: incluye todas las reservas');
select t.ok((t.get('bk')::jsonb -> 'counts' ->> 'payments')::int = (select count(*) from public.payments), 'Copia: incluye todos los pagos');
select t.ok((select data ? 'reservation_segments' and data ? 'cash_movements' and data ? 'rates' from public.backups limit 1), 'Copia: incluye tramos, caja y tarifas');
select t.ok((public.create_backup(t.uid('ws'), 'automatica') ->> 'creada')::boolean, 'Copia automática: se crea la primera del día');
select t.ok(not (public.create_backup(t.uid('ws'), 'automatica') ->> 'creada')::boolean, 'Copia automática: no se repite en el mismo día');
select t.throws($$delete from public.backups$$, 'permission denied', 'Copia: no se pueden borrar desde la aplicación');

select t.set('rep', public.report_summary(t.uid('ws'), '2027-01-01', '2027-01-31')::text);
select t.ok((select count(*) from jsonb_array_elements(t.get('rep')::jsonb -> 'ocupacion')) = 31, 'Informe: ocupación día por día');
select t.ok((select (x ->> 'carpas')::int from jsonb_array_elements(t.get('rep')::jsonb -> 'ocupacion') x where x ->> 'dia' = '2027-01-15') >= 1, 'Informe: cuenta las carpas ocupadas');
select t.ok((t.get('rep')::jsonb -> 'contratado' ->> 'total')::numeric > 0, 'Informe: total contratado');
select t.ok(jsonb_array_length(t.get('rep')::jsonb -> 'deudas') = (select count(*) from public.reservation_balances where due_amount > 0), 'Informe: deudas pendientes coinciden con los saldos');
select t.ok(exists (select 1 from jsonb_array_elements(t.get('rep')::jsonb -> 'descuentos') d where d ->> 'tipo' = 'convenio'), 'Informe: descuentos por convenio');
select t.throws(format($$select public.report_summary(%L, '2027-01-01', '2029-01-01')$$, t.get('ws')), 'período válido', 'Informe: período máximo 400 días');

select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"operador@test.com"}', false);
select t.throws(format($$select public.create_backup(%L, 'manual')$$, t.get('ws')), 'No tenés permiso', 'Permisos: un operador no crea copias manuales');
update public.workspaces set name = 'X', version = version + 1;
select t.ok((select name from public.workspaces) = 'Balneario Eólico', 'Permisos: un operador no cambia el nombre del balneario');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);

-- =====================================================================
-- 16. Usuarios para ingresar
-- =====================================================================
select t.ok(public.set_my_username('  Santi ') = 'santi', 'Usuario: se guarda en minúsculas y sin espacios');
select t.throws($$select public.set_my_username('a')$$, 'entre 3 y 30', 'Usuario: mínimo 3 caracteres');
select t.throws($$select public.set_my_username('juan perez')$$, 'entre 3 y 30', 'Usuario: sin espacios');
select t.ok(public.my_username() = 'santi', 'Usuario: se consulta el propio');
select t.throws($$select public.login_email_for('santi')$$, 'permission denied', 'Seguridad: el navegador no puede averiguar el correo de un usuario');
select t.throws($$select count(*) from public.user_logins$$, 'permission denied', 'Seguridad: la tabla de usuarios no se lee desde el navegador');
select t.ok((select count(*) from public.workspace_users(t.uid('ws')) where username = 'santi' and is_me) = 1, 'Usuarios: lista con el usuario de ingreso');
select t.throws(format($$select public.set_member_role(%L, %L, 'propietario')$$, t.get('ws'), '33333333-3333-3333-3333-333333333333'), 'Rol inválido', 'Usuarios: no se puede nombrar otro propietario');
select public.set_member_role(t.uid('ws'), '33333333-3333-3333-3333-333333333333', 'administrador');
select t.ok((select role from public.workspace_members where user_id = '33333333-3333-3333-3333-333333333333') = 'administrador', 'Usuarios: el propietario cambia roles');
select public.set_member_role(t.uid('ws'), '33333333-3333-3333-3333-333333333333', 'operador');
select t.throws(format($$select public.remove_member(%L, %L)$$, t.get('ws'), '11111111-1111-1111-1111-111111111111'), 'No podés quitarte', 'Usuarios: nadie se quita el acceso a sí mismo');
reset role;
insert into auth.users values ('44444444-4444-4444-4444-444444444444', 'maria@usuarios.balneario.invalid');
set role service_role;
select t.ok(public.login_email_for('SANTI') = 'duenio@test.com', 'Servidor: encuentra el correo por usuario (sin importar mayúsculas)');
select t.ok(public.setup_done(), 'Servidor: sabe que el balneario ya fue creado');
select public.register_login('44444444-4444-4444-4444-444444444444', 'Maria', 'maria@usuarios.balneario.invalid', t.uid('ws'), 'operador');
select t.ok((select role from public.workspace_members where user_id = '44444444-4444-4444-4444-444444444444') = 'operador', 'Servidor: crea un usuario con acceso al balneario');
select t.throws($$select public.register_login('44444444-4444-4444-4444-444444444444', 'otra', 'x@y.z')$$, 'duplicate', 'Servidor: una cuenta tiene un solo usuario');
reset role;
set role authenticated;
select t.ok((select email is null from public.workspace_users(t.uid('ws')) where username = 'maria'), 'Usuarios: no se muestra el correo técnico');
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","email":"maria@usuarios.balneario.invalid"}', false);
select t.throws($$select public.set_my_username('santi')$$, 'ya está en uso', 'Usuario: no se repite');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);
select public.remove_member(t.uid('ws'), '44444444-4444-4444-4444-444444444444');
select t.ok(not exists (select 1 from public.workspace_members where user_id = '44444444-4444-4444-4444-444444444444'), 'Usuarios: se quita el acceso');

-- 17. Windguru
update public.workspaces set windguru_params = 's=48572&m=3&lng=es', version = version + 1;
select t.ok((select windguru_params from public.workspaces) = 's=48572&m=3&lng=es', 'Windguru: se guarda el spot');
select t.throws($$update public.workspaces set windguru_params = 's=1&x=<script>', version = version + 1$$, 'check', 'Windguru: no acepta caracteres peligrosos');
select t.throws($$update public.workspaces set windguru_params = 'm=3', version = version + 1$$, 'check', 'Windguru: exige el número de spot');

-- 18. Capas del plano
select t.ok((select layer from public.map_features where active and label = 'Bar') > (select layer from public.map_features where active and label = 'Parador'), 'Capas: el bar queda encima del edificio');
select t.ok((select layer from public.map_features where active and label = 'Parador') > coalesce((select max(layer) from public.map_features where active and kind = 'sector'), -1), 'Capas: el edificio queda encima de los sectores');
insert into public.map_features (workspace_id, kind, label, x, y, width, height) values (t.uid('ws'), 'instalacion', 'Kiosco', 100, 100, 50, 50);
select t.ok((select layer from public.map_features where label = 'Kiosco') > (select max(layer) from public.map_features where active and label = 'Bar'), 'Capas: lo nuevo queda arriba de su tipo');
update public.map_features set layer = -5, version = version + 1 where label = 'Kiosco';
select t.ok((select layer from public.map_features where label = 'Kiosco') = -5, 'Capas: se puede enviar al fondo');

-- 19. Color de carpas
update public.workspaces set tent_color = '#ffffff', version = version + 1;
select t.ok((select tent_color from public.workspaces) = '#ffffff', 'Carpas: se pueden poner blancas');
select t.throws($$update public.workspaces set tent_color = 'red; drop', version = version + 1$$, 'check', 'Carpas: solo acepta colores válidos');
update public.workspaces set tent_color = null, version = version + 1;
select t.ok((select tent_color is null from public.workspaces), 'Carpas: se vuelve a rayas según el estado');

reset role;
\o
-- Resultado ----------------------------------------------------------
\pset format aligned
select n, case when ok then 'OK ' else 'FALLA' end as res, name, case when not ok then detail end as detalle
from t.results order by n;
select count(*) filter (where ok) as aprobadas, count(*) filter (where not ok) as fallidas from t.results;
