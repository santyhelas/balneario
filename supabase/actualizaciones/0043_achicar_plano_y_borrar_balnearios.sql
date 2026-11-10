begin;
-- =====================================================================
-- 0043 · Achicar el plano sin cortar carpas y borrar balnearios desde el panel del dueño.
--   · resize_map_at: igual que resize_map, pero se puede elegir cuánto se corre el plano
--     en el sentido de la costa (para recortar el lado vacío y no el que tiene carpas).
--     El lado del mar sigue fijo, así nada se acerca ni se aleja del agua.
--   · admin_delete_workspace: borra un balneario con todos sus datos. Antes se guarda una
--     copia completa en private.deleted_workspaces (por si hay que recuperarlo).
-- =====================================================================
create or replace function public.resize_map_at(p_workspace_id uuid, p_width integer, p_height integer, p_expected_version integer,
                                                p_shift numeric default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  w public.workspaces%rowtype;
  dx numeric;
  dy numeric;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  select * into w from public.workspaces where id = p_workspace_id for update;
  if w.version <> p_expected_version then
    raise exception 'Otra persona cambió la configuración recién. Volvé a intentar.' using errcode = '40001';
  end if;
  if p_width is null or p_height is null or p_width not between 400 and 20000 or p_height not between 400 and 20000 then
    raise exception 'El plano tiene que medir entre 400 y 20.000 de ancho y de alto.';
  end if;
  -- Del lado del mar no se mueve nada; a lo largo de la costa se corre lo que se pida (o se reparte a los costados).
  dx := case w.sea_side when 'left' then 0 when 'right' then p_width - w.map_width
             else coalesce(round(p_shift), round((p_width - w.map_width) / 2.0)) end;
  dy := case w.sea_side when 'top' then 0 when 'bottom' then p_height - w.map_height
             when 'left' then coalesce(round(p_shift), round((p_height - w.map_height) / 2.0))
             when 'right' then coalesce(round(p_shift), round((p_height - w.map_height) / 2.0))
             else round((p_height - w.map_height) / 2.0) end;
  if exists (select 1 from public.spaces where workspace_id = p_workspace_id and active
             and (x + dx < 0 or x + dx > p_width or y + dy < 0 or y + dy > p_height))
     or exists (select 1 from public.map_features where workspace_id = p_workspace_id and active
             and (x + dx < 0 or x + dx > p_width or y + dy < 0 or y + dy > p_height)) then
    raise exception 'Hay carpas o elementos que quedarían fuera del plano. Movelos hacia el centro antes de achicarlo.';
  end if;
  if dx <> 0 or dy <> 0 then
    update public.spaces set x = x + dx, y = y + dy, version = version + 1 where workspace_id = p_workspace_id;
    update public.map_features set x = x + dx, y = y + dy, version = version + 1 where workspace_id = p_workspace_id;
  end if;
  update public.workspaces set map_width = p_width, map_height = p_height, version = version + 1 where id = p_workspace_id;
  return jsonb_build_object('ancho', p_width, 'alto', p_height);
end $$;
revoke all on function public.resize_map_at(uuid, integer, integer, integer, numeric) from public, anon;
grant execute on function public.resize_map_at(uuid, integer, integer, integer, numeric) to authenticated;

-- Copias de los balnearios borrados (solo el dueño de la plataforma, desde la base).
create table if not exists private.deleted_workspaces (
  id           uuid primary key,
  name         text not null,
  owner_email  text,
  deleted_at   timestamptz not null default now(),
  deleted_by   uuid,
  snapshot     jsonb not null
);
alter table private.deleted_workspaces enable row level security;
revoke all on private.deleted_workspaces from public, anon, authenticated;

create or replace function public.admin_delete_workspace(p_workspace_id uuid, p_confirm_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  w public.workspaces%rowtype;
  v_owner text;
begin
  perform private.require_platform_admin();
  select * into w from public.workspaces where id = p_workspace_id for update;
  if not found then raise exception 'Ese balneario no existe.'; end if;
  if w.is_demo then raise exception 'Las demos se borran solas.'; end if;
  if btrim(coalesce(p_confirm_name, '')) <> btrim(w.name) then
    raise exception 'Para borrarlo, escribí el nombre exacto del balneario.';
  end if;
  select u.email::text into v_owner from public.workspace_members m join auth.users u on u.id = m.user_id
   where m.workspace_id = w.id and m.role = 'propietario' order by m.created_at limit 1;
  insert into private.deleted_workspaces (id, name, owner_email, deleted_by, snapshot)
  values (w.id, w.name, v_owner, auth.uid(), private.snapshot(w.id))
  on conflict (id) do update set snapshot = excluded.snapshot, deleted_at = now(), deleted_by = excluded.deleted_by;

  perform set_config('app.purge_ws', w.id::text, true);
  delete from public.cash_movements where workspace_id = w.id;
  delete from public.restaurant_vouchers where workspace_id = w.id;
  delete from public.payments where workspace_id = w.id;
  delete from public.expenses where workspace_id = w.id;
  delete from public.reservation_extras where workspace_id = w.id;
  delete from public.reservation_discounts where workspace_id = w.id;
  delete from public.reservation_charges where workspace_id = w.id;
  delete from public.reservation_segments where workspace_id = w.id;
  delete from public.reservation_changes where workspace_id = w.id;
  delete from public.renewal_marks where workspace_id = w.id;
  delete from public.reservations where workspace_id = w.id;
  delete from public.maintenance_blocks where workspace_id = w.id;
  delete from public.customers where workspace_id = w.id;
  delete from public.rates where workspace_id = w.id;
  delete from public.package_discounts where workspace_id = w.id;
  delete from public.agreements where workspace_id = w.id;
  delete from public.extras where workspace_id = w.id;
  delete from public.expense_categories where workspace_id = w.id;
  delete from public.cash_sessions where workspace_id = w.id;
  delete from public.day_notes where workspace_id = w.id;
  delete from public.backups where workspace_id = w.id;
  delete from public.map_features where workspace_id = w.id;
  delete from public.spaces where workspace_id = w.id;
  delete from public.subscription_events where workspace_id = w.id;
  delete from public.subscriptions where workspace_id = w.id;
  delete from private.reservation_counters where workspace_id = w.id;
  delete from private.drive_links where workspace_id = w.id;
  update private.signup_allowlist set workspace_id = null where workspace_id = w.id;
  delete from public.workspace_members where workspace_id = w.id;
  delete from public.workspaces where id = w.id;
  delete from public.audit_log where workspace_id = w.id;
  perform set_config('app.purge_ws', '', true);
end $$;
revoke all on function public.admin_delete_workspace(uuid, text) from public, anon;
grant execute on function public.admin_delete_workspace(uuid, text) to authenticated;

commit;
