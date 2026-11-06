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
-- 1. Alta del balneario (las altas están cerradas: el dueño tiene su correo habilitado)
-- =====================================================================
select private.permitir_alta('duenio@test.com', 'Prueba');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);

select t.set('ws', public.create_workspace('Balneario de Prueba', 79, 10)::text);
select public.apply_parador_layout(t.uid('ws'));
insert into public.agreements (workspace_id, name, percent) values (t.uid('ws'), 'Parque Bonito', 30);
select t.ok((select count(*) from public.spaces where kind = 'carpa') = 79, 'Alta: 79 carpas iniciales (01–79, como el plano)');
select t.ok((select count(*) from public.spaces where kind = 'sombrilla') = 10, 'Alta: 10 sombrillas iniciales (80–89)');
select t.ok((select count(*) from public.expense_categories) = 8, 'Alta: 8 categorías de gasto');
select t.ok((select percent from public.agreements where name = 'Parque Bonito') = 30, 'Convenios: Parque Bonito 30%');
select t.ok((select sea_side = 'bottom' and map_width = 3050 from public.workspaces), 'Plano: el mar queda abajo, como en el plano del parador');
select t.ok((select count(*) from public.map_features where active and label = 'Bar') = 1, 'Plano: se dibuja el parador (Bar)');
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
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","is_anonymous":true}', false);
select t.throws($$select public.create_workspace('Intruso')$$, 'modo invitado', 'Seguridad: un invitado no puede crear un balneario');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","email":"extranio@test.com"}', false);
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

-- Dólares y vouchers del restaurante (no cambian el efectivo en pesos)
select t.set('usd1', (public.register_payment_usd(t.uid('ws'), t.uid('resP'), 10, 1000, gen_random_uuid(), 'Pagó en dólares') ->> 'payment_id'));
select t.ok((select amount = 10000 and usd_amount = 10 and exchange_rate = 1000 from public.payments where id = t.uid('usd1')), 'Dólares: US$ 10 a $1.000 = $10.000');
select t.ok((select due_amount from public.reservation_balances where reservation_id = t.uid('resP')) = 12319, 'Dólares: descuenta el saldo en pesos (22.319 − 10.000)');
select t.ok((public.cash_session_summary(t.uid('session')) -> 'dolares' ->> 'esperado')::numeric = 10, 'Caja: los dólares se cuentan aparte (US$ 10)');
select t.ok((public.cash_session_summary(t.uid('session')) ->> 'efectivo_esperado')::numeric = 70000, 'Caja: los dólares no se suman al efectivo en pesos');
select t.throws(format($$select public.register_payment_usd(%L, %L, 100, 1000, gen_random_uuid())$$, t.get('ws'), t.get('resP')), 'supera el saldo', 'Dólares: no deja cobrar más que el saldo');
select t.throws(format($$select public.register_payment(%L, %L, 1000, 'dolares', gen_random_uuid())$$, t.get('ws'), t.get('resP')), 'monto en dólares', 'Dólares: exige monto en dólares y cotización');
select t.throws(format($$select public.register_payment(%L, %L, 1000, 'voucher', gen_random_uuid())$$, t.get('ws'), t.get('resP')), 'solo se usa para devoluciones', 'Voucher: no sirve para cobrar');
select t.throws(format($$select public.refund_payment(%L, %L, 1000, 'transferencia', gen_random_uuid(), 'Lluvia')$$, t.get('ws'), t.get('resP')), 'efectivo o con un voucher', 'Devolución: solo en efectivo o voucher');
select t.set('vpay', (public.refund_payment(t.uid('ws'), t.uid('resP'), 5000, 'voucher', gen_random_uuid(), 'Día de lluvia') ->> 'payment_id'));
select t.ok((select code ~ '^V-[0-9A-F]{6}$' and amount = 5000 and status = 'vigente' from public.restaurant_vouchers where payment_id = t.uid('vpay')), 'Voucher: se crea con código y queda vigente');
select t.ok((select due_amount from public.reservation_balances where reservation_id = t.uid('resP')) = 17319, 'Voucher: cuenta como devolución (saldo 17.319)');
select t.ok((public.cash_session_summary(t.uid('session')) ->> 'efectivo_esperado')::numeric = 70000, 'Voucher: no toca la caja');
select t.ok(not exists (select 1 from public.cash_movements where payment_id = t.uid('vpay')), 'Voucher: no genera movimiento de caja');
select t.set('vid', (select id::text from public.restaurant_vouchers where payment_id = t.uid('vpay')));
select public.use_voucher(t.uid('vid'), 1);
select t.ok((select status = 'usado' and used_at is not null from public.restaurant_vouchers where id = t.uid('vid')), 'Voucher: se marca como usado');
select t.throws(format($$select public.use_voucher(%L, 2)$$, t.get('vid')), 'ya está usado', 'Voucher: no se usa dos veces');
select t.throws(format($$select public.void_payment(%L, %L, gen_random_uuid(), 'Error')$$, t.get('ws'), t.get('vpay')), 'ya se usó', 'Voucher: usado no se puede anular');
select t.set('vpay2', (public.refund_payment(t.uid('ws'), t.uid('resP'), 1000, 'voucher', gen_random_uuid(), 'Cortesía del bar') ->> 'payment_id'));
select public.void_payment(t.uid('ws'), t.uid('vpay2'), gen_random_uuid(), 'Cargado por error');
select t.ok((select status from public.restaurant_vouchers where payment_id = t.uid('vpay2')) = 'anulado', 'Voucher: al anular la devolución el voucher queda anulado');
select public.void_payment(t.uid('ws'), t.uid('usd1'), gen_random_uuid(), 'Error de cotización');
select t.ok((public.cash_session_summary(t.uid('session')) -> 'dolares' ->> 'esperado')::numeric = 0, 'Dólares: la anulación devuelve los dólares en la caja');
select t.set('resUsd', (public.create_reservation_v2(t.uid('ws'), gen_random_uuid(), t.uid('luis'), '2027-03-05', '2027-03-06',
  jsonb_build_array(jsonb_build_object('space_id', t.space('71'), 'start_date', '2027-03-05', 'end_date', '2027-03-06')),
  '{"manual_base": 25000}'::jsonb, null,
  jsonb_build_object('amount', 20000, 'method', 'dolares', 'usd_amount', 20, 'exchange_rate', 1000, 'idempotency_key', gen_random_uuid())) ->> 'reservation_id'));
