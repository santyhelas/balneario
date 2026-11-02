-- =====================================================================
-- 0008 · Distribución real del Parador Eólico.
--   · Inventario según el plano: 79 carpas (01–79) y 10 sombrillas (80–89).
--   · Mapa con el parador arriba, pasarelas, juegos y el mar abajo.
--   · "Diseño Parador": vuelve a ubicar todo según el plano oficial.
--   · Mensajes con "Carpa 17" / "Sombrilla 80" en lugar del código suelto.
-- =====================================================================

create or replace function private.space_label(p_kind text, p_code text) returns text
language sql immutable as $$
  select case p_kind when 'sombrilla' then 'Sombrilla ' else 'Carpa ' end || p_code
$$;
grant execute on function private.space_label(text, text) to authenticated;

create or replace function private.space_conflict(
  p_space_id uuid, p_start date, p_end date, p_ignore_reservation uuid default null
) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_space public.spaces%rowtype;
  v_msg text;
begin
  select * into v_space from public.spaces where id = p_space_id;
  if not found then
    return 'El espacio no existe.';
  end if;
  if not v_space.active then
    return format('%s está desactivada.', private.space_label(v_space.kind, v_space.code));
  end if;

  select format('%s está en mantenimiento del %s al %s (%s).', private.space_label(v_space.kind, v_space.code),
                to_char(m.start_date, 'DD/MM/YYYY'), to_char(m.end_date, 'DD/MM/YYYY'), m.reason)
    into v_msg
  from public.maintenance_blocks m
  where m.space_id = p_space_id and m.active
    and daterange(m.start_date, m.end_date, '[]') && daterange(p_start, p_end, '[]')
  order by m.start_date limit 1;
  if v_msg is not null then return v_msg; end if;

  select format('%s está ocupada del %s al %s por la reserva #%s (%s).', private.space_label(v_space.kind, v_space.code),
                to_char(greatest(s.start_date, p_start), 'DD/MM/YYYY'),
                to_char(least(s.end_date, p_end), 'DD/MM/YYYY'),
                r.number, btrim(c.first_name || ' ' || c.last_name))
    into v_msg
  from public.reservation_segments s
  join public.reservations r on r.id = s.reservation_id
  join public.customers c on c.id = r.customer_id
  where s.space_id = p_space_id and s.active
    and (p_ignore_reservation is null or s.reservation_id <> p_ignore_reservation)
    and daterange(s.start_date, s.end_date, '[]') && daterange(p_start, p_end, '[]')
  order by s.start_date limit 1;
  return v_msg;
end $$;

create or replace function private.segments_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_msg text;
begin
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
end $$;

create or replace function private.maintenance_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_msg text;
begin
  if tg_op = 'UPDATE' and new.space_id <> old.space_id then
    raise exception 'No se puede cambiar el espacio de un mantenimiento. Finalizalo y creá otro.';
  end if;
  if new.active then
    perform private.lock_spaces(array[new.space_id]);
    if not (select sp.active from public.spaces sp where sp.id = new.space_id) then
      raise exception 'El espacio está desactivado.';
    end if;
    select string_agg(format('reserva #%s de %s (%s al %s)', r.number,
                             btrim(c.first_name || ' ' || c.last_name),
                             to_char(greatest(s.start_date, new.start_date), 'DD/MM/YYYY'),
                             to_char(least(s.end_date, new.end_date), 'DD/MM/YYYY')), '; ' order by s.start_date)
      into v_msg
    from public.reservation_segments s
    join public.reservations r on r.id = s.reservation_id
    join public.customers c on c.id = r.customer_id
    where s.space_id = new.space_id and s.active
      and daterange(s.start_date, s.end_date, '[]') && daterange(new.start_date, new.end_date, '[]');
    if v_msg is not null then
      raise exception 'El mantenimiento choca con: %. Primero cambiá de carpa a esos clientes.', v_msg
        using errcode = '23P01', hint = 'CONFLICTO_MANTENIMIENTO';
    end if;
  end if;
  return new;
