-- =====================================================================
-- 0024 · Copias automáticas en Google Drive.
--   · El propietario conecta su Google Drive (solo con permiso para los
--     archivos que crea la página). El permiso se guarda cifrado y solo lo
--     usa el servidor: el navegador nunca lo ve.
--   · Todos los días se sube una copia; se conservan las últimas 30.
-- =====================================================================
create table private.drive_links (
  workspace_id    uuid primary key references public.workspaces(id) on delete cascade,
  token_enc       text not null,
  folder_id       text,
  connected_by    uuid,
  connected_email text,
  connected_at    timestamptz not null default now(),
  last_ok_at      timestamptz,
  last_file_name  text,
  last_error      text,
  last_error_at   timestamptz
);
alter table private.drive_links enable row level security;
revoke all on private.drive_links from public, anon, authenticated;

-- Estado visible para los usuarios del balneario (sin el permiso cifrado).
create or replace function public.drive_status(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v private.drive_links%rowtype;
begin
  perform private.require_member(p_workspace_id);
  select * into v from private.drive_links where workspace_id = p_workspace_id;
  if not found then return jsonb_build_object('conectado', false); end if;
  return jsonb_build_object('conectado', true, 'email', v.connected_email, 'carpeta', v.folder_id,
    'conectado_el', v.connected_at, 'ultima_ok', v.last_ok_at, 'ultimo_archivo', v.last_file_name,
    'ultimo_error', case when v.last_error_at > coalesce(v.last_ok_at, '-infinity') then v.last_error end,
    'ultimo_error_el', v.last_error_at);
end $$;
revoke all on function public.drive_status(uuid) from public, anon;
grant execute on function public.drive_status(uuid) to authenticated;

-- Lo que sigue lo usa SOLO el servidor (clave secreta).
create or replace function public.drive_save_link(p_workspace_id uuid, p_user uuid, p_token_enc text, p_folder text, p_email text) returns void
language sql security definer set search_path = '' as $$
  insert into private.drive_links (workspace_id, token_enc, folder_id, connected_by, connected_email)
  values (p_workspace_id, p_token_enc, p_folder, p_user, p_email)
  on conflict (workspace_id) do update set token_enc = excluded.token_enc, folder_id = excluded.folder_id,
    connected_by = excluded.connected_by, connected_email = excluded.connected_email, connected_at = now(),
    last_error = null, last_error_at = null;
$$;

create or replace function public.drive_get_link(p_workspace_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(l) from private.drive_links l where l.workspace_id = p_workspace_id
$$;

create or replace function public.drive_set_folder(p_workspace_id uuid, p_folder text) returns void
language sql security definer set search_path = '' as $$
  update private.drive_links set folder_id = p_folder where workspace_id = p_workspace_id
$$;

create or replace function public.drive_delete_link(p_workspace_id uuid) returns void
language sql security definer set search_path = '' as $$
  delete from private.drive_links where workspace_id = p_workspace_id
$$;

create or replace function public.drive_mark(p_workspace_id uuid, p_ok boolean, p_file text, p_error text) returns void
language sql security definer set search_path = '' as $$
  update private.drive_links set
    last_ok_at = case when p_ok then now() else last_ok_at end,
    last_file_name = case when p_ok then p_file else last_file_name end,
    last_error = case when p_ok then null else left(p_error, 300) end,
    last_error_at = case when p_ok then last_error_at else now() end
  where workspace_id = p_workspace_id
$$;

-- Balnearios a los que les toca copia (la última de hace más de 20 horas).
create or replace function public.drive_pending(p_limit integer default 20) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select l.workspace_id from private.drive_links l join public.workspaces w on w.id = l.workspace_id
  where not w.is_demo and (l.last_ok_at is null or l.last_ok_at < now() - interval '20 hours')
  order by l.last_ok_at nulls first limit p_limit
$$;

-- Contenido de la copia (el mismo formato que "Descargar").
create or replace function public.backup_payload(p_workspace_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('formato', 'balneario-copia-v1', 'creada', now()) || private.snapshot(p_workspace_id)
$$;

revoke all on function public.drive_save_link(uuid, uuid, text, text, text), public.drive_get_link(uuid), public.drive_set_folder(uuid, text),
  public.drive_delete_link(uuid), public.drive_mark(uuid, boolean, text, text), public.drive_pending(integer), public.backup_payload(uuid)
  from public, anon, authenticated;
grant execute on function public.drive_save_link(uuid, uuid, text, text, text), public.drive_get_link(uuid), public.drive_set_folder(uuid, text),
  public.drive_delete_link(uuid), public.drive_mark(uuid, boolean, text, text), public.drive_pending(integer), public.backup_payload(uuid)
  to service_role;
