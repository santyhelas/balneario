-- ACTUALIZACIÓN 0019 · Modo invitado (balneario de demostración que se borra al salir).
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0018).
begin;
-- =====================================================================
-- 0019 · Modo invitado: un balneario de DEMOSTRACIÓN por visitante.
--   · El invitado nunca ve el balneario real: tiene uno propio, con datos inventados.
--   · Al salir (o si queda abandonado más de 6 horas) se borra entero.
--   · Las protecciones contra borrado siguen igual para el balneario real:
--     la única excepción es borrar un balneario marcado como demostración,
--     y solo desde private.purge_demo_workspace.
-- =====================================================================
alter table public.workspaces add column is_demo boolean not null default false;

-- ¿Se está borrando este balneario de demostración? (lo activa solo purge_demo_workspace)
create or replace function private.purging(p_ws text) returns boolean
language sql stable as $$
  select p_ws is not null and p_ws = nullif(current_setting('app.purge_ws', true), '')
$$;

CREATE OR REPLACE FUNCTION private.forbid_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $fn$
begin
  -- Única excepción: borrar un balneario de demostración (modo invitado).
  if tg_op = 'DELETE' and private.purging(to_jsonb(old) ->> 'workspace_id') then return old; end if;
  raise exception 'Este registro no se puede modificar ni borrar. Las correcciones se hacen con una anulación.'
    using errcode = '42501';
end $fn$;

CREATE OR REPLACE FUNCTION private.changes_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $fn$
begin
  -- Única excepción: borrar un balneario de demostración (modo invitado).
  if tg_op = 'DELETE' and private.purging(to_jsonb(old) ->> 'workspace_id') then return old; end if;
  if tg_op = 'DELETE' then
    raise exception 'El historial no se puede borrar.' using errcode = '42501';
  end if;
  if (to_jsonb(new) - 'after_state' - 'reverted_by_change_id') <> (to_jsonb(old) - 'after_state' - 'reverted_by_change_id')
     or (old.after_state is not null and new.after_state is distinct from old.after_state)
     or (old.reverted_by_change_id is not null and new.reverted_by_change_id is distinct from old.reverted_by_change_id) then
    raise exception 'El historial no se puede modificar.' using errcode = '42501';
  end if;
  return new;
end $fn$;

CREATE OR REPLACE FUNCTION private.segments_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $fn$
declare v_msg text;
begin
  -- Única excepción: borrar un balneario de demostración (modo invitado).
  if tg_op = 'DELETE' and private.purging(to_jsonb(old) ->> 'workspace_id') then return old; end if;
  if tg_op = 'DELETE' then
    raise exception 'Los tramos no se borran; se finalizan con un cambio registrado.' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    -- Lo único permitido es finalizar un tramo activo.
    if not (old.active and not new.active and new.ended_by_change_id is not null
            and (to_jsonb(new) - 'active' - 'ended_by_change_id') = (to_jsonb(old) - 'active' - 'ended_by_change_id')) then
      raise exception 'Un tramo solo puede finalizarse, no modificarse.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.active then
    perform private.lock_spaces(array[new.space_id]);
    if exists (select 1 from public.reservations r where r.id = new.reservation_id and r.status = 'cancelada') then
      raise exception 'No se pueden asignar espacios a una reserva cancelada.';
    end if;
    if new.start_date < (select r.start_date from public.reservations r where r.id = new.reservation_id)
       or new.end_date > (select r.end_date from public.reservations r where r.id = new.reservation_id) then
      raise exception 'El tramo queda fuera de las fechas de la reserva.';
    end if;
    -- Desactivado o mantenimiento (las superposiciones con otras reservas
    -- las rechaza la restricción segments_no_double_booking).
    select case
             when not sp.active then format('%s está desactivada.', private.space_label(sp.kind, sp.code))
             else (select format('%s está en mantenimiento del %s al %s (%s).', private.space_label(sp.kind, sp.code),
                          to_char(m.start_date, 'DD/MM/YYYY'), to_char(m.end_date, 'DD/MM/YYYY'), m.reason)
                   from public.maintenance_blocks m
                   where m.space_id = new.space_id and m.active
                     and daterange(m.start_date, m.end_date, '[]') && daterange(new.start_date, new.end_date, '[]')
                   limit 1)
           end
      into v_msg
    from public.spaces sp where sp.id = new.space_id;
    if v_msg is not null then
      raise exception '%', v_msg using errcode = '23P01';
    end if;
  end if;
  return new;
end $fn$;

