-- =====================================================================
--  BORRAR DATOS DE PRUEBA · Balneario
--  Pegar TODO en Supabase → SQL Editor → Run.
--
--  Borra SOLO lo que cargó "cargar_datos_de_prueba.sql" (lo tiene anotado
--  uno por uno). No toca nada de lo que cargaste vos en la página.
--  Las tarifas de prueba también se borran, salvo que las hayas cambiado.
--  Si algo falla, no se borra nada (todo o nada).
-- =====================================================================
do $$
declare
  v_res uuid[];
  v_pay uuid[];
  v_exp uuid[];
  v_chg uuid[];
  v_seg uuid[];
  v_all uuid[];
  v_n int;
begin
  if to_regclass('prueba.marcas') is null then
    raise notice 'No hay datos de prueba cargados. No se borró nada.';
    return;
  end if;

  select coalesce(array_agg(id), '{}') into v_res from prueba.marcas where tabla = 'reservations';
  select coalesce(array_agg(id), '{}') into v_exp from prueba.marcas where tabla = 'expenses';
  select coalesce(array_agg(id), '{}') into v_pay from public.payments where reservation_id = any(v_res);
  select coalesce(array_agg(id), '{}') into v_chg from public.reservation_changes where reservation_id = any(v_res);
  select coalesce(array_agg(id), '{}') into v_seg from public.reservation_segments where reservation_id = any(v_res);

  -- Seguridad: si después de cargar la prueba se hicieron cobros reales en esas reservas,
  -- o se usaron los clientes de prueba en reservas nuevas, no se borra nada.
  if exists (select 1 from public.reservations r
             where r.customer_id in (select id from prueba.marcas where tabla = 'customers')
               and r.id <> all(v_res)) then
    raise exception 'Hay reservas nuevas hechas con clientes de prueba. Cancelalas o avisame antes de borrar.';
  end if;

  -- Los datos de dinero e historial están protegidos contra borrado; se desactiva
  -- la protección SOLO durante este borrado y se vuelve a activar al final.
  alter table public.cash_movements disable trigger cash_movements_immutable;
  alter table public.payments disable trigger payments_immutable;
  alter table public.expenses disable trigger expenses_guard;
  alter table public.reservation_discounts disable trigger reservation_discounts_immutable;
  alter table public.reservation_charges disable trigger reservation_charges_immutable;
  alter table public.reservation_segments disable trigger reservation_segments_guard;
  alter table public.reservation_changes disable trigger reservation_changes_guard;
  alter table public.reservations disable trigger reservations_no_delete;
  alter table public.reservation_extras disable trigger reservation_extras_guard;
  alter table public.maintenance_blocks disable trigger maintenance_no_delete;
  alter table public.customers disable trigger customers_no_delete;
  alter table public.rates disable trigger rates_no_delete;
  alter table public.cash_sessions disable trigger cash_sessions_no_delete;
  alter table public.audit_log disable trigger audit_log_immutable;

  -- Vouchers del restaurante (existen desde la actualización 0016)
  if to_regclass('public.restaurant_vouchers') is not null then
    alter table public.restaurant_vouchers disable trigger restaurant_vouchers_no_delete;
    delete from public.restaurant_vouchers where reservation_id = any(v_res);
    alter table public.restaurant_vouchers enable trigger restaurant_vouchers_no_delete;
  end if;
  delete from public.cash_movements where payment_id = any(v_pay) or expense_id = any(v_exp);
  update public.payments set voids_payment_id = null where id = any(v_pay);
  delete from public.payments where id = any(v_pay);
  delete from public.expenses where id = any(v_exp);
  delete from public.reservation_extras where reservation_id = any(v_res);
  delete from public.reservation_discounts where reservation_id = any(v_res);
  delete from public.reservation_charges where reservation_id = any(v_res);
  delete from public.reservation_segments where reservation_id = any(v_res);
  update public.reservation_changes set reverts_change_id = null, reverted_by_change_id = null where id = any(v_chg);
  delete from public.reservation_changes where id = any(v_chg);
  delete from public.reservations where id = any(v_res);
  delete from public.maintenance_blocks where id in (select id from prueba.marcas where tabla = 'maintenance_blocks');
  delete from public.customers where id in (select id from prueba.marcas where tabla = 'customers');
  -- Tarifas de prueba: solo si nadie las modificó después (version = 1)
  delete from public.rates where id in (select id from prueba.marcas where tabla = 'rates') and version = 1;

  -- La caja que abrió la prueba: se borra solo si no le quedó ningún movimiento tuyo
  delete from public.cash_sessions s
  where s.id in (select id from prueba.marcas where tabla = 'cash_sessions')
    and not exists (select 1 from public.cash_movements m where m.cash_session_id = s.id)
    and not exists (select 1 from public.payments p where p.cash_session_id = s.id)
    and not exists (select 1 from public.expenses e where e.cash_session_id = s.id);

  -- Historial de cambios de esos datos
  v_all := v_res || v_pay || v_exp || v_chg || v_seg || array(select id from prueba.marcas);
  delete from public.audit_log where row_id = any(v_all);
  get diagnostics v_n = row_count;

  alter table public.cash_movements enable trigger cash_movements_immutable;
  alter table public.payments enable trigger payments_immutable;
  alter table public.expenses enable trigger expenses_guard;
  alter table public.reservation_discounts enable trigger reservation_discounts_immutable;
  alter table public.reservation_charges enable trigger reservation_charges_immutable;
  alter table public.reservation_segments enable trigger reservation_segments_guard;
  alter table public.reservation_changes enable trigger reservation_changes_guard;
  alter table public.reservations enable trigger reservations_no_delete;
  alter table public.reservation_extras enable trigger reservation_extras_guard;
  alter table public.maintenance_blocks enable trigger maintenance_no_delete;
  alter table public.customers enable trigger customers_no_delete;
  alter table public.rates enable trigger rates_no_delete;
  alter table public.cash_sessions enable trigger cash_sessions_no_delete;
  alter table public.audit_log enable trigger audit_log_immutable;

  -- Si no quedó ninguna reserva, la numeración vuelve a empezar desde 1.
  if not exists (select 1 from public.reservations) then
    alter table public.reservations alter column number restart with 1;
  end if;

  drop schema prueba cascade;
  raise notice 'Listo: se borraron % reservas, % cobros y % gastos de prueba.',
    coalesce(array_length(v_res, 1), 0), coalesce(array_length(v_pay, 1), 0), coalesce(array_length(v_exp, 1), 0);
end $$;