end $$;

create or replace function private.spaces_deactivation_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_msg text;
begin
  if old.active and not new.active then
    perform private.lock_spaces(array[new.id]);
    select string_agg(format('#%s (%s al %s)', r.number, to_char(s.start_date, 'DD/MM/YYYY'),
                             to_char(s.end_date, 'DD/MM/YYYY')), ', ' order by s.start_date)
      into v_msg
    from public.reservation_segments s
    join public.reservations r on r.id = s.reservation_id
    where s.space_id = new.id and s.active and s.end_date >= private.ws_today(new.workspace_id);
    if v_msg is not null then
      raise exception 'No se puede desactivar %: tiene reservas pendientes %. Cambialas de carpa primero.', private.space_label(new.kind, new.code), v_msg;
    end if;
  end if;
  return new;
end $$;

-- Plano oficial (coordenadas = centro de cada espacio en el mapa de 3050 × 2300)
create or replace function private.parador_spaces()
returns table (code text, kind text, x numeric, y numeric)
language sql immutable as $$
  select * from (values
    ('01','carpa',2873,1739),
    ('02','carpa',2776,1739),
    ('03','carpa',2167,1739),
    ('04','carpa',2070,1739),
    ('05','carpa',1969,1739),
    ('06','carpa',1350,1739),
    ('07','carpa',1249,1739),
    ('08','carpa',929,1739),
    ('09','carpa',234,1739),
    ('10','carpa',133,1739),
    ('11','carpa',194,1642),
    ('12','carpa',194,1548),
    ('13','carpa',194,1458),
    ('14','carpa',194,1368),
    ('15','carpa',194,1278),
    ('16','carpa',194,1188),
    ('17','carpa',194,1098),
    ('18','carpa',194,1008),
    ('19','carpa',194,922),
    ('20','carpa',306,821),
    ('21','carpa',407,821),
    ('22','carpa',508,821),
    ('23','carpa',608,821),
    ('24','carpa',709,821),
    ('25','carpa',925,922),
    ('26','carpa',925,1008),
    ('27','carpa',925,1098),
    ('28','carpa',925,1188),
    ('29','carpa',925,1278),
    ('30','carpa',925,1368),
    ('31','carpa',925,1458),
    ('32','carpa',925,1548),
    ('33','carpa',925,1642),
    ('34','carpa',1292,1642),
    ('35','carpa',1292,1548),
    ('36','carpa',1292,1458),
    ('37','carpa',1292,1368),
    ('38','carpa',1292,1278),
    ('39','carpa',1292,1188),
    ('40','carpa',1292,1098),
    ('41','carpa',1292,1008),
    ('42','carpa',1292,922),
    ('43','carpa',1472,821),
    ('44','carpa',1573,821),
    ('45','carpa',1674,821),
    ('46','carpa',1775,821),
    ('47','carpa',1876,821),
    ('48','carpa',2012,922),
    ('49','carpa',2012,1008),
    ('50','carpa',2012,1098),
    ('51','carpa',2012,1188),
    ('52','carpa',2012,1278),
    ('53','carpa',2012,1368),
    ('54','carpa',2012,1458),
    ('55','carpa',2012,1548),
    ('56','carpa',2012,1642),
    ('57','carpa',2128,1642),
    ('58','carpa',2128,1548),
    ('59','carpa',2128,1458),
    ('60','carpa',2128,1368),
    ('61','carpa',2128,1278),
    ('62','carpa',2128,1188),
    ('63','carpa',2128,1098),
    ('64','carpa',2128,1008),
    ('65','carpa',2128,922),
    ('66','carpa',2300,821),
    ('67','carpa',2401,821),
    ('68','carpa',2502,821),
    ('69','carpa',2603,821),
    ('70','carpa',2704,821),
    ('71','carpa',2830,922),
    ('72','carpa',2830,1008),
    ('73','carpa',2830,1098),
    ('74','carpa',2830,1188),
    ('75','carpa',2830,1278),
    ('76','carpa',2830,1368),
    ('77','carpa',2830,1458),
    ('78','carpa',2830,1548),
    ('79','carpa',2830,1642),
    ('80','sombrilla',2599,1739),
    ('81','sombrilla',2405,1739),
    ('82','sombrilla',1764,1739),
    ('83','sombrilla',1562,1739),
    ('84','sombrilla',688,1739),
    ('85','sombrilla',482,1739),
    ('86','sombrilla',1134,1469),
    ('87','sombrilla',1134,1310),
    ('88','sombrilla',1134,1152),
    ('89','sombrilla',1134,997)
  ) v(code, kind, x, y)