select t.ok((select p.usd_amount = 20 and b.due_amount = 5000 from public.payments p join public.reservation_balances b on b.reservation_id = p.reservation_id
             where p.reservation_id = t.uid('resUsd')), 'Nueva reserva: seña de US$ 20 a $1.000, saldo 5.000');
select t.ok(coalesce(current_setting('app.pay_usd', true), '') = '', 'Nueva reserva: no quedan datos de dólares en la sesión');

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

-- 19. Diseño de carpas
update public.workspaces set tent_style = '{"pattern":"liso","fill":"#ffffff","accent":"estado","border":"estado","borderWidth":3,"numberBg":"ninguno","numberText":"#111111","stateDot":false}', version = version + 1;
select t.ok((select tent_style->>'fill' from public.workspaces) = '#ffffff', 'Carpas: se pueden poner blancas con número negro');
select t.throws($$update public.workspaces set tent_style = '{"pattern":"liso","fill":"red;x","accent":"estado","border":"estado","borderWidth":3,"numberBg":"ninguno","numberText":"#111111","stateDot":false}', version = version + 1$$, 'check', 'Carpas: solo acepta colores válidos');
select t.throws($$update public.workspaces set tent_style = '{"pattern":"tigre","fill":"#ffffff","accent":"estado","border":"estado","borderWidth":3,"numberBg":"ninguno","numberText":"#111111","stateDot":false}', version = version + 1$$, 'check', 'Carpas: solo acepta dibujos conocidos');
select t.throws($$update public.workspaces set tent_style = '{"pattern":"liso","fill":"#ffffff","accent":"estado","border":"estado","borderWidth":3,"numberBg":"ninguno","numberText":"#111111","stateDot":false,"x":1}', version = version + 1$$, 'check', 'Carpas: no acepta datos extra');
update public.workspaces set tent_style = null, version = version + 1;
select t.ok((select tent_style is null from public.workspaces), 'Carpas: se vuelve al diseño clásico');

-- 20. Avisos leídos (por usuario)
insert into public.user_preferences (user_id) values ('11111111-1111-1111-1111-111111111111') on conflict (user_id) do nothing;
update public.user_preferences set notices_read = '{"day":"2026-11-02","ids":["caja"]}' where user_id = auth.uid();
select t.ok((select notices_read -> 'ids' ->> 0 from public.user_preferences where user_id = auth.uid()) = 'caja', 'Avisos: se guardan los avisos leídos del usuario');
select t.throws($$update public.user_preferences set notices_read = '[1]' where user_id = auth.uid()$$, 'check', 'Avisos: formato inválido no se acepta');

-- 21. Notas del día
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);
insert into public.day_notes (workspace_id, day, text) values (t.uid('ws'), current_date, 'Viene el proveedor de hielo');
select t.ok((select count(*) from public.day_notes where text like 'Viene%') = 1, 'Notas: se crea una nota del día');
update public.day_notes set done = true, done_at = now(), done_by = auth.uid(), version = version + 1 where text like 'Viene%';
select t.ok((select done from public.day_notes where text like 'Viene%'), 'Notas: se tilda como hecha');
select t.throws($$update public.day_notes set text = 'x', version = 1 where text like 'Viene%'$$, 'otro dispositivo', 'Notas: no se pisa un cambio hecho desde otro dispositivo');
select t.throws($$delete from public.day_notes$$, 'denied', 'Notas: no se borran (se ocultan)');
select t.throws(format($$insert into public.day_notes (workspace_id, day, text) values (%L, current_date, '   ')$$, t.get('ws')), 'check', 'Notas: no se acepta una nota vacía');
select t.ok((select count(*) from public.audit_log where table_name = 'day_notes') >= 2, 'Notas: quedan en el historial');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","email":"extranio@test.com"}', false);
select t.ok((select count(*) from public.day_notes) = 0, 'Notas: un extraño no las ve');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);

-- 22. Modo invitado
reset role;
insert into auth.users (id, email, is_anonymous) values ('55555555-5555-5555-5555-555555555555', null, true);
select t.set('real_payments', (select count(*)::text from public.payments where workspace_id = t.uid('ws')));
select t.set('real_res', (select count(*)::text from public.reservations where workspace_id = t.uid('ws')));
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);
select t.throws($$select public.start_guest_session()$$, 'solo para entrar como invitado', 'Invitado: un usuario común no puede crear una demostración');
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","is_anonymous":true,"role":"authenticated"}', false);
select t.set('demo', public.start_guest_session()::text);
select t.ok(public.start_guest_session() = t.uid('demo'), 'Invitado: entrar dos veces usa la misma demostración');
select t.ok((select count(*) = 1 and bool_and(is_demo) from public.workspaces), 'Invitado: solo ve su balneario de demostración');
select t.ok((select count(*) from public.customers where workspace_id = t.uid('ws')) = 0, 'Invitado: no ve clientes reales');
select t.ok((select count(*) from public.payments where workspace_id = t.uid('ws')) = 0, 'Invitado: no ve pagos reales');
select t.ok((select count(*) from public.reservations) >= 10, 'Invitado: tiene reservas de demostración');
select t.ok((select count(*) from public.spaces) = (select count(*) from public.spaces where workspace_id = t.uid('demo')) and (select count(*) from public.spaces) > 50, 'Invitado: tiene el mismo plano (carpas)');
select public.end_guest_session();
reset role;
select t.ok(not exists (select 1 from public.workspaces where id = t.uid('demo')), 'Invitado: al salir se borra su balneario');
select t.ok((select count(*) from public.reservations where workspace_id = t.uid('demo')) = 0
        and (select count(*) from public.payments where workspace_id = t.uid('demo')) = 0
        and (select count(*) from public.audit_log where workspace_id = t.uid('demo')) = 0, 'Invitado: no queda ningún dato de la demostración');
select t.ok((select count(*)::text from public.payments where workspace_id = t.uid('ws')) = t.get('real_payments')
        and (select count(*)::text from public.reservations where workspace_id = t.uid('ws')) = t.get('real_res'), 'Invitado: los datos reales quedan intactos');