CREATE OR REPLACE FUNCTION private.expenses_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $fn$
begin
  -- Única excepción: borrar un balneario de demostración (modo invitado).
  if tg_op = 'DELETE' and private.purging(to_jsonb(old) ->> 'workspace_id') then return old; end if;
  if tg_op = 'DELETE' then
    raise exception 'Los gastos no se borran; se anulan.' using errcode = '42501';
  end if;
  if old.voided_at is not null
     or (to_jsonb(new) - 'voided_at' - 'voided_by' - 'void_reason') <> (to_jsonb(old) - 'voided_at' - 'voided_by' - 'void_reason') then
    raise exception 'Un gasto registrado no se puede modificar; solo anular.' using errcode = '42501';
  end if;
  return new;
end $fn$;

-- ¿El usuario actual entró como invitado?
create or replace function private.is_guest() returns boolean
language sql stable as $$
  select coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false)
$$;

-- Borra entero un balneario de demostración (nunca uno real).
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

-- Limpia invitados abandonados (más de 6 horas) y sus usuarios anónimos.
create or replace function private.purge_stale_guests() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_n integer := 0;
begin
  for v_ws in select id from public.workspaces where is_demo and created_at < now() - interval '6 hours' loop
    perform private.purge_demo_workspace(v_ws);
    v_n := v_n + 1;
  end loop;
  if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'is_anonymous') then
    execute $q$delete from auth.users u where u.is_anonymous and u.created_at < now() - interval '6 hours'
               and not exists (select 1 from public.workspace_members m where m.user_id = u.id)$q$;
  end if;
  return v_n;
end $$;
revoke all on function private.purge_stale_guests() from public, anon, authenticated;