$$;

create or replace function private.parador_features()
returns table (kind text, label text, x numeric, y numeric, width numeric, height numeric, color text)
language sql immutable as $$
  select * from (values
    ('instalacion','Parador',1062,414,1296,432,'#a8661b'),
    ('instalacion','Bar',774,324,288,288,'#f08c1a'),
    ('instalacion','Oficina',1274,364,87,237,'#f08c1a'),
    ('instalacion','Duchas',1386,364,116,237,'#f08c1a'),
    ('instalacion','Baños',1516,364,123,237,'#f08c1a'),
    ('instalacion','Baños públicos',1793,274,144,101,'#f08c1a'),
    ('area_comun','Cancha de vóley',243,426,234,263,'#d9b77e'),
    ('instalacion','Normas IRAM/ISO · Calidad en playa',2412,369,684,284,'#a8661b'),
    ('camino','Pasarela',1512,744,2484,33,'#9a6a34'),
    ('camino',null,785,68,518,29,'#9a6a34'),
    ('camino',null,1030,396,29,684,'#9a6a34'),
    ('camino',null,816,857,33,194,'#9a6a34'),
    ('camino',null,1060,1298,32,1076,'#9a6a34'),
    ('camino',null,1392,857,33,194,'#9a6a34'),
    ('camino',null,588,1300,33,727,'#9a6a34'),
    ('camino',null,1629,1300,32,727,'#9a6a34'),
    ('camino',null,1910,857,32,194,'#9a6a34'),
    ('camino',null,2226,857,33,194,'#9a6a34'),
    ('camino',null,2446,1300,32,727,'#9a6a34'),
    ('area_comun','Juegos infantiles',588,1278,371,252,'#e9c98f'),
    ('area_comun','Juegos infantiles',1638,1278,360,252,'#e9c98f')
  ) v(kind, label, x, y, width, height, color)
$$;