select t.throws(format($$select private.purge_demo_workspace(%L)$$, t.get('ws')), 'Solo se pueden borrar balnearios de demostración', 'Invitado: el balneario real nunca se puede borrar');
select t.throws($$delete from public.payments$$, 'no se puede', 'Los pagos reales siguen sin poder borrarse');

-- 23. Varios balnearios: cualquiera se registra y crea el suyo
reset role;
insert into auth.users (id, email) values ('77777777-7777-7777-7777-777777777777', 'otro@test.com');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","email":"otro@test.com"}', false);
select t.ok(not public.can_create_workspace(), 'Altas cerradas: una cuenta nueva sin plan no puede crear balneario');
select t.throws($$select public.create_workspace('Sin plan', 20, 5)$$, 'hace falta un plan', 'Altas cerradas: se rechaza el alta sin plan');
reset role;
select private.permitir_alta('OTRO@test.com', 'Plan 1');
set role authenticated;
select t.ok(public.can_create_workspace(), 'Altas cerradas: con el correo habilitado (sin importar mayúsculas) sí puede');
select t.throws($$select private.permitir_alta('yo@test.com')$$, 'permission denied', 'Altas cerradas: nadie se habilita a sí mismo desde la web');
select t.set('ws2', public.create_workspace('Balneario Los Médanos', 20, 5)::text);
reset role;
select t.ok((select used_at is not null from private.signup_allowlist where email = 'otro@test.com'), 'Altas cerradas: la habilitación queda usada');
set role authenticated;
select t.ok((select count(*) from public.spaces where kind = 'carpa') = 20 and (select count(*) from public.spaces where kind = 'sombrilla') = 5, 'Multi: el balneario nuevo arranca con las carpas y sombrillas pedidas');
select t.ok((select string_agg(code, ',' order by code) from public.spaces where kind = 'sombrilla') = '21,22,23,24,25', 'Multi: las sombrillas siguen la numeración');
select t.ok((select count(*) from public.workspaces) = 1 and (select id from public.workspaces) = t.uid('ws2'), 'Multi: cada uno ve solo su balneario');
select t.ok((select count(*) from public.customers) = 0 and (select count(*) from public.payments) = 0 and (select count(*) from public.reservations) = 0, 'Multi: no ve clientes, pagos ni reservas de otro balneario');
select t.throws(format($$select public.dashboard_summary(%L)$$, t.get('ws')), 'No tenés permiso', 'Multi: no puede consultar el panel de otro balneario');
select t.throws($$select public.create_workspace('Segundo')$$, 'ya pertenece', 'Multi: una cuenta crea un solo balneario');
select t.throws($$select public.create_workspace('X', 0, 0)$$, 'Indicá cuántas', 'Multi: hay que tener al menos una carpa o sombrilla');

-- 24. Restaurar una copia
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);
select t.set('bk', (public.create_backup(t.uid('ws'), 'manual', 'Antes de probar') ->> 'backup_id'));
select t.set('n_cust', (select count(*)::text from public.customers where workspace_id = t.uid('ws')));
select t.set('n_pay', (select count(*)::text from public.payments where workspace_id = t.uid('ws')));
select t.set('n_seg', (select count(*)::text from public.reservation_segments where workspace_id = t.uid('ws')));
select t.set('n_mov', (select count(*)::text from public.cash_movements where workspace_id = t.uid('ws')));
select t.set('n_audit', (select count(*)::text from public.audit_log where workspace_id = t.uid('ws')));
insert into public.customers (workspace_id, first_name, last_name) values (t.uid('ws'), 'Cargado', 'Despues');
select t.throws(format($$select public.restore_backup(%L, 'si')$$, t.get('bk')), 'RESTAURAR', 'Restaurar: pide escribir RESTAURAR');
select t.set('rs', public.restore_backup(t.uid('bk'), 'RESTAURAR')::text);
select t.ok((select count(*)::text from public.customers where workspace_id = t.uid('ws')) = t.get('n_cust'), 'Restaurar: los clientes vuelven a como estaban');
select t.ok(not exists (select 1 from public.customers where first_name = 'Cargado'), 'Restaurar: lo cargado después de la copia no queda');
select t.ok((select count(*)::text from public.payments where workspace_id = t.uid('ws')) = t.get('n_pay')
        and (select count(*)::text from public.reservation_segments where workspace_id = t.uid('ws')) = t.get('n_seg')
        and (select count(*)::text from public.cash_movements where workspace_id = t.uid('ws')) = t.get('n_mov'), 'Restaurar: pagos, tramos y movimientos de caja completos');
select t.ok((select count(*) from public.audit_log where workspace_id = t.uid('ws'))::int > t.get('n_audit')::int, 'Restaurar: el historial no se borra');
select t.ok(exists (select 1 from public.audit_log where workspace_id = t.uid('ws') and table_name = 'backups'), 'Restaurar: queda registrada la restauración');
select t.ok(exists (select 1 from public.backups where id = (t.get('rs')::jsonb ->> 'copia_previa')::uuid), 'Restaurar: antes se guardó una copia del estado anterior');
select t.ok((select count(*) from public.workspace_users(t.uid('ws'))) >= 1, 'Usuarios: la lista funciona con correos tipo varchar');
select t.set('bk_old', (public.create_backup(t.uid('ws'), 'manual', 'Simula copia vieja') ->> 'backup_id'));
reset role;
update public.backups set data = jsonb_set(jsonb_set(data, '{spaces}', '[5, 7]'), '{map_features}', '[1]') where id = t.uid('bk_old');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);
select t.set('n_sp', (select count(*)::text from public.spaces where workspace_id = t.uid('ws')));
select public.restore_backup(t.uid('bk_old'), 'RESTAURAR');
select t.ok((select count(*)::text from public.spaces where workspace_id = t.uid('ws')) = t.get('n_sp')
        and (select count(*) from public.reservation_segments where workspace_id = t.uid('ws'))::text = t.get('n_seg'), 'Restaurar: con una copia vieja las carpas y el plano quedan como están');
select t.ok((select jsonb_typeof(data -> 'spaces' -> 0) from public.backups where id = t.uid('bk')) = 'object', 'Copias: ahora guardan bien las carpas (posición incluida)');
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"operador@test.com"}', false);
select t.throws(format($$select public.restore_backup(%L, 'RESTAURAR')$$, t.get('bk')), 'No tenés permiso', 'Restaurar: solo el propietario');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);

