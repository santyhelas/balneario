-- Datos de ejemplo para las capturas del reel (solo en la base de prueba de CI; nombres inventados).
do $$
declare
  v_ws uuid; v_uid uuid; d date := (now() at time zone 'America/Argentina/San_Juan')::date;
  c record; v_res jsonb; v_id uuid; m int; y int;
begin
  select m2.workspace_id, u.id into v_ws, v_uid from auth.users u join public.workspace_members m2 on m2.user_id = u.id and m2.role = 'propietario' where u.email = 'e2e@prueba.com';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  update public.workspaces set name = 'Balneario Las Gaviotas', version = version + 1 where id = v_ws;
  -- Tarifas: $80.000 por día, de este mes a 4 meses.
  for i in 0..4 loop
    y := extract(year from (d + (i || ' month')::interval))::int; m := extract(month from (d + (i || ' month')::interval))::int;
    perform public.set_rate(v_ws, 'carpa', y, m, 1::smallint, 80000); perform public.set_rate(v_ws, 'carpa', y, m, 2::smallint, 80000);
    perform public.set_rate(v_ws, 'sombrilla', y, m, 1::smallint, 64000); perform public.set_rate(v_ws, 'sombrilla', y, m, 2::smallint, 64000);
  end loop;
  perform public.open_cash_session(v_ws, 50000);

  for c in select * from (values
    ('Paula','Gallardo','+54 9 11 4998-6513','5', 0, 7, 650000::numeric, 585000::numeric, 117000::numeric, 'transferencia'),
    ('Martín','Sosa','+54 9 11 5636-9810','12', 2, 8, null, null, 0::numeric, null),
    ('Laura','Ríos','+54 9 221 481-3879','8', 1, 5, null, null, 100000::numeric, 'transferencia'),
    ('Diego','Fernández','+54 9 11 3005-1566','21', -6, 8, null, null, 200000::numeric, 'efectivo'),
    ('Carla','Medina','+54 9 11 2301-2112','3', -3, 4, null, null, 320000::numeric, 'efectivo'),
    ('Sergio','Paz','+54 9 11 6510-8721','17', 3, 10, null, null, 0::numeric, null)
  ) as t(nom, ape, tel, carpa, desde, dias, lista, efvo, pago, medio)
  loop
    insert into public.customers (workspace_id, first_name, last_name, phone) values (v_ws, c.nom, c.ape, c.tel) returning id into v_id;
    v_res := public.create_reservation_v3(v_ws, gen_random_uuid(), v_id, d + c.desde, d + c.desde + c.dias - 1,
      jsonb_build_array(jsonb_build_object('space_id', (select id from public.spaces where workspace_id = v_ws and kind = 'carpa' and code = lpad(c.carpa, 2, '0')), 'start_date', d + c.desde, 'end_date', d + c.desde + c.dias - 1)),
      jsonb_strip_nulls(jsonb_build_object('manual_base', c.lista, 'manual_cash', c.efvo)), null, null, '[]'::jsonb);
    if c.pago > 0 then
      perform public.register_payment(v_ws, (v_res ->> 'reservation_id')::uuid, c.pago, c.medio, gen_random_uuid(), null);
    end if;
  end loop;
  perform public.register_expense(v_ws, gen_random_uuid(), 30000, d, 'Hielo y bidones', (select id from public.expense_categories where workspace_id = v_ws order by (name = 'Proveedores e insumos') desc limit 1), 'efectivo');
end $$;
