-- ACTUALIZACIÓN 0021 · Restaurar copias de seguridad + corrección de la lista de usuarios.
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0020).
begin;
-- =====================================================================
-- 0021 · Restaurar una copia de seguridad desde la página.
--   · Solo el propietario, escribiendo RESTAURAR para confirmar.
--   · Antes de restaurar se guarda automáticamente una copia del estado actual
--     (así se puede volver atrás).
--   · Se reemplazan los datos del balneario (clientes, reservas, pagos, caja, tarifas,
--     plano…) por los de la copia. El historial de cambios NO se borra: se agrega
--     un registro de la restauración. Usuarios y configuración quedan como están.
--   · Las copias ahora incluyen también vouchers y notas del día.
-- =====================================================================

create or replace function private.restoring(p_ws text) returns boolean
language sql stable as $$
  select p_ws is not null and p_ws = nullif(current_setting('app.restore_ws', true), '')
$$;

CREATE OR REPLACE FUNCTION private.audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $fn$
declare
  v_ws uuid;
  v_id uuid;
begin
  -- Restauración de una copia: los datos ya fueron validados cuando se cargaron.
  if private.restoring(coalesce(to_jsonb(new), to_jsonb(old)) ->> 'workspace_id') then return null; end if;
  if tg_op = 'DELETE' then
    v_ws := (to_jsonb(old) ->> 'workspace_id')::uuid;
    v_id := (to_jsonb(old) ->> 'id')::uuid;
  else
    v_ws := (to_jsonb(new) ->> 'workspace_id')::uuid;
    v_id := (to_jsonb(new) ->> 'id')::uuid;
  end if;
  if tg_table_name = 'workspaces' then
    v_ws := coalesce(v_ws, v_id);
  end if;

  insert into public.audit_log (workspace_id, table_name, row_id, action, old_data, new_data, reason, actor_id, actor_email)
  values (
    v_ws, tg_table_name, v_id,
    case tg_op when 'INSERT' then 'alta' when 'UPDATE' then 'modificacion' else 'baja' end,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
    nullif(current_setting('app.reason', true), ''),
    auth.uid(),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
  );
  return null;
end $fn$;

CREATE OR REPLACE FUNCTION private.segments_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $fn$
declare v_msg text;
begin
  -- Restauración de una copia: los datos ya fueron validados cuando se cargaron.
  if tg_op = 'INSERT' and private.restoring(to_jsonb(new) ->> 'workspace_id') then return new; end if;
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

CREATE OR REPLACE FUNCTION private.maintenance_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $fn$
declare v_msg text;
begin
  -- Restauración de una copia: los datos ya fueron validados cuando se cargaron.
  if tg_op = 'INSERT' and private.restoring(to_jsonb(new) ->> 'workspace_id') then return new; end if;
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
end $fn$;

CREATE OR REPLACE FUNCTION private.cash_movements_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $fn$
begin
  -- Restauración de una copia: los datos ya fueron validados cuando se cargaron.
  if tg_op = 'INSERT' and private.restoring(to_jsonb(new) ->> 'workspace_id') then return new; end if;
  if exists (select 1 from public.cash_sessions s where s.id = new.cash_session_id and s.closed_at is not null) then
    raise exception 'La caja ya está cerrada; no se pueden agregar movimientos.' using errcode = '42501';
  end if;
  return new;
end $fn$;