-- 25. Importar una copia (archivo descargado)
select t.set('file', (select (jsonb_build_object('formato', 'balneario-copia-v1', 'creada', created_at) || data)::text from public.backups where id = t.uid('bk')));
select t.set('imp', (public.import_backup(t.uid('ws'), t.get('file')::jsonb, 'Archivo de la compu') ->> 'backup_id'));
select t.ok((select kind = 'importada' and (counts ->> 'reservations')::int > 0 from public.backups where id = t.uid('imp')), 'Importar: queda como copia importada');
insert into public.customers (workspace_id, first_name, last_name) values (t.uid('ws'), 'Otro', 'Cliente');
select public.restore_backup(t.uid('imp'), 'RESTAURAR');
select t.ok(not exists (select 1 from public.customers where first_name = 'Otro' and last_name = 'Cliente') and (select count(*)::text from public.customers where workspace_id = t.uid('ws')) = t.get('n_cust'), 'Importar: restaurar el archivo vuelve los datos');
select t.throws(format($$select public.import_backup(%L, '{"hola": 1}'::jsonb)$$, t.get('ws')), 'no es una copia', 'Importar: rechaza archivos que no son copias');
-- De otro balneario: identificadores nuevos, no toca los datos del original
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","email":"otro@test.com"}', false);
select t.set('imp2', (public.import_backup(t.uid('ws2'), t.get('file')::jsonb) ->> 'backup_id'));
select public.restore_backup(t.uid('imp2'), 'RESTAURAR');
select t.ok((select count(*)::text from public.customers where workspace_id = t.uid('ws2')) = t.get('n_cust'), 'Importar: los datos pasan a otro balneario');
select t.ok((select count(*) from public.reservations where workspace_id = t.uid('ws2')) > 0
        and (select count(*) from public.reservation_segments g join public.spaces s on s.id = g.space_id where g.workspace_id = t.uid('ws2') and s.workspace_id = t.uid('ws2')) > 0, 'Importar: las reservas quedan con las carpas del balneario nuevo');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);
select t.ok((select count(*)::text from public.customers where workspace_id = t.uid('ws')) = t.get('n_cust'), 'Importar: el balneario original queda igual');
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"operador@test.com"}', false);
select t.throws(format($$select public.import_backup(%L, %L::jsonb)$$, t.get('ws'), t.get('file')), 'No tenés permiso', 'Importar: solo el propietario');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);

-- 26. Seguridad: límite de intentos y permisos
reset role;
select t.ok(public.login_allowed('u:pepe', 'ip:1.2.3.4'), 'Ingreso: al principio se puede intentar');
select public.login_record('u:pepe', 'ip:1.2.3.4', false) from generate_series(1, 10);
select t.ok(not public.login_allowed('u:pepe', 'ip:9.9.9.9'), 'Ingreso: 10 contraseñas mal seguidas bloquean al usuario');
select t.ok(public.login_allowed('u:otro', 'ip:9.9.9.9'), 'Ingreso: no bloquea a otros usuarios');
select public.login_record('u:pepe', null, true);
select t.ok(public.login_allowed('u:pepe', null), 'Ingreso: al entrar bien se limpian las fallas');
select public.login_record('u:x' || g, 'ip:5.5.5.5', false) from generate_series(1, 30) g;
select t.ok(not public.login_allowed('u:nuevo', 'ip:5.5.5.5'), 'Ingreso: muchas fallas desde una misma conexión la bloquean');
set role authenticated;
select t.throws($$select public.login_allowed('u:a', null)$$, 'permission denied', 'Ingreso: el navegador no puede consultar ni borrar los intentos');
reset role;
select t.ok(not exists (
  select 1 from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    and table_name <> 'user_preferences'), 'Seguridad: ninguna tabla tiene permisos de escritura generales de más');
select t.ok(not exists (
  select 1 from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'anon' and privilege_type = 'SELECT'), 'Seguridad: sin sesión no se puede leer ninguna tabla');

-- 27. Copias en Google Drive
reset role;
select public.drive_save_link(t.uid('ws'), '11111111-1111-1111-1111-111111111111', 'cifrado', 'carpeta1', 'duenio@gmail.com');
select t.ok(t.uid('ws') in (select public.drive_pending()), 'Drive: un balneario conectado sin copia queda pendiente');
select public.drive_mark(t.uid('ws'), true, 'copia.json', null);
select t.ok(t.uid('ws') not in (select public.drive_pending()), 'Drive: después de subir no vuelve a subir hasta el otro día');
select t.ok((public.backup_payload(t.uid('ws')) ->> 'formato') = 'balneario-copia-v1' and jsonb_array_length(public.backup_payload(t.uid('ws')) -> 'customers') > 0, 'Drive: la copia tiene el formato importable');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);
select t.ok((public.drive_status(t.uid('ws')) ->> 'conectado')::boolean and not (public.drive_status(t.uid('ws')) ? 'token_enc'), 'Drive: el estado no muestra el permiso guardado');
select t.throws(format($$select public.drive_get_link(%L)$$, t.get('ws')), 'permission denied', 'Drive: el navegador no puede leer el permiso de Drive');
select t.throws(format($$select public.backup_payload(%L)$$, t.get('ws')), 'permission denied', 'Drive: el navegador no puede pedir la copia por esta vía');
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","email":"otro@test.com"}', false);
select t.throws(format($$select public.drive_status(%L)$$, t.get('ws')), 'No tenés permiso', 'Drive: otro balneario no ve tu conexión');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);

-- 28. Llegó / no vino
select t.set('hoy', ((now() at time zone 'America/Argentina/San_Juan')::date)::text);
select t.set('resHoy', (public.create_reservation_v2(t.uid('ws'), gen_random_uuid(), t.uid('juan'), t.get('hoy')::date, t.get('hoy')::date + 2,
  jsonb_build_array(jsonb_build_object('space_id', t.space('78'), 'start_date', t.get('hoy'), 'end_date', (t.get('hoy')::date + 2)::text)),
  '{"manual_base": 30000}'::jsonb, null, null) ->> 'reservation_id'));
