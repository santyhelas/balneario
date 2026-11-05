-- =====================================================================
-- 0025 · Llegó / no vino y renovación de temporada.
--   1. Cada reserva puede marcarse como "llegó" o "no vino" desde su primer día.
--      Es solo un registro: no cambia pagos, deudas ni libera el espacio.
--   2. Marcas de renovación: a qué clientes de la temporada pasada ya se les
--      ofreció su lugar y cuáles avisaron que no vuelven.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Llegó / no vino
-- ---------------------------------------------------------------------
alter table public.reservations
  add column arrival_status text check (arrival_status in ('llego', 'no_vino')),
  add column arrival_at     timestamptz,
  add column arrival_by     uuid;

create or replace function public.set_arrival(p_reservation_id uuid, p_state text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_res public.reservations%rowtype;
  v_today date;
begin
  select * into v_res from public.reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'La reserva no existe.';
  end if;
  perform private.require_member(v_res.workspace_id);
  if p_state is not null and p_state not in ('llego', 'no_vino') then
    raise exception 'Estado de llegada inválido.';
  end if;
  if v_res.status <> 'confirmada' then
    raise exception 'La reserva está cancelada.';
  end if;
  select (now() at time zone w.timezone)::date into v_today from public.workspaces w where w.id = v_res.workspace_id;
  if p_state is not null and v_res.start_date > v_today then
    raise exception 'La reserva empieza el %: recién ese día se puede marcar la llegada.', to_char(v_res.start_date, 'DD/MM/YYYY');
  end if;
  if v_res.arrival_status is not distinct from p_state then
    return jsonb_build_object('arrival_status', p_state, 'sin_cambios', true);
  end if;
  update public.reservations
     set arrival_status = p_state,
         arrival_at = case when p_state is null then null else now() end,
         arrival_by = case when p_state is null then null else auth.uid() end,
         version = version + 1
   where id = p_reservation_id;
  return jsonb_build_object('arrival_status', p_state);
end $$;

revoke all on function public.set_arrival(uuid, text) from public, anon;
grant execute on function public.set_arrival(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Renovación de temporada
-- ---------------------------------------------------------------------
create table public.renewal_marks (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  customer_id  uuid not null,
  season       text not null check (season ~ '^\d{4}/\d{4}$'),
  status       text not null check (status in ('pendiente', 'avisado', 'no_vuelve')),
  contacted_at timestamptz,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid(),
  updated_at   timestamptz not null default now(),
  version      integer not null default 1,
  unique (workspace_id, customer_id, season),
  foreign key (workspace_id, customer_id) references public.customers(workspace_id, id) on delete cascade
);

create trigger renewal_marks_version before update on public.renewal_marks
  for each row execute function private.check_version();
create trigger renewal_marks_audit after insert or update on public.renewal_marks
  for each row execute function private.audit();

alter table public.renewal_marks enable row level security;
create policy "miembros leen renovaciones" on public.renewal_marks for select to authenticated using (private.is_member(workspace_id));
revoke all on public.renewal_marks from anon, authenticated;
grant select on public.renewal_marks to authenticated;

create or replace function public.set_renewal_mark(p_workspace_id uuid, p_customer_id uuid, p_season text, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id);
  if p_status not in ('pendiente', 'avisado', 'no_vuelve') then
    raise exception 'Estado inválido.';
  end if;
  if p_season is null or p_season !~ '^\d{4}/\d{4}$' then
    raise exception 'Temporada inválida.';
  end if;
  if not exists (select 1 from public.customers where id = p_customer_id and workspace_id = p_workspace_id) then
    raise exception 'El cliente no existe.';
  end if;
  insert into public.renewal_marks as m (workspace_id, customer_id, season, status, contacted_at)
  values (p_workspace_id, p_customer_id, p_season, p_status, case when p_status = 'avisado' then now() end)
  on conflict (workspace_id, customer_id, season) do update
    set status = excluded.status,
        contacted_at = case when excluded.status = 'avisado' then now() else m.contacted_at end,
        updated_by = auth.uid(),
        updated_at = now(),
        version = m.version + 1
    where m.status is distinct from excluded.status or excluded.status = 'avisado';
end $$;

revoke all on function public.set_renewal_mark(uuid, uuid, text, text) from public, anon;
grant execute on function public.set_renewal_mark(uuid, uuid, text, text) to authenticated;

-- Las copias de seguridad incluyen las marcas de renovación.
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
    'renewal_marks','workspace_members','audit_log'
  ] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(snap_row)), ''[]''::jsonb) from public.%I as snap_row where snap_row.workspace_id = $1', t)
      into v_rows using p_ws;
    v := v || jsonb_build_object(t, v_rows);
  end loop;
  select v || jsonb_build_object('workspace', to_jsonb(w) - 'logo_data') into v from public.workspaces w where w.id = p_ws;
  return v;
end $$;

create or replace function private.restore_tables() returns text[]
language sql immutable as $$
  select array['spaces','map_features','customers','agreements','expense_categories','package_discounts','rates',
               'reservations','reservation_changes','reservation_segments','reservation_charges','reservation_discounts',
               'maintenance_blocks','cash_sessions','payments','expenses','cash_movements','restaurant_vouchers','day_notes',
               'renewal_marks']
$$;