create or replace function private.snapshot(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb := '{}'::jsonb;
  t text;
  v_rows jsonb;
begin
  foreach t in array array[
    'spaces','map_features','customers','agreements','expense_categories','package_discounts','rates',
    'reservations','reservation_changes','reservation_segments','reservation_charges','reservation_discounts',
    'maintenance_blocks','cash_sessions','payments','expenses','cash_movements','restaurant_vouchers','day_notes',
    'workspace_members','audit_log'
  ] loop
    -- (antes el alias "x" chocaba con la columna x de carpas y elementos del plano)
    execute format('select coalesce(jsonb_agg(to_jsonb(snap_row)), ''[]''::jsonb) from public.%I as snap_row where snap_row.workspace_id = $1', t)
      into v_rows using p_ws;
    v := v || jsonb_build_object(t, v_rows);
  end loop;
  select v || jsonb_build_object('workspace', to_jsonb(w) - 'logo_data') into v from public.workspaces w where w.id = p_ws;
  return v;
end $$;

-- Tablas que se restauran, en orden (primero las que otras necesitan).
create or replace function private.restore_tables() returns text[]
language sql immutable as $$
  select array['spaces','map_features','customers','agreements','expense_categories','package_discounts','rates',
               'reservations','reservation_changes','reservation_segments','reservation_charges','reservation_discounts',
               'maintenance_blocks','cash_sessions','payments','expenses','cash_movements','restaurant_vouchers','day_notes']
$$;

create or replace function public.restore_backup(p_backup_id uuid, p_confirm text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_b public.backups%rowtype;
  v_safety jsonb;
  t text;
  v_cols text;
  v_rows jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_n integer;
  i integer;
  v_tables text[] := private.restore_tables();
  v_keep text[] := '{}';
begin
  select * into v_b from public.backups where id = p_backup_id;
  if not found then
    raise exception 'La copia no existe.';
  end if;
  perform private.require_member(v_b.workspace_id, array['propietario']);
  if coalesce(btrim(p_confirm), '') <> 'RESTAURAR' then
    raise exception 'Para confirmar escribí RESTAURAR en mayúsculas.';
  end if;

  -- Nadie más trabaja en este balneario mientras se restaura.
  perform pg_advisory_xact_lock(hashtextextended('restaurar:' || v_b.workspace_id::text, 0));
  perform 1 from public.workspaces where id = v_b.workspace_id for update;

  -- 1. Copia del estado actual, para poder volver atrás.
  v_safety := public.create_backup(v_b.workspace_id, 'manual',
    'Automática antes de restaurar la copia del ' || to_char(v_b.created_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI'));

  -- Copias hechas antes de esta actualización guardaban mal carpas y plano (solo un número):
  -- en ese caso esas dos tablas se dejan como están hoy.
  foreach t in array v_tables loop
    v_rows := coalesce(v_b.data -> t, '[]'::jsonb);
    if jsonb_typeof(v_rows) <> 'array' or (jsonb_array_length(v_rows) > 0 and jsonb_typeof(v_rows -> 0) <> 'object') then
      v_keep := v_keep || t;
    end if;
  end loop;

  -- 2. Se quitan los datos actuales (en orden inverso).
  perform set_config('app.purge_ws', v_b.workspace_id::text, true);
  perform set_config('app.restore_ws', v_b.workspace_id::text, true);
  for i in reverse array_length(v_tables, 1)..1 loop
    continue when v_tables[i] = any(v_keep);
    execute format('delete from public.%I where workspace_id = $1', v_tables[i]) using v_b.workspace_id;
  end loop;

  -- 3. Se cargan los de la copia (solo las columnas que existen hoy; las calculadas se recalculan).
  foreach t in array v_tables loop
    v_rows := coalesce(v_b.data -> t, '[]'::jsonb);
    if t = any(v_keep) then
      v_counts := v_counts || jsonb_build_object(t, 'sin cambios');
      continue;
    end if;
    if jsonb_array_length(v_rows) = 0 then
      v_counts := v_counts || jsonb_build_object(t, 0);
      continue;
    end if;
    select string_agg(format('%I', c.column_name), ', ' order by c.ordinal_position) into v_cols
    from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = t and c.is_generated <> 'ALWAYS'
      and (v_rows -> 0) ? c.column_name;
    execute format('insert into public.%I (%s) overriding system value select %s from jsonb_populate_recordset(null::public.%I, $1) as snap_row where snap_row.workspace_id = $2',
                   t, v_cols, v_cols, t) using v_rows, v_b.workspace_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object(t, v_n);
  end loop;

  perform set_config('app.purge_ws', '', true);
  perform set_config('app.restore_ws', '', true);

  -- 4. Queda registrado en el historial (que no se borra nunca).
  insert into public.audit_log (workspace_id, table_name, row_id, action, old_data, new_data, reason, actor_id, actor_email)
  values (v_b.workspace_id, 'backups', v_b.id, 'modificacion', null,
          jsonb_build_object('restaurada', v_b.created_at, 'copia_previa', v_safety ->> 'backup_id', 'counts', v_counts),
          'Restauración de una copia de seguridad', auth.uid(),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email');

  return jsonb_build_object('restaurada', true, 'counts', v_counts, 'copia_previa', v_safety ->> 'backup_id');
end $$;

revoke all on function public.restore_backup(uuid, text) from public, anon;
grant execute on function public.restore_backup(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Corrección: la lista de usuarios fallaba ("structure of query does not match
-- function result type") porque en Supabase el correo se guarda como varchar.
-- ---------------------------------------------------------------------
create or replace function public.workspace_users(p_workspace_id uuid)
returns table (user_id uuid, role text, email text, username text, created_at timestamptz, is_me boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id);
  return query
    select m.user_id, m.role::text,
           (case when u.email like '%@usuarios.balneario.invalid' then null else u.email end)::text,
           l.username::text, m.created_at, m.user_id = auth.uid()
    from public.workspace_members m
    join auth.users u on u.id = m.user_id
    left join public.user_logins l on l.user_id = m.user_id
    where m.workspace_id = p_workspace_id
    order by m.created_at;
end $$;

commit;