select public.set_arrival(t.uid('resHoy'), 'llego');
select t.ok((select arrival_status = 'llego' and arrival_by = '11111111-1111-1111-1111-111111111111' and arrival_at is not null from public.reservations where id = t.uid('resHoy')), 'Llegada: se marca que llegó, con quién y cuándo');
select public.set_arrival(t.uid('resHoy'), 'no_vino');
select t.ok((select r.arrival_status = 'no_vino' and r.total_amount = 30000 and b.due_amount = 30000 from public.reservations r join public.reservation_balances b on b.reservation_id = r.id where r.id = t.uid('resHoy'))
        and exists (select 1 from public.reservation_segments where reservation_id = t.uid('resHoy') and active), 'Llegada: "no vino" no toca la deuda ni libera la carpa');
select public.set_arrival(t.uid('resHoy'), null);
select t.ok((select arrival_status is null and arrival_at is null from public.reservations where id = t.uid('resHoy')), 'Llegada: se puede quitar la marca');
select t.ok((select count(*) from public.audit_log where row_id = t.uid('resHoy') and table_name = 'reservations' and new_data ? 'arrival_status') >= 3, 'Llegada: cada marca queda en el historial');
select t.throws(format($$select public.set_arrival(%L, 'llego')$$, t.get('resP')), 'recién ese día', 'Llegada: no se marca antes del primer día');
select t.throws(format($$select public.set_arrival(%L, 'perdido')$$, t.get('resHoy')), 'inválido', 'Llegada: estado inválido');
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","email":"otro@test.com"}', false);
select t.throws(format($$select public.set_arrival(%L, 'llego')$$, t.get('resHoy')), 'No tenés permiso', 'Llegada: otro balneario no puede marcar');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);

-- 29. Renovación de temporada
select public.set_renewal_mark(t.uid('ws'), t.uid('ana'), '2025/2026', 'avisado');
select t.ok((select status = 'avisado' and contacted_at is not null from public.renewal_marks where customer_id = t.uid('ana')), 'Renovación: queda marcado que se le avisó');
select public.set_renewal_mark(t.uid('ws'), t.uid('ana'), '2025/2026', 'no_vuelve');
select t.ok((select status = 'no_vuelve' and version = 2 and contacted_at is not null from public.renewal_marks where customer_id = t.uid('ana')), 'Renovación: se cambia a "no vuelve" sin perder cuándo se avisó');
select t.ok((select count(*) from public.renewal_marks where customer_id = t.uid('ana')) = 1, 'Renovación: una sola marca por cliente y temporada');
select t.throws(format($$select public.set_renewal_mark(%L, %L, '2025', 'avisado')$$, t.get('ws'), t.get('ana')), 'Temporada inválida', 'Renovación: temporada inválida');
select t.throws(format($$insert into public.renewal_marks (workspace_id, customer_id, season, status) values (%L, %L, '2025/2026', 'avisado')$$, t.get('ws'), t.get('juan')), 'permission denied', 'Renovación: no se escribe directo en la tabla');
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","email":"otro@test.com"}', false);
select t.ok((select count(*) from public.renewal_marks where workspace_id = t.uid('ws')) = 0, 'Renovación: otro balneario no ve las marcas');
select t.throws(format($$select public.set_renewal_mark(%L, %L, '2025/2026', 'avisado')$$, t.get('ws2'), t.get('ana')), 'no existe', 'Renovación: no se marca un cliente de otro balneario');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);
select t.set('bkR', (public.create_backup(t.uid('ws'), 'manual', 'Con renovaciones') ->> 'backup_id'));
select t.ok((select jsonb_array_length(data -> 'renewal_marks') = 1 from public.backups where id = t.uid('bkR')), 'Renovación: las marcas van en la copia de seguridad');

-- 30. No vino: liberar y descontar
select t.set('r1d', (public.create_reservation_v2(t.uid('ws'), gen_random_uuid(), t.uid('juan'), t.get('hoy')::date, t.get('hoy')::date,
  jsonb_build_array(jsonb_build_object('space_id', t.space('77'), 'start_date', t.get('hoy'), 'end_date', t.get('hoy'))),
  '{"manual_base": 10000}'::jsonb, null, null) ->> 'reservation_id'));
select t.ok((public.set_arrival(t.uid('r1d'), 'no_vino') ->> 'liberado')::boolean, 'No vino (1 día): avisa que se liberó');
select t.ok((select r.status = 'confirmada' and b.due_amount = 10000 from public.reservations r join public.reservation_balances b on b.reservation_id = r.id where r.id = t.uid('r1d'))
        and not exists (select 1 from public.reservation_segments where reservation_id = t.uid('r1d') and active), 'No vino (1 día): la carpa queda libre y la reserva sigue (con su deuda)');
select t.set('r1o', (public.create_reservation_v2(t.uid('ws'), gen_random_uuid(), t.uid('luis'), t.get('hoy')::date, t.get('hoy')::date,
  jsonb_build_array(jsonb_build_object('space_id', t.space('77'), 'start_date', t.get('hoy'), 'end_date', t.get('hoy'))),
  '{"manual_base": 10000}'::jsonb, null, null) ->> 'reservation_id'));
select t.ok(t.get('r1o') is not null, 'No vino (1 día): otro cliente puede tomar esa carpa');
select t.throws(format($$select public.set_arrival(%L, 'llego')$$, t.get('r1d')), 'No se puede revertir', 'No vino (1 día): si ya la tomó otro, no se puede volver a ocupar');
select t.set('r1e', (public.create_reservation_v2(t.uid('ws'), gen_random_uuid(), t.uid('juan'), t.get('hoy')::date, t.get('hoy')::date,
  jsonb_build_array(jsonb_build_object('space_id', t.space('76'), 'start_date', t.get('hoy'), 'end_date', t.get('hoy'))),
  '{"manual_base": 10000}'::jsonb, null, null) ->> 'reservation_id'));
select public.set_arrival(t.uid('r1e'), 'no_vino');
select public.set_arrival(t.uid('r1e'), null);
select t.ok(exists (select 1 from public.reservation_segments where reservation_id = t.uid('r1e') and active and space_id = t.space('76')), 'No vino (1 día): al corregir la marca vuelve a ocupar la carpa');