-- Dibuja el plano (caminos, parador, juegos) y ubica los espacios existentes
-- cuyo código figura en el plano. No crea ni borra carpas.
create or replace function public.apply_parador_layout(p_workspace_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_moved integer;
  v_ws public.workspaces%rowtype;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  perform set_config('app.reason', 'Diseño Parador', true);

  select * into v_ws from public.workspaces where id = p_workspace_id for update;
  update public.workspaces set map_width = 3050, map_height = 2300, sea_side = 'bottom', version = version + 1
  where id = p_workspace_id;

  update public.spaces s set x = p.x, y = p.y, rotation = 0, version = s.version + 1
  from private.parador_spaces() p
  where s.workspace_id = p_workspace_id and s.code = p.code and s.kind = p.kind;
  get diagnostics v_moved = row_count;

  update public.map_features set active = false, version = version + 1
  where workspace_id = p_workspace_id and active;
  insert into public.map_features (workspace_id, kind, label, x, y, width, height, color)
  select p_workspace_id, f.kind, f.label, f.x, f.y, f.width, f.height, f.color from private.parador_features() f;

  return jsonb_build_object('espacios_ubicados', v_moved);
end $$;

revoke all on function public.apply_parador_layout(uuid) from public, anon;
grant execute on function public.apply_parador_layout(uuid) to authenticated;

-- Alta de balneario (instalaciones nuevas): inventario y plano del Parador.
create or replace function public.create_workspace(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_user uuid := auth.uid();
  v_email text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email';
begin
  if v_user is null then
    raise exception 'Tenés que iniciar sesión.' using errcode = '28000';
  end if;
  if exists (select 1 from public.workspace_members where user_id = v_user) then
    raise exception 'Tu cuenta ya pertenece a un balneario.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('alta-balneario', 0));
  if exists (select 1 from public.workspaces) then
    raise exception 'El balneario ya fue creado. Pedile al propietario que te invite.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'Ingresá el nombre del balneario.';
  end if;

  insert into public.workspaces (name, created_by, map_width, map_height, sea_side, latitude, longitude)
  values (btrim(p_name), v_user, 3050, 2300, 'bottom', -37.263900, -56.973100)
  returning id into v_ws;
  insert into public.workspace_members (workspace_id, user_id, role, email) values (v_ws, v_user, 'propietario', v_email);

  insert into public.spaces (workspace_id, kind, code, x, y)
  select v_ws, p.kind, p.code, p.x, p.y from private.parador_spaces() p order by p.code;

  insert into public.map_features (workspace_id, kind, label, x, y, width, height, color)
  select v_ws, f.kind, f.label, f.x, f.y, f.width, f.height, f.color from private.parador_features() f;

  insert into public.expense_categories (workspace_id, name) values
    (v_ws, 'Proveedores e insumos'), (v_ws, 'Mantenimiento'), (v_ws, 'Reparaciones'),
    (v_ws, 'Limpieza'), (v_ws, 'Materiales y herramientas'), (v_ws, 'Personal'),
    (v_ws, 'Servicios'), (v_ws, 'Otros gastos');

  insert into public.agreements (workspace_id, name, percent) values (v_ws, 'Parque Bonito', 30);
  insert into public.user_preferences (user_id) values (v_user) on conflict (user_id) do nothing;
  return v_ws;
end $$;

-- ---------------------------------------------------------------------
-- Conversión única de balnearios ya creados con el inventario provisorio
-- (C01–C90, S01–S10). Solo se hace si todavía no hay reservas ni
-- mantenimientos cargados; si los hay, no se toca nada.
-- ---------------------------------------------------------------------
do $$
declare
  w record;
begin
  for w in select id from public.workspaces loop
    if not exists (select 1 from public.reservation_segments s join public.spaces sp on sp.id = s.space_id where sp.workspace_id = w.id)
       and not exists (select 1 from public.maintenance_blocks m where m.workspace_id = w.id)
       and exists (select 1 from public.spaces where workspace_id = w.id and code = 'C01')
       and not exists (select 1 from public.spaces where workspace_id = w.id and code = '01') then
      alter table public.spaces disable trigger spaces_no_delete;
      delete from public.spaces where workspace_id = w.id;
      alter table public.spaces enable trigger spaces_no_delete;
      insert into public.spaces (workspace_id, kind, code, x, y)
      select w.id, p.kind, p.code, p.x, p.y from private.parador_spaces() p order by p.code;
      update public.workspaces set map_width = 3050, map_height = 2300, sea_side = 'bottom',
             latitude = coalesce(latitude, -37.263900), longitude = coalesce(longitude, -56.973100),
             version = version + 1
      where id = w.id;
      insert into public.map_features (workspace_id, kind, label, x, y, width, height, color)
      select w.id, f.kind, f.label, f.x, f.y, f.width, f.height, f.color from private.parador_features() f;
    end if;
    insert into public.expense_categories (workspace_id, name)
    select w.id, n from (values ('Personal'), ('Servicios')) v(n)
    where not exists (select 1 from public.expense_categories c where c.workspace_id = w.id and lower(c.name) = lower(n));
  end loop;
end $$;
