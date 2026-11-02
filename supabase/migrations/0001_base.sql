-- =====================================================================
-- 0001 · Base: extensiones, balnearios (espacios de trabajo), miembros,
--        preferencias de usuario, auditoría y control de versiones.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- Esquema privado: funciones auxiliares que no se exponen por la API.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------
-- Usuario actual (compatible con Supabase Auth)
-- ---------------------------------------------------------------------
create or replace function private.current_user_id() returns uuid
language sql stable as $$
  select auth.uid()
$$;

create or replace function private.current_user_email() returns text
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
$$;

-- ---------------------------------------------------------------------
-- Balnearios
-- ---------------------------------------------------------------------
create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  timezone    text not null default 'America/Argentina/San_Juan',
  latitude    numeric(9,6) check (latitude between -90 and 90),
  longitude   numeric(9,6) check (longitude between -180 and 180),
  logo_path   text,
  map_width   integer not null default 2000 check (map_width between 400 and 20000),
  map_height  integer not null default 1200 check (map_height between 300 and 20000),
  sea_side    text not null default 'top' check (sea_side in ('top','bottom','left','right')),
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  created_by  uuid
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('propietario','administrador','operador')),
  email        text,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members(user_id);

-- ---------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------
create or replace function private.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
  )
$$;

create or replace function private.has_role(ws uuid, roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid() and m.role = any(roles)
  )
$$;

-- Lanza un error si el usuario no pertenece al balneario (o no tiene el rol).
create or replace function private.require_member(ws uuid, roles text[] default null) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Tenés que iniciar sesión.' using errcode = '28000';
  end if;
  if ws is null or not exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
      and (roles is null or m.role = any(roles))
  ) then
    raise exception 'No tenés permiso para realizar esta operación en este balneario.' using errcode = '42501';
  end if;
end $$;

-- Fecha de hoy según la zona horaria del balneario.
create or replace function private.ws_today(ws uuid) returns date
language sql stable security definer set search_path = '' as $$
  select (now() at time zone w.timezone)::date from public.workspaces w where w.id = ws
$$;

grant execute on function private.is_member(uuid), private.has_role(uuid, text[]),
  private.require_member(uuid, text[]), private.ws_today(uuid),
  private.current_user_id(), private.current_user_email() to authenticated;

-- ---------------------------------------------------------------------
-- Control de concurrencia optimista
-- Toda modificación debe enviar version = versión_leída + 1.
-- Si otro dispositivo modificó el registro antes, la operación se rechaza
-- en lugar de sobrescribir silenciosamente.
-- ---------------------------------------------------------------------
create or replace function private.check_version() returns trigger
language plpgsql as $$
begin
  if new.version is distinct from old.version + 1 then
    raise exception 'Este dato fue modificado desde otro dispositivo. Recargá la pantalla e intentá de nuevo.'
      using errcode = '40001', hint = 'CONFLICTO_VERSION';
  end if;
  return new;
end $$;

create trigger workspaces_version before update on public.workspaces
  for each row execute function private.check_version();

create or replace function private.validate_timezone() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Zona horaria inválida: %', new.timezone;
  end if;
  return new;
end $$;

create trigger workspaces_timezone before insert or update of timezone on public.workspaces
  for each row execute function private.validate_timezone();

-- ---------------------------------------------------------------------
-- Auditoría: cada alta, modificación o baja queda registrada con
-- estado anterior, estado posterior, usuario, fecha y motivo.
-- ---------------------------------------------------------------------
create table public.audit_log (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null,
  table_name   text not null,
  row_id       uuid,
  action       text not null check (action in ('alta','modificacion','baja')),
  old_data     jsonb,
  new_data     jsonb,
  reason       text,
  actor_id     uuid,
  actor_email  text,
  at           timestamptz not null default now()
);
create index audit_log_ws_at_idx on public.audit_log(workspace_id, at desc);
create index audit_log_row_idx on public.audit_log(workspace_id, table_name, row_id);

create or replace function private.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_id uuid;
begin
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
end $$;

create trigger workspaces_audit after insert or update or delete on public.workspaces
  for each row execute function private.audit();

-- ---------------------------------------------------------------------
-- Registros inmutables (pagos, movimientos de caja, historial)
-- ---------------------------------------------------------------------
create or replace function private.forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception 'Este registro no se puede modificar ni borrar. Las correcciones se hacen con una anulación.'
    using errcode = '42501';
end $$;

create trigger audit_log_immutable before update or delete on public.audit_log
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------
-- Preferencias de cada usuario (se sincronizan entre dispositivos)
-- ---------------------------------------------------------------------
create table public.user_preferences (
  user_id          uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  theme            text not null default 'sistema' check (theme in ('claro','oscuro','sistema')),
  temperature_unit text not null default 'C' check (temperature_unit in ('C','F')),
  avatar_path      text,
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Seguridad a nivel de fila
-- ---------------------------------------------------------------------
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.audit_log         enable row level security;
alter table public.user_preferences  enable row level security;

create policy "miembros ven su balneario" on public.workspaces
  for select to authenticated using (private.is_member(id));
create policy "administradores editan su balneario" on public.workspaces
  for update to authenticated
  using (private.has_role(id, array['propietario','administrador']))
  with check (private.has_role(id, array['propietario','administrador']));

create policy "miembros ven a los miembros" on public.workspace_members
  for select to authenticated using (private.is_member(workspace_id));

create policy "miembros ven el historial" on public.audit_log
  for select to authenticated using (private.is_member(workspace_id));

create policy "cada usuario ve sus preferencias" on public.user_preferences
  for select to authenticated using (user_id = auth.uid());
create policy "cada usuario crea sus preferencias" on public.user_preferences
  for insert to authenticated with check (user_id = auth.uid());
create policy "cada usuario edita sus preferencias" on public.user_preferences
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.workspaces, public.workspace_members, public.audit_log, public.user_preferences from anon;
revoke insert, update, delete on public.workspaces from authenticated;
revoke insert, update, delete on public.workspace_members from authenticated;
revoke insert, update, delete on public.audit_log from authenticated;
grant select on public.workspaces to authenticated;
grant update (name, timezone, latitude, longitude, logo_path, map_width, map_height, sea_side, version)
  on public.workspaces to authenticated;
grant select on public.workspace_members, public.audit_log to authenticated;
revoke all on public.user_preferences from authenticated;
grant select, insert, update on public.user_preferences to authenticated;