-- Varios días: la reserva sigue; se libera el día y se puede descontar
select public.set_arrival(t.uid('resHoy'), 'no_vino');
select t.ok((select count(*) from public.reservation_segments where reservation_id = t.uid('resHoy') and active and start_date = t.get('hoy')::date) = 1, 'No vino (varios días): no se libera nada solo');
select public.release_no_show_day(t.uid('resHoy'), t.get('hoy')::date, false);
select t.ok(not exists (select 1 from public.reservation_segments where reservation_id = t.uid('resHoy') and active and t.get('hoy')::date between start_date and end_date)
        and exists (select 1 from public.reservation_segments where reservation_id = t.uid('resHoy') and active and start_date = t.get('hoy')::date + 1 and end_date = t.get('hoy')::date + 2),
        'No vino (varios días): se libera solo ese día');
select t.ok((select total_amount = 30000 from public.reservations where id = t.uid('resHoy')), 'No vino: liberar no cambia el precio');
select t.ok((public.release_no_show_day(t.uid('resHoy'), t.get('hoy')::date, true) ->> 'descuento')::numeric = 10000, 'No vino: el descuento es lo que vale un día (30.000 ÷ 3)');
select t.ok((select r.total_amount = 20000 and b.due_amount = 20000 from public.reservations r join public.reservation_balances b on b.reservation_id = r.id where r.id = t.uid('resHoy'))
        and exists (select 1 from public.reservation_discounts where reservation_id = t.uid('resHoy') and label = 'Día no usado (no vino)'), 'No vino: total y deuda bajan, queda el descuento registrado');
select t.throws(format($$select public.release_no_show_day(%L, %L, true)$$, t.get('resHoy'), t.get('hoy')), 'ya se descontó', 'No vino: no se descuenta dos veces el mismo día');
select t.throws(format($$select public.release_no_show_day(%L, %L, false)$$, t.get('resHoy'), (t.get('hoy')::date + 1)::text), 'hoy o anteriores', 'No vino: no se liberan días futuros');
select t.throws(format($$select public.set_arrival(%L, 'llego')$$, t.get('resHoy')), 'ya se descontó', 'No vino: con el día descontado no se vuelve a ocupar solo');
select public.relocate_reservation(t.uid('resHoy'), t.space('75'), t.get('hoy')::date + 2, t.get('hoy')::date + 2,
  (select version from public.reservations where id = t.uid('resHoy')), 'Pidió cambio');
select t.ok(exists (select 1 from public.reservation_segments where reservation_id = t.uid('resHoy') and active and space_id = t.space('75')), 'No vino: después de liberar se puede seguir cambiando de carpa');
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"operador@test.com"}', false);
select t.throws(format($$select public.release_no_show_day(%L, %L, true)$$, t.get('resHoy'), t.get('hoy')), 'No tenés permiso', 'No vino: solo un administrador descuenta');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);
select t.throws(format($$select public.release_no_show_day(%L, %L, false)$$, t.get('resP'), '2027-01-13'), 'Primero marcá', 'No vino: hay que marcar "no vino" antes de liberar');

-- 31. Mensajes de WhatsApp propios
update public.workspaces set message_templates = '{"deuda_hoy": "Hola {nombre}, hoy es tu último día"}'::jsonb, version = version + 1 where id = t.uid('ws');
select t.ok((select message_templates ->> 'deuda_hoy' from public.workspaces where id = t.uid('ws')) like 'Hola {nombre}%', 'Mensajes: el administrador guarda su mensaje');
select t.throws(format($q$update public.workspaces set message_templates = '{"cualquiera": "x"}'::jsonb, version = version + 1 where id = %L$q$, t.get('ws')), 'check', 'Mensajes: solo los mensajes conocidos');
select t.throws(format($q$update public.workspaces set message_templates = jsonb_build_object('deuda_hoy', repeat('a', 1001)), version = version + 1 where id = %L$q$, t.get('ws')), 'check', 'Mensajes: máximo 1000 letras');

-- 32. Panel del dueño del sistema
select t.ok(not public.is_platform_admin(), 'Dueño: por defecto nadie es dueño de la plataforma');
select t.throws($$select public.admin_overview()$$, 'No tenés permiso', 'Dueño: un balneario común no ve el panel');
select t.throws($$select private.hacer_admin_plataforma('duenio@test.com')$$, 'permission denied', 'Dueño: nadie se hace dueño desde la web');
reset role;
select private.hacer_admin_plataforma('DUENIO@test.com');
set role authenticated;
select t.ok(public.is_platform_admin(), 'Dueño: se habilita por correo desde el SQL Editor');
select t.ok((select count(*) from jsonb_array_elements(public.admin_overview() -> 'balnearios') b where (b ->> 'id')::uuid = t.uid('ws') and b ->> 'propietario' = 'duenio@test.com') = 1,
        'Dueño: ve los balnearios con su propietario');
select public.admin_allow_signup('Nuevo@Cliente.com', 'Balneario La Ola');
select t.ok(exists (select 1 from jsonb_array_elements(public.admin_overview() -> 'habilitaciones') h where h ->> 'correo' = 'nuevo@cliente.com' and h ->> 'usado' is null), 'Dueño: habilita un correo nuevo');
select t.throws($$select public.admin_allow_signup('no-es-correo', null)$$, 'Correo inválido', 'Dueño: valida el correo');
select public.admin_revoke_signup('nuevo@cliente.com');
select t.ok(not exists (select 1 from jsonb_array_elements(public.admin_overview() -> 'habilitaciones') h where h ->> 'correo' = 'nuevo@cliente.com'), 'Dueño: quita una habilitación sin usar');
select t.throws($$select public.admin_revoke_signup('duenio@test.com')$$, 'ya se usó', 'Dueño: no quita una habilitación ya usada');

