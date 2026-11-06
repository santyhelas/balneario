-- ACTUALIZACIÓN 0029 · Panel del dueño, pausa, guía de bienvenida, extras y comparar temporadas.
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0028).
begin;
-- =====================================================================
-- 0029 · Panel del dueño del sistema, balnearios en pausa, guía de bienvenida,
--        extras en las reservas y comparación de temporadas.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Administradores de la plataforma (el dueño de Mi Balneario)
--    Para darte acceso (una sola vez, en el SQL Editor):
--      select private.hacer_admin_plataforma('tu-correo@gmail.com');
-- ---------------------------------------------------------------------
create table if not exists private.platform_admins (
  user_id    uuid primary key,
  created_at timestamptz not null default now()
);
alter table private.platform_admins enable row level security;
revoke all on private.platform_admins from public, anon, authenticated;

create or replace function private.hacer_admin_plataforma(p_email text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select id into v_id from auth.users where lower(email::text) = lower(btrim(p_email)) and not coalesce(is_anonymous, false);
  if v_id is null then
    raise exception 'No hay ninguna cuenta con ese correo. Primero ingresá a la web con esa cuenta.';
  end if;
  insert into private.platform_admins (user_id) values (v_id) on conflict do nothing;
  return 'Listo: esa cuenta ya puede usar el panel del dueño.';
end $$;
revoke all on function private.hacer_admin_plataforma(text) from public, anon, authenticated;

create or replace function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.platform_admins where user_id = auth.uid())
$$;

create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_platform_admin()
$$;
revoke all on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;

create or replace function private.require_platform_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then
    raise exception 'No tenés permiso para el panel del dueño.' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Balnearios en pausa: se pueden ver y descargar, pero no cargar cambios
-- ---------------------------------------------------------------------
alter table public.workspaces add column if not exists paused_at timestamptz;
alter table public.workspaces add column if not exists paused_reason text check (char_length(paused_reason) <= 300);
-- Las columnas de pausa solo las cambia el dueño de la plataforma (por función), no el balneario.
revoke update (paused_at, paused_reason) on public.workspaces from authenticated;