-- Datos inventados para que el invitado tenga algo que mirar.
create or replace function private.seed_demo(p_ws uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := private.ws_today(p_ws);
  v_kind text; v_m date; v_price numeric; v_half int;
  v_first text[] := array['Juan','María','Carlos','Laura','Diego','Sofía','Martín','Valentina','Pablo','Lucía','Federico','Camila','Nicolás','Florencia','Gustavo','Agustina','Hernán','Julieta','Sebastián','Paula'];
  v_last text[] := array['González','Rodríguez','Fernández','López','Martínez','Pérez','Gómez','Sánchez','Romero','Díaz','Álvarez','Torres','Ruiz','Ramírez','Flores','Acosta','Benítez','Medina','Herrera','Suárez'];
  v_custs uuid[] := '{}'; v_cid uuid; v_i int; v_start date; v_end date; v_space uuid; v_segs jsonb; v_quote jsonb; v_total numeric; v_pay jsonb; v_tries int; v_ok boolean;
  v_cat uuid;
begin
  -- Tarifas: desde el mes pasado hasta 4 meses adelante
  for v_kind in select unnest(array['carpa','sombrilla']) loop
    for v_m in select generate_series(date_trunc('month', v_today - 31), date_trunc('month', v_today + 120), interval '1 month')::date loop
      for v_half in 1..2 loop
        v_price := case extract(month from v_m) when 1 then 42000 when 2 then 38000 when 12 then 28000 else 18000 end;
        if v_kind = 'sombrilla' then v_price := round(v_price * 0.55 / 500) * 500; end if;
        perform public.set_rate(p_ws, v_kind, extract(year from v_m)::int, extract(month from v_m)::int, v_half::smallint, v_price);
      end loop;
    end loop;
  end loop;

  for v_i in 1..20 loop
    insert into public.customers (workspace_id, first_name, last_name, phone)
    values (p_ws, v_first[v_i], v_last[v_i], '+54 9 2255 ' || (400000 + v_i * 3137))
    returning id into v_cid;
    v_custs := v_custs || v_cid;
  end loop;

  perform public.open_cash_session(p_ws, 50000, 'Apertura de demostración');

  perform setseed(0.31);
  for v_i in 1..24 loop
    v_start := case when v_i <= 6 then v_today - (v_i % 4) when v_i <= 9 then v_today + 1 else v_today + 2 + floor(random() * 50)::int end;
    v_end := v_start + (array[1,3,5,7,7,10,15])[1 + floor(random() * 7)::int] - 1;
    if v_i in (1, 2) then v_end := v_today; end if;
    v_kind := case when v_i % 5 = 0 then 'sombrilla' else 'carpa' end;
    v_ok := false; v_tries := 0;
    for v_space in
      select s.id from public.spaces s where s.workspace_id = p_ws and s.active and s.kind = v_kind
        and not exists (select 1 from public.reservation_segments g where g.space_id = s.id and g.active and g.start_date <= v_end and g.end_date >= v_start)
      order by random()
    loop
      v_tries := v_tries + 1; exit when v_tries > 5;
      v_segs := jsonb_build_array(jsonb_build_object('space_id', v_space, 'start_date', v_start, 'end_date', v_end));
      v_quote := public.quote_reservation(p_ws, v_start, v_end, v_segs, '{}'::jsonb);
      v_total := coalesce((v_quote ->> 'total')::numeric, 0);
      v_pay := case
        when v_total <= 0 or v_i % 4 = 3 then null
        when v_i % 4 = 1 then jsonb_build_object('amount', floor(v_total * 0.3 / 1000) * 1000, 'method', 'efectivo', 'idempotency_key', gen_random_uuid())
        else jsonb_build_object('amount', v_total, 'method', case when v_i % 2 = 0 then 'transferencia' else 'efectivo' end, 'idempotency_key', gen_random_uuid())
      end;
      begin
        perform public.create_reservation_v2(p_ws, gen_random_uuid(), v_custs[1 + (v_i * 7) % 20], v_start, v_end, v_segs, '{}'::jsonb, null, v_pay);
        v_ok := true;
      exception when others then v_ok := false;
      end;
      exit when v_ok;
    end loop;
  end loop;

  select id into v_cat from public.expense_categories where workspace_id = p_ws and name = 'Limpieza';
  if v_cat is not null then
    perform public.register_expense(p_ws, gen_random_uuid(), 8500, v_today, 'Lavandina y trapos', v_cat, 'efectivo', null, null);
  end if;
  insert into public.day_notes (workspace_id, day, text) values
    (p_ws, v_today, 'Esto es una demostración: probá agregar, tildar o quitar notas'),
    (p_ws, v_today, 'Hoy viene el proveedor de hielo');
end $$;
revoke all on function private.seed_demo(uuid) from public, anon, authenticated;

-- Entrar como invitado: crea (o reutiliza) su balneario de demostración.
create or replace function public.start_guest_session() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_ws uuid;
  v_real public.workspaces%rowtype;
begin
  if v_user is null or not private.is_guest() then
    raise exception 'Esta opción es solo para entrar como invitado.' using errcode = '42501';
  end if;
  select m.workspace_id into v_ws from public.workspace_members m where m.user_id = v_user;
  if found then return v_ws; end if;

  select * into v_real from public.workspaces where not is_demo order by created_at limit 1;
  if not found then
    raise exception 'El modo invitado todavía no está disponible.';
  end if;
  perform private.purge_stale_guests();
  -- Evita que se creen demasiadas demostraciones al mismo tiempo.
  if (select count(*) from public.workspaces where is_demo) >= 50 then
    raise exception 'Hay muchos invitados en este momento. Probá de nuevo en un rato.';
  end if;

  insert into public.workspaces (name, subtitle, created_by, map_width, map_height, sea_side, latitude, longitude, timezone, is_demo)
  values ('Balneario de demostración', 'Modo invitado', v_user, v_real.map_width, v_real.map_height, v_real.sea_side,
          v_real.latitude, v_real.longitude, v_real.timezone, true)
  returning id into v_ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (v_ws, v_user, 'propietario');
  -- Mismo plano que el balneario real (carpas y caminos), sin ningún dato de clientes ni dinero.
  insert into public.spaces (workspace_id, kind, code, x, y, rotation)
    select v_ws, s.kind, s.code, s.x, s.y, s.rotation from public.spaces s where s.workspace_id = v_real.id and s.active;
  insert into public.map_features (workspace_id, kind, label, x, y, width, height, rotation, color, layer)
    select v_ws, f.kind, f.label, f.x, f.y, f.width, f.height, f.rotation, f.color, f.layer from public.map_features f where f.workspace_id = v_real.id and f.active;
  insert into public.expense_categories (workspace_id, name) values
    (v_ws, 'Proveedores e insumos'), (v_ws, 'Mantenimiento'), (v_ws, 'Reparaciones'), (v_ws, 'Limpieza'),
    (v_ws, 'Materiales y herramientas'), (v_ws, 'Otros gastos');
  insert into public.agreements (workspace_id, name, percent) values (v_ws, 'Parque Bonito', 30);
  insert into public.package_discounts (workspace_id, min_days, percent) values (v_ws, 5, 5), (v_ws, 7, 8), (v_ws, 15, 12), (v_ws, 30, 20);
  perform private.seed_demo(v_ws);
  return v_ws;
end $$;

-- Salir del modo invitado: se borra todo lo que cargó.
create or replace function public.end_guest_session() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_ws uuid;
begin
  if v_user is null or not private.is_guest() then
    raise exception 'Esta opción es solo para invitados.' using errcode = '42501';
  end if;
  for v_ws in select m.workspace_id from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
              where m.user_id = v_user and w.is_demo loop
    perform private.purge_demo_workspace(v_ws);
  end loop;
  delete from public.user_preferences where user_id = v_user;
  perform private.purge_stale_guests();
end $$;

revoke all on function public.start_guest_session(), public.end_guest_session() from public, anon;
grant execute on function public.start_guest_session(), public.end_guest_session() to authenticated;

commit;