-- 33. Balneario en pausa
select t.throws(format($$select public.admin_set_paused(%L, true, '')$$, t.get('ws')), 'motivo', 'Pausa: pide motivo');
select public.admin_set_paused(t.uid('ws'), true, 'Falta de pago');
select t.throws(format($$insert into public.customers (workspace_id, first_name) values (%L, 'Pausado')$$, t.get('ws')), 'en pausa', 'Pausa: no se cargan clientes');
select t.throws(format($$update public.spaces set notes = 'x', version = version + 1 where id = %L$$, t.space('60')), 'en pausa', 'Pausa: no se cambian las carpas');
select t.ok((select count(*) from public.reservations where workspace_id = t.uid('ws')) > 0, 'Pausa: los datos se siguen viendo');
select t.ok((public.create_backup(t.uid('ws'), 'manual', 'En pausa') ->> 'backup_id') is not null, 'Pausa: se puede descargar una copia');
select t.throws(format($$update public.workspaces set paused_at = null where id = %L$$, t.get('ws')), 'permission denied', 'Pausa: el balneario no se saca la pausa solo');
select public.admin_set_paused(t.uid('ws'), false, null);
select t.ok((select paused_at is null from public.workspaces where id = t.uid('ws')), 'Pausa: el dueño la saca');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","email":"extranio@test.com"}', false);
select t.throws(format($$select public.admin_set_paused(%L, true, 'x x x')$$, t.get('ws')), 'No tenés permiso', 'Pausa: otro balneario no puede pausar');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);

-- 34. Extras en reservas
insert into public.extras (workspace_id, name, price, per_day) values (t.uid('ws'), 'Reposera', 2000, true), (t.uid('ws'), 'Estacionamiento', 5000, false);
select t.set('xRep', (select id::text from public.extras where workspace_id = t.uid('ws') and name = 'Reposera'));
select t.set('xEst', (select id::text from public.extras where workspace_id = t.uid('ws') and name = 'Estacionamiento'));
select t.set('rX', (public.create_reservation_v2(t.uid('ws'), gen_random_uuid(), t.uid('juan'), '2027-03-10', '2027-03-12',
  jsonb_build_array(jsonb_build_object('space_id', t.space('60'), 'start_date', '2027-03-10', 'end_date', '2027-03-12')),
  '{"manual_base": 30000}'::jsonb, null, null) ->> 'reservation_id'));
select t.ok((public.add_reservation_extra(t.uid('rX'), t.uid('xRep'), 2) ->> 'importe')::numeric = 12000, 'Extras: por día = precio × cantidad × días de la estadía (2.000 × 2 × 3)');
select t.ok((public.add_reservation_extra(t.uid('rX'), t.uid('xEst'), 1, 3) ->> 'importe')::numeric = 5000, 'Extras: un extra por única vez no multiplica días');
select t.ok((select r.total_amount = 47000 and b.due_amount = 47000 from public.reservations r join public.reservation_balances b on b.reservation_id = r.id where r.id = t.uid('rX')),
        'Extras: suman al total y a la deuda');
select t.throws(format($$select public.add_reservation_extra(%L, %L, 1, 9)$$, t.get('rX'), t.get('xRep')), 'de la estadía', 'Extras: no más días que la estadía');
select t.throws(format($$update public.reservation_extras set amount = 1 where reservation_id = %L$$, t.get('rX')), 'permission denied', 'Extras: no se editan a mano');
select t.set('lnX', (select id::text from public.reservation_extras where reservation_id = t.uid('rX') and description = 'Estacionamiento'));
select t.throws(format($$select public.void_reservation_extra(%L, '')$$, t.get('lnX')), 'motivo', 'Extras: anular pide motivo');
select public.void_reservation_extra(t.uid('lnX'), 'No trajo auto');
select t.ok((select total_amount = 42000 from public.reservations where id = t.uid('rX'))
        and exists (select 1 from public.reservation_extras where id = t.uid('lnX') and voided_at is not null), 'Extras: al anular baja el total y el extra queda registrado');
select t.throws(format($$select public.void_reservation_extra(%L, 'otra vez')$$, t.get('lnX')), 'ya está anulado', 'Extras: no se anula dos veces');
update public.extras set active = false, version = version + 1 where id = t.uid('xEst');
select t.throws(format($$select public.add_reservation_extra(%L, %L, 1)$$, t.get('rX'), t.get('xEst')), 'desactivado', 'Extras: uno desactivado no se ofrece');
select t.set('bkX', (public.create_backup(t.uid('ws'), 'manual', 'Con extras') ->> 'backup_id'));
select t.ok((select jsonb_array_length(data -> 'reservation_extras') = 2 and jsonb_array_length(data -> 'extras') = 2
             from public.backups where id = t.uid('bkX')), 'Extras: van en la copia de seguridad', (select (data -> 'extras')::text from public.backups where id = t.uid('bkX')));
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"operador@test.com"}', false);
select t.throws(format($$insert into public.extras (workspace_id, name, price) values (%L, 'Sombrilla extra', 100)$$, t.get('ws')), 'row-level security', 'Extras: el operador no arma el catálogo');
select t.ok((public.add_reservation_extra(t.uid('rX'), t.uid('xRep'), 1, 1) ->> 'importe')::numeric = 2000, 'Extras: el operador sí carga un extra en una reserva');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","email":"extranio@test.com"}', false);
select t.ok((select count(*) from public.reservation_extras where workspace_id = t.uid('ws')) = 0, 'Extras: otro balneario no los ve');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);

-- 35. Comparar temporadas
select t.set('st', public.season_stats(t.uid('ws'), 2026)::text);
select t.ok(jsonb_array_length(t.get('st')::jsonb -> 'meses') = 12 and t.get('st')::jsonb -> 'meses' -> 0 ->> 'mes' = '2026-07', 'Temporadas: 12 meses de julio a junio');
select t.ok((select (m ->> 'dias_ocupados')::int >= 3 and (m ->> 'contratado')::numeric >= 44000 from jsonb_array_elements(t.get('st')::jsonb -> 'meses') m where m ->> 'mes' = '2027-03'),
        'Temporadas: cuenta días ocupados y lo contratado del mes');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","email":"extranio@test.com"}', false);
select t.throws(format($$select public.season_stats(%L, 2026)$$, t.get('ws')), 'No tenés permiso', 'Temporadas: otro balneario no las ve');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);

-- 36. Planes y débito automático
select t.ok(private.extend_until('temporada', null, '2026-11-20') = '2027-03-31' and private.extend_until('temporada', '2027-03-31', '2027-02-10') = '2028-03-31'
        and private.extend_until('temporada', '2026-12-01', '2026-12-01') = '2027-03-31', 'Planes: la temporada paga hasta el 31/3 que corresponde');