create or replace function private.block_if_paused() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ws text := coalesce(to_jsonb(new) ->> 'workspace_id', to_jsonb(old) ->> 'workspace_id');
begin
  if private.purging(v_ws) or private.restoring(v_ws) then
    return coalesce(new, old);
  end if;
  if exists (select 1 from public.workspaces w where w.id = v_ws::uuid and w.paused_at is not null) then
    raise exception 'Este balneario está en pausa: podés ver y descargar tus datos, pero no cargar cambios. Escribinos para reactivarlo.'
      using errcode = '42501', hint = 'PAUSADO';
  end if;
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['reservations','reservation_segments','payments','cash_sessions','cash_movements','expenses',
                           'customers','day_notes','maintenance_blocks','rates','spaces','map_features','restaurant_vouchers',
                           'renewal_marks','agreements','reservation_changes'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_pausa', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function private.block_if_paused()', t || '_pausa', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Panel del dueño: balnearios, habilitaciones y pausa
-- ---------------------------------------------------------------------
create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.require_platform_admin();
  select jsonb_build_object(
    'balnearios', coalesce((
      select jsonb_agg(x order by (x ->> 'creado') desc) from (
        select jsonb_build_object(
          'id', w.id, 'nombre', w.name, 'creado', w.created_at, 'pausado', w.paused_at, 'motivo_pausa', w.paused_reason,
          'propietario', (select u.email::text from public.workspace_members m join auth.users u on u.id = m.user_id
                          where m.workspace_id = w.id and m.role = 'propietario' order by m.created_at limit 1),
          'usuarios', (select count(*) from public.workspace_members m where m.workspace_id = w.id),
          'carpas', (select count(*) from public.spaces s where s.workspace_id = w.id and s.active and s.kind = 'carpa'),
          'sombrillas', (select count(*) from public.spaces s where s.workspace_id = w.id and s.active and s.kind = 'sombrilla'),
          'reservas', (select count(*) from public.reservations r where r.workspace_id = w.id and r.status = 'confirmada'),
          'reservas_30d', (select count(*) from public.reservations r where r.workspace_id = w.id and r.created_at > now() - interval '30 days'),
          'ultimo_uso', (select max(a.at) from public.audit_log a where a.workspace_id = w.id)
        ) as x
        from public.workspaces w
        where not w.is_demo
      ) t), '[]'::jsonb),
    'habilitaciones', coalesce((
      select jsonb_agg(jsonb_build_object('correo', a.email, 'nota', a.note, 'creado', a.created_at, 'usado', a.used_at,
                                          'balneario', (select name from public.workspaces where id = a.workspace_id))
                       order by a.created_at desc)
      from private.signup_allowlist a), '[]'::jsonb),
    'demos_abiertas', (select count(*) from public.workspaces where is_demo)
  ) into v;
  return v;
end $$;

create or replace function public.admin_allow_signup(p_email text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v text := lower(btrim(coalesce(p_email, '')));
begin
  perform private.require_platform_admin();
  if v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Correo inválido.';
  end if;
  perform private.permitir_alta(v, nullif(btrim(coalesce(p_note, '')), ''));
end $$;

create or replace function public.admin_revoke_signup(p_email text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  delete from private.signup_allowlist where email = lower(btrim(p_email)) and used_at is null;
  if not found then
    raise exception 'Esa habilitación no existe o ya se usó para crear un balneario.';
  end if;
end $$;

create or replace function public.admin_set_paused(p_workspace_id uuid, p_paused boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  if p_paused and char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Indicá el motivo de la pausa.';
  end if;
  update public.workspaces
     set paused_at = case when p_paused then now() end,
         paused_reason = case when p_paused then btrim(p_reason) end,
         version = version + 1
   where id = p_workspace_id and not is_demo;
  if not found then
    raise exception 'El balneario no existe.';
  end if;
end $$;

revoke all on function public.admin_overview(), public.admin_allow_signup(text, text), public.admin_revoke_signup(text),
  public.admin_set_paused(uuid, boolean, text) from public, anon;
grant execute on function public.admin_overview(), public.admin_allow_signup(text, text), public.admin_revoke_signup(text),
  public.admin_set_paused(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Guía de bienvenida: se muestra una vez a cada cuenta nueva
-- ---------------------------------------------------------------------
alter table public.user_preferences add column if not exists guide_done boolean not null default false;
update public.user_preferences set guide_done = true where not guide_done;   -- las cuentas que ya existen no la ven
grant update (guide_done) on public.user_preferences to authenticated;

-- ---------------------------------------------------------------------
-- 5. Extras: catálogo del balneario y extras de cada reserva
-- ---------------------------------------------------------------------
create table public.extras (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 2 and 60),
  price        numeric(14,2) not null check (price >= 0),
  per_day      boolean not null default true,
  active       boolean not null default true,
  version      integer not null default 1,
  created_at   timestamptz not null default now(),
  unique (workspace_id, id)
);
create trigger extras_version before update on public.extras for each row execute function private.check_version();
create trigger extras_audit after insert or update on public.extras for each row execute function private.audit();
create trigger extras_pausa before insert or update or delete on public.extras for each row execute function private.block_if_paused();
alter table public.extras enable row level security;
create policy "miembros leen extras" on public.extras for select to authenticated using (private.is_member(workspace_id));
create policy "administradores cargan extras" on public.extras for insert to authenticated
  with check (private.has_role(workspace_id, array['propietario','administrador']));
create policy "administradores editan extras" on public.extras for update to authenticated
  using (private.has_role(workspace_id, array['propietario','administrador']))
  with check (private.has_role(workspace_id, array['propietario','administrador']));
revoke all on public.extras from anon, authenticated;
grant select on public.extras to authenticated;
grant insert (workspace_id, name, price, per_day) on public.extras to authenticated;
grant update (name, price, per_day, active, version) on public.extras to authenticated;

create table public.reservation_extras (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  reservation_id uuid not null,
  extra_id       uuid,
  description    text not null check (char_length(description) between 2 and 120),
  quantity       integer not null check (quantity between 1 and 99),
  days           integer not null check (days between 1 and 400),
  unit_price     numeric(14,2) not null check (unit_price >= 0),
  amount         numeric(14,2) not null check (amount >= 0),
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  voided_at      timestamptz,
  voided_by      uuid,
  void_reason    text check (char_length(void_reason) <= 300),
  foreign key (workspace_id, reservation_id) references public.reservations(workspace_id, id) on delete cascade,
  check (amount = round(unit_price * quantity * days, 2))
);
create index reservation_extras_res_idx on public.reservation_extras(reservation_id);

-- Un extra no se borra ni se cambia: solo se anula (una vez), dejando el motivo.
create or replace function private.reservation_extras_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purging((coalesce(old, new)).workspace_id::text) or private.restoring((coalesce(old, new)).workspace_id::text) then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Los extras no se borran: se anulan.';
  end if;
  if old.voided_at is not null
     or (to_jsonb(new) - array['voided_at','voided_by','void_reason']) <> (to_jsonb(old) - array['voided_at','voided_by','void_reason']) then
    raise exception 'Un extra cargado no se puede modificar; anulalo y cargá uno nuevo.';
  end if;
  return new;
end $$;
create trigger reservation_extras_guard before update or delete on public.reservation_extras
  for each row execute function private.reservation_extras_guard();
create trigger reservation_extras_audit after insert or update on public.reservation_extras for each row execute function private.audit();
create trigger reservation_extras_pausa before insert or update or delete on public.reservation_extras for each row execute function private.block_if_paused();
alter table public.reservation_extras enable row level security;
create policy "miembros leen extras de reservas" on public.reservation_extras for select to authenticated using (private.is_member(workspace_id));
revoke all on public.reservation_extras from anon, authenticated;
grant select on public.reservation_extras to authenticated;

create or replace function public.add_reservation_extra(p_reservation_id uuid, p_extra_id uuid, p_quantity integer, p_days integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_res public.reservations%rowtype;
  v_ex public.extras%rowtype;
  v_days integer;
  v_amount numeric;
  v_id uuid;
begin
  select * into v_res from public.reservations where id = p_reservation_id for update;
  if not found then raise exception 'La reserva no existe.'; end if;
  perform private.require_member(v_res.workspace_id);
  if v_res.status <> 'confirmada' then raise exception 'La reserva está cancelada.'; end if;
  if v_res.is_courtesy then raise exception 'Una cortesía no lleva extras con cargo.'; end if;
  select * into v_ex from public.extras where id = p_extra_id and workspace_id = v_res.workspace_id;
  if not found or not v_ex.active then raise exception 'Ese extra no existe o está desactivado.'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 99 then raise exception 'La cantidad tiene que ser entre 1 y 99.'; end if;
  v_days := case when v_ex.per_day then coalesce(p_days, v_res.end_date - v_res.start_date + 1) else 1 end;
  if v_days < 1 or v_days > v_res.end_date - v_res.start_date + 1 then
    raise exception 'Los días tienen que ser entre 1 y los de la estadía (%).', v_res.end_date - v_res.start_date + 1;
  end if;
  v_amount := round(v_ex.price * p_quantity * v_days, 2);
  insert into public.reservation_extras (workspace_id, reservation_id, extra_id, description, quantity, days, unit_price, amount)
  values (v_res.workspace_id, v_res.id, v_ex.id, v_ex.name, p_quantity, v_days, v_ex.price, v_amount)
  returning id into v_id;
  update public.reservations
     set list_amount = list_amount + v_amount, total_amount = total_amount + v_amount, version = version + 1
   where id = v_res.id;
  return jsonb_build_object('id', v_id, 'importe', v_amount);
end $$;

create or replace function public.void_reservation_extra(p_extra_line_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_line public.reservation_extras%rowtype;
begin
  select * into v_line from public.reservation_extras where id = p_extra_line_id for update;
  if not found then raise exception 'El extra no existe.'; end if;
  perform private.require_member(v_line.workspace_id);
  if v_line.voided_at is not null then raise exception 'Ese extra ya está anulado.'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Indicá el motivo.'; end if;
  perform 1 from public.reservations where id = v_line.reservation_id for update;
  update public.reservation_extras set voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason) where id = v_line.id;
  update public.reservations
     set list_amount = list_amount - v_line.amount, total_amount = total_amount - v_line.amount, version = version + 1
   where id = v_line.reservation_id;
end $$;

revoke all on function public.add_reservation_extra(uuid, uuid, integer, integer), public.void_reservation_extra(uuid, text) from public, anon;
grant execute on function public.add_reservation_extra(uuid, uuid, integer, integer), public.void_reservation_extra(uuid, text) to authenticated;

-- Copias de seguridad: incluyen el catálogo y los extras de las reservas.
create or replace function private.snapshot(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb := '{}'::jsonb;
  t text;
  v_rows jsonb;
begin
  foreach t in array array[
    'spaces','map_features','customers','agreements','expense_categories','package_discounts','rates','extras',
    'reservations','reservation_changes','reservation_segments','reservation_charges','reservation_discounts','reservation_extras',
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
  select array['spaces','map_features','customers','agreements','expense_categories','package_discounts','rates','extras',
               'reservations','reservation_changes','reservation_segments','reservation_charges','reservation_discounts','reservation_extras',
               'maintenance_blocks','cash_sessions','payments','expenses','cash_movements','restaurant_vouchers','day_notes',
               'renewal_marks']
$$;

-- ---------------------------------------------------------------------
-- 6. Comparar temporadas: números por mes de una temporada (julio a junio)
-- ---------------------------------------------------------------------
create or replace function public.season_stats(p_workspace_id uuid, p_start_year integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from date := make_date(p_start_year, 7, 1);
  v_to date := make_date(p_start_year + 1, 6, 30);
begin
  perform private.require_member(p_workspace_id);
  if p_start_year < 2000 or p_start_year > 2100 then raise exception 'Temporada inválida.'; end if;
  return (
    with meses as (
      select gs::date as desde, (gs + interval '1 month' - interval '1 day')::date as hasta
      from generate_series(v_from, v_to, interval '1 month') gs
    ),
    capacidad as (select count(*) filter (where active) as espacios from public.spaces where workspace_id = p_workspace_id)
    select jsonb_build_object(
      'temporada', p_start_year || '/' || (p_start_year + 1),
      'espacios', (select espacios from capacidad),
      'meses', jsonb_agg(jsonb_build_object(
        'mes', to_char(m.desde, 'YYYY-MM'),
        'dias_ocupados', (
          select coalesce(sum(least(s.end_date, m.hasta) - greatest(s.start_date, m.desde) + 1), 0)
          from public.reservation_segments s join public.reservations r on r.id = s.reservation_id
          where s.workspace_id = p_workspace_id and s.active and r.status = 'confirmada'
            and s.start_date <= m.hasta and s.end_date >= m.desde),
        'dias_posibles', (select espacios from capacidad) * (m.hasta - m.desde + 1),
        'reservas', (select count(*) from public.reservations r where r.workspace_id = p_workspace_id
                     and r.status = 'confirmada' and r.start_date between m.desde and m.hasta),
        'contratado', (select coalesce(sum(r.total_amount), 0) from public.reservations r where r.workspace_id = p_workspace_id
                       and r.status = 'confirmada' and r.start_date between m.desde and m.hasta),
        'cobrado', (select coalesce(sum(case when mv.category in ('cobro','otro_ingreso','anulacion_devolucion') then mv.amount
                                             when mv.category in ('devolucion','anulacion_cobro') then -mv.amount end), 0)
                    from public.cash_sessions cs join public.cash_movements mv on mv.cash_session_id = cs.id
                    where cs.workspace_id = p_workspace_id and cs.business_date between m.desde and m.hasta),
        'gastos', (select coalesce(sum(e.amount), 0) from public.expenses e where e.workspace_id = p_workspace_id
                   and e.voided_at is null and e.spent_on between m.desde and m.hasta)
      ) order by m.desde)
    )
    from meses m
  );
end $$;
revoke all on function public.season_stats(uuid, integer) from public, anon;
grant execute on function public.season_stats(uuid, integer) to authenticated;

commit;
