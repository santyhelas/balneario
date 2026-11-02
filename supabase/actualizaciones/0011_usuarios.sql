-- ACTUALIZACIÓN 0011 · Ingreso con usuario y gestión de usuarios.
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0010).
begin;
-- =====================================================================
-- 0011 · Ingreso con nombre de usuario y gestión de usuarios.
--   · Cada cuenta puede tener un "usuario" para ingresar (ej. "santi").
--   · Las cuentas creadas solo con usuario usan internamente un correo
--     técnico que nunca recibe mensajes.
--   · La búsqueda usuario → cuenta solo la puede hacer el servidor
--     (clave secreta), nunca el navegador.
-- =====================================================================

do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;

create table public.user_logins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique check (username ~ '^[a-z0-9][a-z0-9._-]{2,29}$'),
  login_email text not null,
  created_at  timestamptz not null default now()
);

alter table public.user_logins enable row level security;
-- Sin políticas: el navegador no puede leerla. Solo el servidor (service_role).
revoke all on public.user_logins from anon, authenticated;
grant select, insert, update, delete on public.user_logins to service_role;

create or replace function private.normalize_username(p text) returns text
language sql immutable as $$ select lower(btrim(coalesce(p, ''))) $$;

-- ---------------------------------------------------------------------
-- Para el servidor (service_role)
-- ---------------------------------------------------------------------

-- Correo de ingreso de un usuario (para iniciar sesión con usuario + contraseña).
create or replace function public.login_email_for(p_username text) returns text
language sql stable security definer set search_path = '' as $$
  select login_email from public.user_logins where username = private.normalize_username(p_username)
$$;

-- ¿Ya se creó el balneario? (si no, se permite crear la primera cuenta desde el inicio de sesión)
create or replace function public.setup_done() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspaces)
$$;

-- Registra el usuario de una cuenta recién creada y, si corresponde, le da acceso al balneario.
create or replace function public.register_login(
  p_user_id uuid, p_username text, p_login_email text, p_workspace_id uuid default null, p_role text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_user text := private.normalize_username(p_username);
begin
  if v_user !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then
    raise exception 'El usuario debe tener entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo.';
  end if;
  insert into public.user_logins (user_id, username, login_email) values (p_user_id, v_user, p_login_email);
  if p_workspace_id is not null then
    if p_role not in ('administrador','operador') then
      raise exception 'Rol inválido.';
    end if;
    insert into public.workspace_members (workspace_id, user_id, role, email)
    values (p_workspace_id, p_user_id, p_role, null);
  end if;
end $$;

revoke all on function public.login_email_for(text), public.setup_done(),
  public.register_login(uuid, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.login_email_for(text), public.setup_done(),
  public.register_login(uuid, text, text, uuid, text) to service_role;
grant usage on schema private to service_role;
grant execute on function private.normalize_username(text) to service_role, authenticated;

-- ---------------------------------------------------------------------
-- Para los usuarios con sesión iniciada
-- ---------------------------------------------------------------------

-- Elegir o cambiar el propio usuario para ingresar.
create or replace function public.set_my_username(p_username text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_user text := private.normalize_username(p_username);
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'Tenés que iniciar sesión.' using errcode = '28000';
  end if;
  if v_user !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then
    raise exception 'El usuario debe tener entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo.';
  end if;
  if exists (select 1 from public.user_logins where username = v_user and user_id <> auth.uid()) then
    raise exception 'Ese usuario ya está en uso. Elegí otro.';
  end if;
  select email into v_email from auth.users where id = auth.uid();
  insert into public.user_logins (user_id, username, login_email) values (auth.uid(), v_user, v_email)
  on conflict (user_id) do update set username = excluded.username;
  return v_user;
end $$;

create or replace function public.my_username() returns text
language sql stable security definer set search_path = '' as $$
  select username from public.user_logins where user_id = auth.uid()
$$;

-- Usuarios con acceso al balneario (con su usuario de ingreso).
create or replace function public.workspace_users(p_workspace_id uuid)
returns table (user_id uuid, role text, email text, username text, created_at timestamptz, is_me boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id);
  return query
    select m.user_id, m.role,
           case when u.email like '%@usuarios.balneario.invalid' then null else u.email end,
           l.username, m.created_at, m.user_id = auth.uid()
    from public.workspace_members m
    join auth.users u on u.id = m.user_id
    left join public.user_logins l on l.user_id = m.user_id
    where m.workspace_id = p_workspace_id
    order by m.created_at;
end $$;

-- Cambiar el rol de otro usuario (solo el propietario).
create or replace function public.set_member_role(p_workspace_id uuid, p_user_id uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id, array['propietario']);
  if p_user_id = auth.uid() then
    raise exception 'No podés cambiar tu propio rol.';
  end if;
  if p_role not in ('administrador','operador') then
    raise exception 'Rol inválido.';
  end if;
  update public.workspace_members set role = p_role
  where workspace_id = p_workspace_id and user_id = p_user_id and role <> 'propietario';
  if not found then
    raise exception 'Ese usuario no existe o es el propietario.';
  end if;
end $$;

-- Quitar el acceso de un usuario (propietario o administrador; nunca al propietario ni a uno mismo).
create or replace function public.remove_member(p_workspace_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  if p_user_id = auth.uid() then
    raise exception 'No podés quitarte el acceso a vos mismo.';
  end if;
  delete from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id and role <> 'propietario';
  if not found then
    raise exception 'Ese usuario no existe o es el propietario.';
  end if;
end $$;

revoke all on function public.set_my_username(text), public.my_username(), public.workspace_users(uuid),
  public.set_member_role(uuid, uuid, text), public.remove_member(uuid, uuid) from public, anon;
grant execute on function public.set_my_username(text), public.my_username(), public.workspace_users(uuid),
  public.set_member_role(uuid, uuid, text), public.remove_member(uuid, uuid) to authenticated;
commit;