select t.ok(private.extend_until('mensual', '2027-01-10', '2027-01-08') = '2027-02-10' and private.extend_until('mensual', '2026-12-01', '2027-01-05') = '2027-02-05', 'Planes: el mensual suma un mes desde el vencimiento (o desde el pago si estaba vencido)');
select public.admin_set_prices(15000, 120000);
select public.admin_allow_signup('cliente@test.com', 'La Ola', 'mensual', null);
reset role;
insert into auth.users (id, email) values ('99999999-9999-9999-9999-999999999999', 'cliente@test.com');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999999","email":"cliente@test.com"}', false);
select t.set('wsC', public.create_workspace('La Ola', 3, 0)::text);
select t.ok((select plan = 'mensual' and price = 15000 and status = 'pendiente' and paid_until = private.today_ar() from public.subscriptions where workspace_id = t.uid('wsC')),
        'Planes: al crear el balneario nace su plan con el precio general');
insert into public.customers (workspace_id, first_name) values (t.uid('wsC'), 'Primer');
select t.ok(true, 'Planes: durante los días de gracia se puede cargar');
reset role;
update public.subscriptions set paid_until = private.today_ar() - 4 where workspace_id = t.uid('wsC');
set role authenticated;
select t.throws(format($$insert into public.customers (workspace_id, first_name) values (%L, 'Tarde')$$, t.get('wsC')), 'plan de Mi Balneario venció', 'Planes: vencido + 3 días queda en solo lectura');
select t.ok((public.my_plan(t.uid('wsC')) ->> 'vencido')::boolean and (select count(*) from public.customers where workspace_id = t.uid('wsC')) = 1, 'Planes: vencido igual ve sus datos');
select t.throws($$select public.plan_mp_payment('pre-1', 'pay-1', 'approved', 15000, current_date)$$, 'permission denied', 'Planes: un usuario no puede marcar pagos');
reset role;
set role service_role;
select public.plan_mp_link(t.uid('wsC'), 'pre-1', 'cliente@test.com');
select public.plan_mp_status('pre-1', 'authorized', private.today_ar());
select public.plan_mp_payment('pre-1', 'pay-1', 'approved', 15000, private.today_ar());
select public.plan_mp_payment('pre-1', 'pay-1', 'approved', 15000, private.today_ar());
reset role;
select t.ok((select status = 'activa' and paid_until = (private.today_ar() + interval '1 month')::date from public.subscriptions where workspace_id = t.uid('wsC')),
        'Planes: el débito aprobado extiende un mes (y el mismo aviso repetido no suma dos veces)');
set role authenticated;
insert into public.customers (workspace_id, first_name) values (t.uid('wsC'), 'Pagó');
select t.ok(not (public.my_plan(t.uid('wsC')) ->> 'vencido')::boolean, 'Planes: al pagar vuelve a poder cargar');
reset role;
set role service_role;
select public.plan_mp_payment('pre-1', 'pay-2', 'rejected', 15000, private.today_ar());
select public.plan_mp_status('pre-1', 'cancelled', null);
reset role;
select t.ok((select status = 'cancelada' and last_payment_status = 'rechazado' from public.subscriptions where workspace_id = t.uid('wsC')), 'Planes: débito rechazado y cancelación quedan registrados');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);
select t.ok(public.admin_alert_count() >= 2 and jsonb_array_length(public.admin_overview() -> 'avisos') >= 2, 'Planes: al dueño le aparecen los avisos (rechazo y cancelación)');
select public.admin_mark_seen((select (a ->> 'id')::uuid from jsonb_array_elements(public.admin_overview() -> 'avisos') a where a ->> 'tipo' = 'pago_rechazado' limit 1));
select t.ok(not exists (select 1 from jsonb_array_elements(public.admin_overview() -> 'avisos') a where a ->> 'tipo' = 'pago_rechazado'), 'Planes: marcar el aviso como visto lo saca de la lista');
select t.set('hasta', public.admin_register_payment(t.uid('wsC'), 15000, '2030-01-31', 'Transferencia')::text);
reset role;
select t.ok(t.get('hasta') = '2030-01-31'
        and (select status = 'manual' from public.subscriptions where workspace_id = t.uid('wsC')), 'Planes: el dueño registra un pago a mano y elige hasta cuándo');
set role authenticated;
select public.admin_set_plan(t.uid('ws'), 'temporada', 0, true);
select t.ok((select status = 'exenta' from public.subscriptions where workspace_id = t.uid('ws')) and not private.plan_expired(t.uid('ws')), 'Planes: un balneario exento no vence');
select set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999999","email":"cliente@test.com"}', false);
select t.throws(format($$select public.admin_register_payment(%L, 1, null, null)$$, t.get('wsC')), 'No tenés permiso', 'Planes: el cliente no se registra pagos solo');
select t.throws(format($$update public.subscriptions set paid_until = '2099-01-01' where workspace_id = %L$$, t.get('wsC')), 'permission denied', 'Planes: el cliente no cambia su vencimiento');
select public.cancel_my_plan(t.uid('wsC'));
select t.ok((select status = 'cancelada' and paid_until = '2030-01-31' from public.subscriptions where workspace_id = t.uid('wsC')), 'Planes: «No renovar» sin débito: sigue hasta el día pago');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","email":"extranio@test.com"}', false);
select t.throws(format($$select public.my_plan(%L)$$, t.get('wsC')), 'No tenés permiso', 'Planes: otro balneario no ve el plan');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"duenio@test.com"}', false);

-- 37. Importes con formato argentino en los textos de la base
select t.ok(private.ars(18000) = '$ 18.000' and private.ars(1234.5) = '$ 1.234,50', 'Formato: $ 18.000 y $ 1.234,50');
select t.ok(exists (select 1 from public.reservation_charges where description like '%× $ %')
        and not exists (select 1 from public.reservation_charges where description ~ '\$ ?[0-9]{1,3},[0-9]{3}'), 'Formato: los tramos de precio muestran $ 18.000');

reset role;
\o
-- Resultado ----------------------------------------------------------
\pset format aligned
select n, case when ok then 'OK ' else 'FALLA' end as res, name, case when not ok then detail end as detalle
from t.results order by n;
select count(*) filter (where ok) as aprobadas, count(*) filter (where not ok) as fallidas from t.results;
