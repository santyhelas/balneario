-- =====================================================================
--  SISTEMA DE GESTIÓN DE BALNEARIO · Instalación de la base de datos
--  Pegar TODO este archivo en Supabase → SQL Editor → New query → Run.
--  Se ejecuta una sola vez, en un proyecto nuevo.
-- =====================================================================
begin;

-- >>> 0001_base.sql
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

-- >>> 0002_espacios_clientes.sql
-- =====================================================================
-- 0002 · Espacios (carpas y sombrillas), elementos del mapa, clientes,
--        convenios y categorías de gastos.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Carpas y sombrillas
-- ---------------------------------------------------------------------
create table public.spaces (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  kind         text not null check (kind in ('carpa','sombrilla')),
  code         text not null check (char_length(btrim(code)) between 1 and 20),
  x            numeric(10,2) not null default 0,
  y            numeric(10,2) not null default 0,
  rotation     numeric(6,2) not null default 0,
  active       boolean not null default true,
  notes        text,
  version      integer not null default 1,
  created_at   timestamptz not null default now(),
  unique (workspace_id, id)
);
-- El código (ej. C17) no se puede repetir dentro del mismo balneario.
create unique index spaces_code_unique on public.spaces(workspace_id, lower(btrim(code)));

create or replace function private.spaces_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.kind <> old.kind then
    raise exception 'No se puede cambiar el tipo de un espacio existente. Desactivalo y creá uno nuevo.';
  end if;
  new.code := btrim(new.code);
  return new;
end $$;

create trigger spaces_guard before insert or update on public.spaces
  for each row execute function private.spaces_guard();
create trigger spaces_version before update on public.spaces
  for each row execute function private.check_version();
create trigger spaces_audit after insert or update on public.spaces
  for each row execute function private.audit();
create trigger spaces_no_delete before delete on public.spaces
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------
-- Elementos del mapa: caminos, pasillos, áreas comunes, instalaciones, sectores
-- ---------------------------------------------------------------------
create table public.map_features (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  kind         text not null check (kind in ('camino','pasillo','area_comun','instalacion','sector')),
  label        text check (char_length(label) <= 80),
  x            numeric(10,2) not null default 0,
  y            numeric(10,2) not null default 0,
  width        numeric(10,2) not null default 100 check (width > 0),
  height       numeric(10,2) not null default 100 check (height > 0),
  rotation     numeric(6,2) not null default 0,
  color        text check (color ~ '^#[0-9a-fA-F]{6}$'),
  active       boolean not null default true,
  version      integer not null default 1,
  created_at   timestamptz not null default now()
);

create trigger map_features_version before update on public.map_features
  for each row execute function private.check_version();
create trigger map_features_audit after insert or update on public.map_features
  for each row execute function private.audit();

-- ---------------------------------------------------------------------
-- Clientes (sin DNI obligatorio; nombres repetidos permitidos)
-- ---------------------------------------------------------------------
create table public.customers (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete restrict,
  first_name    text not null check (char_length(btrim(first_name)) between 1 and 80),
  last_name     text not null default '' check (char_length(last_name) <= 80),
  phone         text check (char_length(phone) <= 40),
  phone_digits  text generated always as (nullif(regexp_replace(coalesce(phone,''), '\D', '', 'g'), '')) stored,
  email         text check (char_length(email) <= 150),
  other_contact text check (char_length(other_contact) <= 200),
  notes         text check (char_length(notes) <= 2000),
  version       integer not null default 1,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  unique (workspace_id, id)
);
create index customers_name_idx on public.customers(workspace_id, lower(last_name), lower(first_name));
create index customers_phone_idx on public.customers(workspace_id, phone_digits);

create trigger customers_version before update on public.customers
  for each row execute function private.check_version();
create trigger customers_audit after insert or update on public.customers
  for each row execute function private.audit();
create trigger customers_no_delete before delete on public.customers
  for each row execute function private.forbid_change();

-- Posibles duplicados: mismo teléfono o mismo nombre y apellido.
-- Solo advierte; nunca impide el alta.
create or replace function public.find_similar_customers(
  p_workspace_id uuid, p_first_name text, p_last_name text, p_phone text
) returns table (id uuid, first_name text, last_name text, phone text, motivo text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_digits text := nullif(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), '');
begin
  perform private.require_member(p_workspace_id);
  return query
    select c.id, c.first_name, c.last_name, c.phone,
           case
             when v_digits is not null and length(v_digits) >= 6 and c.phone_digits is not null
                  and right(c.phone_digits, 8) = right(v_digits, 8) then 'Mismo teléfono'
             else 'Mismo nombre y apellido'
           end
    from public.customers c
    where c.workspace_id = p_workspace_id
      and (
        (v_digits is not null and length(v_digits) >= 6 and c.phone_digits is not null
          and right(c.phone_digits, 8) = right(v_digits, 8))
        or (lower(btrim(c.first_name)) = lower(btrim(coalesce(p_first_name,'')))
            and lower(btrim(c.last_name)) = lower(btrim(coalesce(p_last_name,''))))
      )
    order by c.last_name, c.first_name
    limit 20;
end $$;

-- ---------------------------------------------------------------------
-- Convenios (ej. Parque Bonito 30%). Se desactivan, nunca se borran.
-- ---------------------------------------------------------------------
create table public.agreements (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  name         text not null check (char_length(btrim(name)) between 1 and 80),
  percent      numeric(5,2) not null check (percent > 0 and percent <= 100),
  active       boolean not null default true,
  version      integer not null default 1,
  created_at   timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index agreements_name_unique on public.agreements(workspace_id, lower(btrim(name)));

create trigger agreements_version before update on public.agreements
  for each row execute function private.check_version();
create trigger agreements_audit after insert or update on public.agreements
  for each row execute function private.audit();
create trigger agreements_no_delete before delete on public.agreements
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------
-- Categorías de gastos
-- ---------------------------------------------------------------------
create table public.expense_categories (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  name         text not null check (char_length(btrim(name)) between 1 and 60),
  active       boolean not null default true,
  version      integer not null default 1,
  created_at   timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index expense_categories_name_unique on public.expense_categories(workspace_id, lower(btrim(name)));

create trigger expense_categories_version before update on public.expense_categories
  for each row execute function private.check_version();
create trigger expense_categories_no_delete before delete on public.expense_categories
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------
-- Seguridad
-- ---------------------------------------------------------------------
alter table public.spaces             enable row level security;
alter table public.map_features       enable row level security;
alter table public.customers          enable row level security;
alter table public.agreements         enable row level security;
alter table public.expense_categories enable row level security;

-- Lectura: cualquier miembro del balneario.
create policy "miembros leen espacios" on public.spaces for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen mapa" on public.map_features for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen clientes" on public.customers for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen convenios" on public.agreements for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen categorias" on public.expense_categories for select to authenticated using (private.is_member(workspace_id));

-- Clientes: cualquier miembro puede crearlos y editarlos.
create policy "miembros crean clientes" on public.customers for insert to authenticated
  with check (private.is_member(workspace_id));
create policy "miembros editan clientes" on public.customers for update to authenticated
  using (private.is_member(workspace_id)) with check (private.is_member(workspace_id));

-- Inventario, mapa, convenios y categorías: solo administradores.
create policy "admins crean espacios" on public.spaces for insert to authenticated
  with check (private.has_role(workspace_id, array['propietario','administrador']));
create policy "admins editan espacios" on public.spaces for update to authenticated
  using (private.has_role(workspace_id, array['propietario','administrador']))
  with check (private.has_role(workspace_id, array['propietario','administrador']));
create policy "admins crean mapa" on public.map_features for insert to authenticated
  with check (private.has_role(workspace_id, array['propietario','administrador']));
create policy "admins editan mapa" on public.map_features for update to authenticated
  using (private.has_role(workspace_id, array['propietario','administrador']))
  with check (private.has_role(workspace_id, array['propietario','administrador']));
create policy "admins crean convenios" on public.agreements for insert to authenticated
  with check (private.has_role(workspace_id, array['propietario','administrador']));
create policy "admins editan convenios" on public.agreements for update to authenticated
  using (private.has_role(workspace_id, array['propietario','administrador']))
  with check (private.has_role(workspace_id, array['propietario','administrador']));
create policy "admins crean categorias" on public.expense_categories for insert to authenticated
  with check (private.has_role(workspace_id, array['propietario','administrador']));
create policy "admins editan categorias" on public.expense_categories for update to authenticated
  using (private.has_role(workspace_id, array['propietario','administrador']))
  with check (private.has_role(workspace_id, array['propietario','administrador']));

revoke all on public.spaces, public.map_features, public.customers, public.agreements, public.expense_categories from anon;
revoke all on public.spaces, public.map_features, public.customers, public.agreements, public.expense_categories from authenticated;
grant select on public.spaces, public.map_features, public.customers, public.agreements, public.expense_categories to authenticated;

grant insert (workspace_id, kind, code, x, y, rotation, active, notes) on public.spaces to authenticated;
grant update (code, x, y, rotation, active, notes, version) on public.spaces to authenticated;

grant insert (workspace_id, kind, label, x, y, width, height, rotation, color, active) on public.map_features to authenticated;
grant update (kind, label, x, y, width, height, rotation, color, active, version) on public.map_features to authenticated;

grant insert (workspace_id, first_name, last_name, phone, email, other_contact, notes) on public.customers to authenticated;
grant update (first_name, last_name, phone, email, other_contact, notes, version) on public.customers to authenticated;

grant insert (workspace_id, name, percent, active) on public.agreements to authenticated;
-- El porcentaje de un convenio no se edita: se desactiva y se crea otro (protege el historial).
grant update (name, active, version) on public.agreements to authenticated;

grant insert (workspace_id, name, active) on public.expense_categories to authenticated;
grant update (name, active, version) on public.expense_categories to authenticated;

revoke all on function public.find_similar_customers(uuid, text, text, text) from public, anon;
grant execute on function public.find_similar_customers(uuid, text, text, text) to authenticated;

-- >>> 0003_reservas.sql
-- =====================================================================
-- 0003 · Reservas, tramos de ocupación, precios, descuentos,
--        mantenimiento e historial de cambios.
-- Las fechas son inclusivas: start_date y end_date cuentan como ocupados.
-- =====================================================================

create table public.reservations (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete restrict,
  number          bigint generated always as identity,
  customer_id     uuid not null,
  start_date      date not null,
  end_date        date not null,
  status          text not null default 'confirmada' check (status in ('confirmada','cancelada')),
  is_courtesy     boolean not null default false,
  list_amount     numeric(14,2) not null check (list_amount >= 0),
  discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0),
  total_amount    numeric(14,2) not null check (total_amount >= 0),
  notes           text check (char_length(notes) <= 2000),
  request_id      uuid not null,
  version         integer not null default 1,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  cancelled_at    timestamptz,
  cancelled_by    uuid,
  cancel_reason   text,
  unique (workspace_id, id),
  unique (workspace_id, request_id),
  foreign key (workspace_id, customer_id) references public.customers(workspace_id, id),
  check (end_date >= start_date),
  check (end_date - start_date < 366),
  check (total_amount = list_amount - discount_amount),
  check (not is_courtesy or total_amount = 0),
  check ((status = 'cancelada') = (cancelled_at is not null))
);
create index reservations_dates_idx on public.reservations(workspace_id, start_date, end_date);
create index reservations_customer_idx on public.reservations(workspace_id, customer_id);

create trigger reservations_version before update on public.reservations
  for each row execute function private.check_version();
create trigger reservations_audit after insert or update on public.reservations
  for each row execute function private.audit();
create trigger reservations_no_delete before delete on public.reservations
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------
-- Historial de cambios de cada reserva (para deshacer y revertir)
-- ---------------------------------------------------------------------
create table public.reservation_changes (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null,
  reservation_id        uuid not null,
  kind                  text not null check (kind in ('creacion','reubicacion','cancelacion','reversion')),
  description           text not null,
  reason                text,
  before_state          jsonb,
  after_state           jsonb,
  reverts_change_id     uuid references public.reservation_changes(id),
  reverted_by_change_id uuid references public.reservation_changes(id),
  actor_id              uuid default auth.uid(),
  actor_email           text default (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'),
  at                    timestamptz not null default now(),
  foreign key (workspace_id, reservation_id) references public.reservations(workspace_id, id)
);
create index reservation_changes_res_idx on public.reservation_changes(reservation_id, at desc);
create index reservation_changes_ws_idx on public.reservation_changes(workspace_id, at desc);
create unique index reservation_changes_one_revert on public.reservation_changes(reverts_change_id)
  where reverts_change_id is not null;

-- Solo se puede completar after_state (una vez) y marcar la reversión (una vez).
create or replace function private.changes_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'El historial no se puede borrar.' using errcode = '42501';
  end if;
  if (to_jsonb(new) - 'after_state' - 'reverted_by_change_id') <> (to_jsonb(old) - 'after_state' - 'reverted_by_change_id')
     or (old.after_state is not null and new.after_state is distinct from old.after_state)
     or (old.reverted_by_change_id is not null and new.reverted_by_change_id is distinct from old.reverted_by_change_id) then
    raise exception 'El historial no se puede modificar.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger reservation_changes_guard before update or delete on public.reservation_changes
  for each row execute function private.changes_guard();

-- ---------------------------------------------------------------------
-- Tramos de ocupación: qué carpa usa la reserva cada día
-- ---------------------------------------------------------------------
create table public.reservation_segments (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null,
  reservation_id       uuid not null,
  space_id             uuid not null,
  start_date           date not null,
  end_date             date not null,
  active               boolean not null default true,
  created_by_change_id uuid not null references public.reservation_changes(id),
  ended_by_change_id   uuid references public.reservation_changes(id),
  created_at           timestamptz not null default now(),
  foreign key (workspace_id, reservation_id) references public.reservations(workspace_id, id),
  foreign key (workspace_id, space_id) references public.spaces(workspace_id, id),
  check (end_date >= start_date),
  check (active = (ended_by_change_id is null)),
  -- Garantía en la base de datos: un espacio no puede estar ocupado dos veces el mismo día.
  constraint segments_no_double_booking exclude using gist (
    space_id with =, daterange(start_date, end_date, '[]') with &&
  ) where (active),
  -- Una reserva no puede tener dos carpas el mismo día.
  constraint segments_no_overlap_in_reservation exclude using gist (
    reservation_id with =, daterange(start_date, end_date, '[]') with &&
  ) where (active)
);
create index reservation_segments_res_idx on public.reservation_segments(reservation_id) where active;
create index reservation_segments_space_idx on public.reservation_segments(space_id, start_date, end_date) where active;

-- ---------------------------------------------------------------------
-- Mantenimiento
-- ---------------------------------------------------------------------
create table public.maintenance_blocks (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  space_id     uuid not null,
  start_date   date not null,
  end_date     date not null,
  reason       text not null check (char_length(btrim(reason)) between 3 and 300),
  notes        text check (char_length(notes) <= 2000),
  active       boolean not null default true,
  version      integer not null default 1,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  foreign key (workspace_id, space_id) references public.spaces(workspace_id, id),
  check (end_date >= start_date),
  constraint maintenance_no_overlap exclude using gist (
    space_id with =, daterange(start_date, end_date, '[]') with &&
  ) where (active)
);

create trigger maintenance_version before update on public.maintenance_blocks
  for each row execute function private.check_version();
create trigger maintenance_audit after insert or update on public.maintenance_blocks
  for each row execute function private.audit();
create trigger maintenance_no_delete before delete on public.maintenance_blocks
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------
-- Bloqueos por espacio: serializa las operaciones que compiten por la
-- misma carpa (reservas, cambios, mantenimiento) entre dispositivos.
-- ---------------------------------------------------------------------
create or replace function private.lock_spaces(p_space_ids uuid[]) returns void
language plpgsql as $$
declare v_id uuid;
begin
  for v_id in select distinct s from unnest(p_space_ids) s where s is not null order by s loop
    perform pg_advisory_xact_lock(hashtextextended('espacio:' || v_id::text, 0));
  end loop;
end $$;

-- Describe por qué un espacio no está libre en un rango (null si está libre).
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
    return format('%s está desactivado.', v_space.code);
  end if;

  select format('%s está en mantenimiento del %s al %s (%s).', v_space.code,
                to_char(m.start_date, 'DD/MM/YYYY'), to_char(m.end_date, 'DD/MM/YYYY'), m.reason)
    into v_msg
  from public.maintenance_blocks m
  where m.space_id = p_space_id and m.active
    and daterange(m.start_date, m.end_date, '[]') && daterange(p_start, p_end, '[]')
  order by m.start_date limit 1;
  if v_msg is not null then return v_msg; end if;

  select format('%s está ocupada del %s al %s por la reserva #%s (%s).', v_space.code,
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

-- Al activar un tramo: el espacio debe estar activo y sin mantenimiento.
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
             when not sp.active then format('%s está desactivado.', sp.code)
             else (select format('%s está en mantenimiento del %s al %s (%s).', sp.code,
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

create trigger reservation_segments_guard before insert or update or delete on public.reservation_segments
  for each row execute function private.segments_guard();
create trigger reservation_segments_audit after insert or update on public.reservation_segments
  for each row execute function private.audit();

-- Al crear o modificar un mantenimiento: no puede pisar reservas activas.
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

create trigger maintenance_guard before insert or update on public.maintenance_blocks
  for each row execute function private.maintenance_guard();

-- No se puede desactivar un espacio que tiene reservas de hoy en adelante.
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
      raise exception 'No se puede desactivar %: tiene reservas pendientes %. Cambialas de carpa primero.', new.code, v_msg;
    end if;
  end if;
  return new;
end $$;

create trigger spaces_deactivation_guard before update of active on public.spaces
  for each row execute function private.spaces_deactivation_guard();

-- ---------------------------------------------------------------------
-- Detalle de precio (fotografía histórica) y descuentos aplicados
-- ---------------------------------------------------------------------
create table public.reservation_charges (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  reservation_id uuid not null,
  position       integer not null,
  description    text not null check (char_length(description) <= 200),
  space_kind     text check (space_kind in ('carpa','sombrilla')),
  start_date     date,
  end_date       date,
  days           integer check (days > 0),
  unit_price     numeric(14,2) check (unit_price >= 0),
  amount         numeric(14,2) not null check (amount >= 0),
  is_manual      boolean not null default false,
  rate_snapshot  jsonb,
  foreign key (workspace_id, reservation_id) references public.reservations(workspace_id, id),
  check (end_date is null or start_date is null or end_date >= start_date),
  unique (reservation_id, position)
);

create table public.reservation_discounts (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  reservation_id uuid not null,
  position       integer not null,
  kind           text not null check (kind in ('efectivo','convenio','manual','cortesia')),
  agreement_id   uuid,
  label          text not null check (char_length(label) <= 120),
  percent        numeric(5,2) check (percent > 0 and percent <= 100),
  amount         numeric(14,2) not null check (amount >= 0),
  reason         text check (char_length(reason) <= 300),
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  foreign key (workspace_id, reservation_id) references public.reservations(workspace_id, id),
  foreign key (workspace_id, agreement_id) references public.agreements(workspace_id, id),
  check (kind <> 'convenio' or agreement_id is not null),
  check (kind <> 'manual' or char_length(btrim(coalesce(reason, ''))) >= 3),
  unique (reservation_id, position)
);

create trigger reservation_charges_immutable before update or delete on public.reservation_charges
  for each row execute function private.forbid_change();
create trigger reservation_discounts_immutable before update or delete on public.reservation_discounts
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------
-- Comprueba que los tramos activos cubran toda la estadía sin huecos.
-- ---------------------------------------------------------------------
create or replace function private.assert_coverage(p_reservation_id uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_res public.reservations%rowtype;
  v_prev date;
  v_count integer := 0;
  r record;
begin
  select * into v_res from public.reservations where id = p_reservation_id;
  if v_res.status = 'cancelada' then
    if exists (select 1 from public.reservation_segments where reservation_id = p_reservation_id and active) then
      raise exception 'Una reserva cancelada no puede ocupar espacios.';
    end if;
    return;
  end if;
  v_prev := v_res.start_date - 1;
  for r in select start_date, end_date from public.reservation_segments
           where reservation_id = p_reservation_id and active order by start_date loop
    if r.start_date <> v_prev + 1 then
      raise exception 'Los tramos de carpa dejan días sin asignar o se superponen (a partir del %).',
        to_char(v_prev + 1, 'DD/MM/YYYY');
    end if;
    v_prev := r.end_date;
    v_count := v_count + 1;
  end loop;
  if v_count = 0 or v_prev <> v_res.end_date then
    raise exception 'Los tramos de carpa no cubren toda la estadía (falta desde el %).',
      to_char(v_prev + 1, 'DD/MM/YYYY');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Seguridad: lectura para miembros; la escritura de reservas y tramos
-- solo es posible mediante las funciones validadas (ver 0005).
-- ---------------------------------------------------------------------
alter table public.reservations          enable row level security;
alter table public.reservation_changes   enable row level security;
alter table public.reservation_segments  enable row level security;
alter table public.maintenance_blocks    enable row level security;
alter table public.reservation_charges   enable row level security;
alter table public.reservation_discounts enable row level security;

create policy "miembros leen reservas" on public.reservations for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen cambios" on public.reservation_changes for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen tramos" on public.reservation_segments for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen mantenimiento" on public.maintenance_blocks for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen precios" on public.reservation_charges for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen descuentos" on public.reservation_discounts for select to authenticated using (private.is_member(workspace_id));

create policy "admins crean mantenimiento" on public.maintenance_blocks for insert to authenticated
  with check (private.has_role(workspace_id, array['propietario','administrador']));
create policy "admins editan mantenimiento" on public.maintenance_blocks for update to authenticated
  using (private.has_role(workspace_id, array['propietario','administrador']))
  with check (private.has_role(workspace_id, array['propietario','administrador']));

revoke all on public.reservations, public.reservation_changes, public.reservation_segments,
  public.maintenance_blocks, public.reservation_charges, public.reservation_discounts from anon, authenticated;
grant select on public.reservations, public.reservation_changes, public.reservation_segments,
  public.maintenance_blocks, public.reservation_charges, public.reservation_discounts to authenticated;
grant insert (workspace_id, space_id, start_date, end_date, reason, notes) on public.maintenance_blocks to authenticated;
grant update (end_date, reason, notes, active, version) on public.maintenance_blocks to authenticated;

-- >>> 0004_dinero.sql
-- =====================================================================
-- 0004 · Caja diaria, pagos, devoluciones, anulaciones, gastos.
-- Los registros de dinero son inmutables: los errores se corrigen
-- con una anulación que queda registrada, nunca borrando.
-- =====================================================================

create table public.cash_sessions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete restrict,
  business_date date not null,
  opening_cash  numeric(14,2) not null check (opening_cash >= 0),
  opening_notes text check (char_length(opening_notes) <= 1000),
  opened_at     timestamptz not null default now(),
  opened_by     uuid not null default auth.uid(),
  closed_at     timestamptz,
  closed_by     uuid,
  counted_cash  numeric(14,2) check (counted_cash >= 0),
  expected_cash numeric(14,2),
  difference    numeric(14,2),
  close_notes   text check (char_length(close_notes) <= 1000),
  version       integer not null default 1,
  unique (workspace_id, id),
  unique (workspace_id, business_date),
  check ((closed_at is null) = (counted_cash is null)),
  check ((closed_at is null) = (expected_cash is null)),
  check (difference is null or difference = counted_cash - expected_cash)
);
-- Solo puede haber una caja abierta a la vez por balneario.
create unique index cash_sessions_one_open on public.cash_sessions(workspace_id) where closed_at is null;

create trigger cash_sessions_version before update on public.cash_sessions
  for each row execute function private.check_version();
create trigger cash_sessions_audit after insert or update on public.cash_sessions
  for each row execute function private.audit();
create trigger cash_sessions_no_delete before delete on public.cash_sessions
  for each row execute function private.forbid_change();

-- Una caja cerrada no se reabre ni se modifica.
create or replace function private.cash_sessions_guard() returns trigger
language plpgsql as $$
begin
  if old.closed_at is not null then
    raise exception 'Esta caja ya está cerrada y no se puede modificar.' using errcode = '42501';
  end if;
  if new.opening_cash <> old.opening_cash or new.business_date <> old.business_date then
    raise exception 'La apertura de caja no se puede modificar.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger cash_sessions_guard before update on public.cash_sessions
  for each row execute function private.cash_sessions_guard();

-- ---------------------------------------------------------------------
-- Pagos vinculados a reservas
--   cobro       → dinero que entra (seña, pago parcial, pago total)
--   devolucion  → dinero que se le devuelve al cliente
--   anulacion   → corrige un cobro o devolución cargado por error
-- signed_amount: efecto sobre lo cobrado (+ entra, − sale)
-- ---------------------------------------------------------------------
create table public.payments (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  reservation_id   uuid not null,
  kind             text not null check (kind in ('cobro','devolucion','anulacion')),
  amount           numeric(14,2) not null check (amount > 0),
  signed_amount    numeric(14,2) not null,
  method           text not null check (method in ('efectivo','transferencia','tarjeta')),
  voids_payment_id uuid references public.payments(id),
  cash_session_id  uuid not null,
  idempotency_key  uuid not null,
  note             text check (char_length(note) <= 500),
  reason           text check (char_length(reason) <= 300),
  created_by       uuid not null default auth.uid(),
  created_at       timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, reservation_id) references public.reservations(workspace_id, id),
  foreign key (workspace_id, cash_session_id) references public.cash_sessions(workspace_id, id),
  check (abs(signed_amount) = amount),
  check ((kind = 'anulacion') = (voids_payment_id is not null)),
  check (kind = 'cobro' or char_length(btrim(coalesce(reason, ''))) >= 3)
);
create unique index payments_one_void on public.payments(voids_payment_id) where voids_payment_id is not null;
create index payments_reservation_idx on public.payments(reservation_id);
create index payments_ws_created_idx on public.payments(workspace_id, created_at);

create trigger payments_immutable before update or delete on public.payments
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------
-- Gastos efectivamente pagados
-- ---------------------------------------------------------------------
create table public.expenses (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  cash_session_id uuid not null,
  amount          numeric(14,2) not null check (amount > 0),
  spent_on        date not null,
  concept         text not null check (char_length(btrim(concept)) between 2 and 200),
  category_id     uuid not null,
  supplier        text check (char_length(supplier) <= 120),
  method          text not null check (method in ('efectivo','transferencia','tarjeta')),
  notes           text check (char_length(notes) <= 1000),
  idempotency_key uuid not null,
  created_by      uuid not null default auth.uid(),
  created_at      timestamptz not null default now(),
  voided_at       timestamptz,
  voided_by       uuid,
  void_reason     text,
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, cash_session_id) references public.cash_sessions(workspace_id, id),
  foreign key (workspace_id, category_id) references public.expense_categories(workspace_id, id),
  check ((voided_at is null) = (void_reason is null))
);
create index expenses_ws_date_idx on public.expenses(workspace_id, spent_on);

-- Un gasto solo puede anularse (una vez); nada más se modifica.
create or replace function private.expenses_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Los gastos no se borran; se anulan.' using errcode = '42501';
  end if;
  if old.voided_at is not null
     or (to_jsonb(new) - 'voided_at' - 'voided_by' - 'void_reason') <> (to_jsonb(old) - 'voided_at' - 'voided_by' - 'void_reason') then
    raise exception 'Un gasto registrado no se puede modificar; solo anular.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger expenses_guard before update or delete on public.expenses
  for each row execute function private.expenses_guard();
create trigger expenses_audit after insert or update on public.expenses
  for each row execute function private.audit();

-- ---------------------------------------------------------------------
-- Movimientos de caja (entradas y salidas, por medio de pago)
-- ---------------------------------------------------------------------
create table public.cash_movements (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  cash_session_id uuid not null,
  direction       text not null check (direction in ('entrada','salida')),
  method          text not null check (method in ('efectivo','transferencia','tarjeta')),
  amount          numeric(14,2) not null check (amount > 0),
  category        text not null check (category in ('cobro','devolucion','anulacion_cobro','anulacion_devolucion',
                                                    'gasto','anulacion_gasto','otro_ingreso')),
  concept         text not null check (char_length(concept) <= 200),
  payment_id      uuid unique,
  expense_id      uuid,
  idempotency_key uuid,
  created_by      uuid not null default auth.uid(),
  created_at      timestamptz not null default now(),
  foreign key (workspace_id, cash_session_id) references public.cash_sessions(workspace_id, id),
  foreign key (workspace_id, payment_id) references public.payments(workspace_id, id),
  foreign key (workspace_id, expense_id) references public.expenses(workspace_id, id),
  unique (workspace_id, idempotency_key),
  check ((category in ('cobro','devolucion','anulacion_cobro','anulacion_devolucion')) = (payment_id is not null)),
  check ((category in ('gasto','anulacion_gasto')) = (expense_id is not null)),
  check (category <> 'otro_ingreso' or idempotency_key is not null)
);
create unique index cash_movements_expense_once on public.cash_movements(expense_id, category) where expense_id is not null;
create index cash_movements_session_idx on public.cash_movements(cash_session_id);

create trigger cash_movements_immutable before update or delete on public.cash_movements
  for each row execute function private.forbid_change();

-- Una caja cerrada no acepta movimientos nuevos.
create or replace function private.cash_movements_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.cash_sessions s where s.id = new.cash_session_id and s.closed_at is not null) then
    raise exception 'La caja ya está cerrada; no se pueden agregar movimientos.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger cash_movements_guard before insert on public.cash_movements
  for each row execute function private.cash_movements_guard();

-- ---------------------------------------------------------------------
-- Saldo de cada reserva calculado con los pagos reales
-- ---------------------------------------------------------------------
create view public.reservation_balances with (security_invoker = true) as
select
  r.id as reservation_id,
  r.workspace_id,
  r.status,
  r.total_amount,
  coalesce(p.paid, 0)::numeric(14,2) as paid_amount,
  case when r.status = 'cancelada' then 0
       else greatest(r.total_amount - coalesce(p.paid, 0), 0) end::numeric(14,2) as due_amount,
  case when r.status = 'cancelada' then coalesce(p.paid, 0)
       else greatest(coalesce(p.paid, 0) - r.total_amount, 0) end::numeric(14,2) as credit_amount
from public.reservations r
left join (
  select reservation_id, sum(signed_amount) as paid from public.payments group by reservation_id
) p on p.reservation_id = r.id;

-- ---------------------------------------------------------------------
-- Funciones internas
-- ---------------------------------------------------------------------

-- Devuelve la caja abierta de hoy (y la bloquea para que no se cierre
-- mientras se registra el movimiento). Explica el problema si no la hay.
create or replace function private.today_session(p_workspace_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := private.ws_today(p_workspace_id);
  v_session public.cash_sessions%rowtype;
begin
  select * into v_session from public.cash_sessions
  where workspace_id = p_workspace_id and closed_at is null
  for share;
  if not found then
    raise exception 'La caja de hoy no está abierta. Abrila para registrar cobros o gastos.'
      using hint = 'CAJA_CERRADA';
  end if;
  if v_session.business_date <> v_today then
    raise exception 'La caja del % quedó sin cerrar. Cerrala antes de registrar movimientos de hoy.',
      to_char(v_session.business_date, 'DD/MM/YYYY') using hint = 'CAJA_ANTERIOR_ABIERTA';
  end if;
  return v_session.id;
end $$;

-- Registra un cobro, devolución o anulación de forma idempotente:
-- si se reintenta con la misma clave, devuelve el pago ya existente.
create or replace function private.record_payment(
  p_workspace_id uuid, p_reservation_id uuid, p_kind text, p_amount numeric, p_method text,
  p_idempotency_key uuid, p_note text, p_reason text, p_voids_payment_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.payments%rowtype;
  v_res public.reservations%rowtype;
  v_orig public.payments%rowtype;
  v_session uuid;
  v_paid numeric(14,2);
  v_signed numeric(14,2);
  v_amount numeric(14,2) := round(p_amount, 2);
  v_id uuid;
  v_category text;
  v_concept text;
begin
  if p_idempotency_key is null then
    raise exception 'Falta la clave de operación.';
  end if;

  select * into v_existing from public.payments
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.reservation_id <> p_reservation_id or v_existing.kind <> p_kind
       or (p_kind <> 'anulacion' and (v_existing.amount <> v_amount or v_existing.method <> p_method)) then
      raise exception 'Esta operación ya fue registrada con otros datos.';
    end if;
    return v_existing.id;
  end if;

  v_session := private.today_session(p_workspace_id);

  -- Bloquea la reserva: dos pagos simultáneos se procesan de a uno.
  select * into v_res from public.reservations
  where id = p_reservation_id and workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'La reserva no existe.';
  end if;

  -- Reintento simultáneo con la misma clave: el otro ya terminó.
  select * into v_existing from public.payments
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return v_existing.id;
  end if;

  select coalesce(sum(signed_amount), 0) into v_paid from public.payments where reservation_id = p_reservation_id;

  if p_kind = 'cobro' then
    if v_res.status = 'cancelada' then
      raise exception 'No se pueden registrar cobros en una reserva cancelada.';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'El importe debe ser mayor a cero.';
    end if;
    if v_amount > v_res.total_amount - v_paid then
      raise exception 'El cobro (%) supera el saldo pendiente (%).',
        to_char(v_amount, 'FM999G999G990D00'), to_char(greatest(v_res.total_amount - v_paid, 0), 'FM999G999G990D00');
    end if;
    v_signed := v_amount;
    v_category := 'cobro';
    v_concept := format('Cobro reserva #%s', v_res.number);

  elsif p_kind = 'devolucion' then
    if v_amount is null or v_amount <= 0 then
      raise exception 'El importe debe ser mayor a cero.';
    end if;
    if v_amount > v_paid then
      raise exception 'La devolución supera lo cobrado en la reserva.';
    end if;
    v_signed := -v_amount;
    v_category := 'devolucion';
    v_concept := format('Devolución reserva #%s', v_res.number);

  elsif p_kind = 'anulacion' then
    select * into v_orig from public.payments
    where id = p_voids_payment_id and reservation_id = p_reservation_id;
    if not found then
      raise exception 'El pago a anular no existe en esta reserva.';
    end if;
    if v_orig.kind = 'anulacion' then
      raise exception 'Una anulación no se puede anular.';
    end if;
    if exists (select 1 from public.payments where voids_payment_id = v_orig.id) then
      raise exception 'Ese pago ya fue anulado.';
    end if;
    v_amount := v_orig.amount;
    p_method := v_orig.method;
    v_signed := -v_orig.signed_amount;
    v_category := case v_orig.kind when 'cobro' then 'anulacion_cobro' else 'anulacion_devolucion' end;
    v_concept := format('Anulación de %s · reserva #%s', v_orig.kind, v_res.number);
  else
    raise exception 'Tipo de pago inválido.';
  end if;

  if p_method not in ('efectivo','transferencia','tarjeta') then
    raise exception 'Medio de pago inválido.';
  end if;

  insert into public.payments (workspace_id, reservation_id, kind, amount, signed_amount, method,
                               voids_payment_id, cash_session_id, idempotency_key, note, reason)
  values (p_workspace_id, p_reservation_id, p_kind, v_amount, v_signed, p_method,
          p_voids_payment_id, v_session, p_idempotency_key, nullif(btrim(p_note), ''), nullif(btrim(p_reason), ''))
  returning id into v_id;

  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, payment_id)
  values (p_workspace_id, v_session, case when v_signed > 0 then 'entrada' else 'salida' end,
          p_method, v_amount, v_category, v_concept, v_id);

  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Funciones públicas: pagos
-- ---------------------------------------------------------------------
create or replace function public.register_payment(
  p_workspace_id uuid, p_reservation_id uuid, p_amount numeric, p_method text,
  p_idempotency_key uuid, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_member(p_workspace_id);
  v_id := private.record_payment(p_workspace_id, p_reservation_id, 'cobro', p_amount, p_method,
                                 p_idempotency_key, p_note, null);
  return jsonb_build_object('payment_id', v_id);
end $$;

create or replace function public.refund_payment(
  p_workspace_id uuid, p_reservation_id uuid, p_amount numeric, p_method text,
  p_idempotency_key uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  perform set_config('app.reason', coalesce(p_reason, ''), true);
  v_id := private.record_payment(p_workspace_id, p_reservation_id, 'devolucion', p_amount, p_method,
                                 p_idempotency_key, null, p_reason);
  return jsonb_build_object('payment_id', v_id);
end $$;

create or replace function public.void_payment(
  p_workspace_id uuid, p_payment_id uuid, p_idempotency_key uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_res uuid; v_id uuid;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  select reservation_id into v_res from public.payments where id = p_payment_id and workspace_id = p_workspace_id;
  if not found then
    raise exception 'El pago no existe.';
  end if;
  perform set_config('app.reason', coalesce(p_reason, ''), true);
  v_id := private.record_payment(p_workspace_id, v_res, 'anulacion', null, null,
                                 p_idempotency_key, null, p_reason, p_payment_id);
  return jsonb_build_object('payment_id', v_id);
end $$;

-- ---------------------------------------------------------------------
-- Funciones públicas: caja
-- ---------------------------------------------------------------------
create or replace function public.open_cash_session(
  p_workspace_id uuid, p_opening_cash numeric, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date;
  v_session public.cash_sessions%rowtype;
begin
  perform private.require_member(p_workspace_id);
  v_today := private.ws_today(p_workspace_id);

  -- Evita aperturas simultáneas desde dos dispositivos.
  perform pg_advisory_xact_lock(hashtextextended('caja:' || p_workspace_id::text, 0));

  select * into v_session from public.cash_sessions
  where workspace_id = p_workspace_id and business_date = v_today;
  if found then
    if v_session.closed_at is not null then
      raise exception 'La caja de hoy ya fue abierta y cerrada.' using hint = 'CAJA_YA_CERRADA';
    end if;
    -- Ya estaba abierta: no se pide ni se registra otra apertura.
    return jsonb_build_object('session_id', v_session.id, 'already_open', true);
  end if;

  select * into v_session from public.cash_sessions
  where workspace_id = p_workspace_id and closed_at is null;
  if found then
    raise exception 'La caja del % quedó sin cerrar. Cerrala antes de abrir la de hoy.',
      to_char(v_session.business_date, 'DD/MM/YYYY') using hint = 'CAJA_ANTERIOR_ABIERTA';
  end if;

  if p_opening_cash is null or p_opening_cash < 0 then
    raise exception 'Ingresá el efectivo inicial (puede ser 0).';
  end if;

  insert into public.cash_sessions (workspace_id, business_date, opening_cash, opening_notes)
  values (p_workspace_id, v_today, round(p_opening_cash, 2), nullif(btrim(p_notes), ''))
  returning * into v_session;

  return jsonb_build_object('session_id', v_session.id, 'already_open', false);
end $$;

-- Resumen de una caja: apertura, entradas y salidas por medio, efectivo esperado.
create or replace function public.cash_session_summary(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_s public.cash_sessions%rowtype;
  v_methods jsonb;
  v_cash_in numeric(14,2);
  v_cash_out numeric(14,2);
begin
  select * into v_s from public.cash_sessions where id = p_session_id;
  if not found then
    raise exception 'La caja no existe.';
  end if;
  perform private.require_member(v_s.workspace_id);

  select coalesce(sum(amount) filter (where direction = 'entrada' and method = 'efectivo'), 0),
         coalesce(sum(amount) filter (where direction = 'salida' and method = 'efectivo'), 0)
    into v_cash_in, v_cash_out
  from public.cash_movements where cash_session_id = p_session_id;

  select coalesce(jsonb_object_agg(m.method, jsonb_build_object(
           'entradas', coalesce(x.entradas, 0), 'salidas', coalesce(x.salidas, 0))), '{}'::jsonb)
    into v_methods
  from (values ('efectivo'), ('transferencia'), ('tarjeta')) m(method)
  left join (
    select method,
           sum(amount) filter (where direction = 'entrada') as entradas,
           sum(amount) filter (where direction = 'salida') as salidas
    from public.cash_movements where cash_session_id = p_session_id group by method
  ) x on x.method = m.method;

  return jsonb_build_object(
    'session_id', v_s.id,
    'business_date', v_s.business_date,
    'opening_cash', v_s.opening_cash,
    'opened_at', v_s.opened_at,
    'opened_by', v_s.opened_by,
    'por_medio', v_methods,
    'efectivo_esperado', v_s.opening_cash + v_cash_in - v_cash_out,
    'closed_at', v_s.closed_at,
    'counted_cash', v_s.counted_cash,
    'difference', v_s.difference,
    'close_notes', v_s.close_notes,
    'version', v_s.version
  );
end $$;

create or replace function public.close_cash_session(
  p_session_id uuid, p_counted_cash numeric, p_expected_version integer, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_s public.cash_sessions%rowtype;
  v_expected numeric(14,2);
begin
  select * into v_s from public.cash_sessions where id = p_session_id for update;
  if not found then
    raise exception 'La caja no existe.';
  end if;
  perform private.require_member(v_s.workspace_id);
  if v_s.closed_at is not null then
    raise exception 'Esta caja ya está cerrada.';
  end if;
  if p_counted_cash is null or p_counted_cash < 0 then
    raise exception 'Ingresá el efectivo contado.';
  end if;

  select v_s.opening_cash
         + coalesce(sum(amount) filter (where direction = 'entrada' and method = 'efectivo'), 0)
         - coalesce(sum(amount) filter (where direction = 'salida' and method = 'efectivo'), 0)
    into v_expected
  from public.cash_movements where cash_session_id = p_session_id;

  update public.cash_sessions set
    closed_at = now(),
    closed_by = auth.uid(),
    counted_cash = round(p_counted_cash, 2),
    expected_cash = v_expected,
    difference = round(p_counted_cash, 2) - v_expected,
    close_notes = nullif(btrim(p_notes), ''),
    version = p_expected_version + 1
  where id = p_session_id;

  return public.cash_session_summary(p_session_id);
end $$;

-- ---------------------------------------------------------------------
-- Funciones públicas: gastos y otros ingresos
-- ---------------------------------------------------------------------
create or replace function public.register_expense(
  p_workspace_id uuid, p_idempotency_key uuid, p_amount numeric, p_spent_on date, p_concept text,
  p_category_id uuid, p_method text, p_supplier text default null, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.expenses%rowtype;
  v_session uuid;
  v_id uuid;
begin
  perform private.require_member(p_workspace_id);

  select * into v_existing from public.expenses
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('expense_id', v_existing.id, 'repetida', true);
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El importe debe ser mayor a cero.';
  end if;
  if p_spent_on is null or p_spent_on > private.ws_today(p_workspace_id) then
    raise exception 'Solo se registran gastos ya pagados (la fecha no puede ser futura).';
  end if;
  if p_method not in ('efectivo','transferencia','tarjeta') then
    raise exception 'Medio de pago inválido.';
  end if;
  if not exists (select 1 from public.expense_categories c
                 where c.id = p_category_id and c.workspace_id = p_workspace_id and c.active) then
    raise exception 'Elegí una categoría válida.';
  end if;

  v_session := private.today_session(p_workspace_id);

  insert into public.expenses (workspace_id, cash_session_id, amount, spent_on, concept, category_id,
                               supplier, method, notes, idempotency_key)
  values (p_workspace_id, v_session, round(p_amount, 2), p_spent_on, btrim(p_concept), p_category_id,
          nullif(btrim(p_supplier), ''), p_method, nullif(btrim(p_notes), ''), p_idempotency_key)
  returning id into v_id;

  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, expense_id)
  values (p_workspace_id, v_session, 'salida', p_method, round(p_amount, 2), 'gasto', left('Gasto: ' || btrim(p_concept), 200), v_id);

  return jsonb_build_object('expense_id', v_id, 'repetida', false);
end $$;

create or replace function public.void_expense(
  p_workspace_id uuid, p_expense_id uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_e public.expenses%rowtype;
  v_session uuid;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Indicá el motivo de la anulación.';
  end if;
  select * into v_e from public.expenses where id = p_expense_id and workspace_id = p_workspace_id for update;
  if not found then
    raise exception 'El gasto no existe.';
  end if;
  if v_e.voided_at is not null then
    return jsonb_build_object('expense_id', v_e.id, 'repetida', true);
  end if;

  v_session := private.today_session(p_workspace_id);
  perform set_config('app.reason', p_reason, true);

  update public.expenses set voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason)
  where id = p_expense_id;

  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, expense_id)
  values (p_workspace_id, v_session, 'entrada', v_e.method, v_e.amount, 'anulacion_gasto',
          left('Anulación gasto: ' || v_e.concept, 200), v_e.id);

  return jsonb_build_object('expense_id', v_e.id, 'repetida', false);
end $$;

create or replace function public.register_other_income(
  p_workspace_id uuid, p_idempotency_key uuid, p_amount numeric, p_method text, p_concept text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing uuid;
  v_session uuid;
  v_id uuid;
begin
  perform private.require_member(p_workspace_id);
  select id into v_existing from public.cash_movements
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('movement_id', v_existing, 'repetida', true);
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'El importe debe ser mayor a cero.';
  end if;
  if char_length(btrim(coalesce(p_concept, ''))) < 3 then
    raise exception 'Indicá el concepto del ingreso.';
  end if;
  if p_method not in ('efectivo','transferencia','tarjeta') then
    raise exception 'Medio de pago inválido.';
  end if;
  v_session := private.today_session(p_workspace_id);
  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, idempotency_key)
  values (p_workspace_id, v_session, 'entrada', p_method, round(p_amount, 2), 'otro_ingreso', btrim(p_concept), p_idempotency_key)
  returning id into v_id;
  return jsonb_build_object('movement_id', v_id, 'repetida', false);
end $$;

-- ---------------------------------------------------------------------
-- Seguridad
-- ---------------------------------------------------------------------
alter table public.cash_sessions  enable row level security;
alter table public.payments       enable row level security;
alter table public.expenses       enable row level security;
alter table public.cash_movements enable row level security;

create policy "miembros leen cajas" on public.cash_sessions for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen pagos" on public.payments for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen gastos" on public.expenses for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen movimientos" on public.cash_movements for select to authenticated using (private.is_member(workspace_id));

revoke all on public.cash_sessions, public.payments, public.expenses, public.cash_movements from anon, authenticated;
grant select on public.cash_sessions, public.payments, public.expenses, public.cash_movements to authenticated;
revoke all on public.reservation_balances from anon;
grant select on public.reservation_balances to authenticated;

revoke all on function public.register_payment(uuid, uuid, numeric, text, uuid, text),
  public.refund_payment(uuid, uuid, numeric, text, uuid, text),
  public.void_payment(uuid, uuid, uuid, text),
  public.open_cash_session(uuid, numeric, text),
  public.cash_session_summary(uuid),
  public.close_cash_session(uuid, numeric, integer, text),
  public.register_expense(uuid, uuid, numeric, date, text, uuid, text, text, text),
  public.void_expense(uuid, uuid, text),
  public.register_other_income(uuid, uuid, numeric, text, text)
  from public, anon;
grant execute on function public.register_payment(uuid, uuid, numeric, text, uuid, text),
  public.refund_payment(uuid, uuid, numeric, text, uuid, text),
  public.void_payment(uuid, uuid, uuid, text),
  public.open_cash_session(uuid, numeric, text),
  public.cash_session_summary(uuid),
  public.close_cash_session(uuid, numeric, integer, text),
  public.register_expense(uuid, uuid, numeric, date, text, uuid, text, text, text),
  public.void_expense(uuid, uuid, text),
  public.register_other_income(uuid, uuid, numeric, text, text)
  to authenticated;

-- >>> 0005_operaciones_reservas.sql
-- =====================================================================
-- 0005 · Operaciones sobre reservas (todas en una sola transacción):
--   create_reservation   · alta con tramos, precio, descuentos y pago opcional
--   relocate_reservation · cambio de carpa por un día o por el resto de la estadía
--   cancel_reservation   · cancelación sin borrar historial ni pagos
--   revert_change        · revertir un cambio desde el historial
--   last_reversible_change · para "Deshacer último cambio"
-- =====================================================================

-- Tramos activos de una reserva, en formato legible para el historial.
create or replace function private.segments_snapshot(p_reservation_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'segment_id', s.id, 'space_id', s.space_id, 'space_code', sp.code,
           'start_date', s.start_date, 'end_date', s.end_date) order by s.start_date), '[]'::jsonb)
  from public.reservation_segments s
  join public.spaces sp on sp.id = s.space_id
  where s.reservation_id = p_reservation_id and s.active
$$;

-- ---------------------------------------------------------------------
-- Crear reserva
-- p_segments:  [{"space_id": uuid, "start_date": "AAAA-MM-DD", "end_date": "AAAA-MM-DD"}]
-- p_charges:   [{"description", "space_kind", "start_date", "end_date", "days",
--                "unit_price", "amount", "is_manual", "rate_snapshot"}]
-- p_discounts: [{"kind": "efectivo|convenio|manual", "agreement_id", "percent", "amount", "reason"}]
-- p_payment:   {"amount", "method", "idempotency_key"} o null (cobrar después)
-- ---------------------------------------------------------------------
create or replace function public.create_reservation(
  p_workspace_id uuid,
  p_request_id uuid,
  p_customer_id uuid,
  p_start_date date,
  p_end_date date,
  p_segments jsonb,
  p_charges jsonb,
  p_discounts jsonb default '[]'::jsonb,
  p_is_courtesy boolean default false,
  p_notes text default null,
  p_payment jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.reservations%rowtype;
  v_res_id uuid := gen_random_uuid();
  v_change_id uuid := gen_random_uuid();
  v_number bigint;
  v_list numeric(14,2) := 0;
  v_discount numeric(14,2) := 0;
  v_total numeric(14,2);
  v_seg jsonb;
  v_item jsonb;
  v_pos integer := 0;
  v_conflict text;
  v_space_ids uuid[];
  v_agreement public.agreements%rowtype;
  v_payment_id uuid;
  v_kind text;
  v_amount numeric(14,2);
  v_label text;
  v_percent numeric(5,2);
begin
  perform private.require_member(p_workspace_id);

  -- Reintento (doble clic, recarga, red lenta): devuelve la misma reserva.
  select * into v_existing from public.reservations
  where workspace_id = p_workspace_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('reservation_id', v_existing.id, 'number', v_existing.number, 'repetida', true);
  end if;

  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'Revisá las fechas: la salida no puede ser anterior a la entrada.';
  end if;
  if not exists (select 1 from public.customers c where c.id = p_customer_id and c.workspace_id = p_workspace_id) then
    raise exception 'Elegí un cliente válido.';
  end if;
  if p_segments is null or jsonb_typeof(p_segments) <> 'array' or jsonb_array_length(p_segments) = 0 then
    raise exception 'Asigná al menos una carpa o sombrilla.';
  end if;
  if p_charges is null or jsonb_typeof(p_charges) <> 'array' then
    raise exception 'Falta el detalle de precio.';
  end if;
  p_discounts := coalesce(p_discounts, '[]'::jsonb);

  -- Cada tramo dentro de la estadía y sin días repetidos entre tramos.
  if exists (select 1 from jsonb_array_elements(p_segments) s
             where (s ->> 'start_date') is null or (s ->> 'end_date') is null or (s ->> 'space_id') is null
                or (s ->> 'end_date')::date < (s ->> 'start_date')::date
                or (s ->> 'start_date')::date < p_start_date or (s ->> 'end_date')::date > p_end_date) then
    raise exception 'Cada tramo de carpa tiene que estar dentro de las fechas de la estadía.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_segments) with ordinality a(s, i)
             join jsonb_array_elements(p_segments) with ordinality b(s, j) on a.i < b.j
             where daterange((a.s ->> 'start_date')::date, (a.s ->> 'end_date')::date, '[]')
                && daterange((b.s ->> 'start_date')::date, (b.s ->> 'end_date')::date, '[]')) then
    raise exception 'Los tramos de carpa se superponen: un cliente no puede tener dos carpas el mismo día.';
  end if;

  -- Bloquea todos los espacios involucrados (en orden, para evitar bloqueos cruzados)
  select array_agg((s ->> 'space_id')::uuid) into v_space_ids from jsonb_array_elements(p_segments) s;
  perform private.lock_spaces(v_space_ids);

  -- Revalida la disponibilidad al guardar, con el detalle de cada conflicto.
  for v_seg in select * from jsonb_array_elements(p_segments) loop
    if not exists (select 1 from public.spaces sp where sp.id = (v_seg ->> 'space_id')::uuid
                   and sp.workspace_id = p_workspace_id) then
      raise exception 'Uno de los espacios elegidos no existe.';
    end if;
    v_conflict := private.space_conflict((v_seg ->> 'space_id')::uuid,
                                         (v_seg ->> 'start_date')::date, (v_seg ->> 'end_date')::date);
    if v_conflict is not null then
      raise exception 'Ya no está disponible: %', v_conflict using errcode = '23P01', hint = 'CONFLICTO_DISPONIBILIDAD';
    end if;
  end loop;

  -- Precio de lista
  for v_item in select * from jsonb_array_elements(p_charges) loop
    v_amount := round((v_item ->> 'amount')::numeric, 2);
    if v_amount is null or v_amount < 0 then
      raise exception 'Hay un importe inválido en el detalle de precio.';
    end if;
    v_list := v_list + v_amount;
  end loop;

  -- Descuentos (cada uno queda registrado con su importe, motivo y responsable)
  for v_item in select * from jsonb_array_elements(p_discounts) loop
    v_kind := v_item ->> 'kind';
    v_amount := round((v_item ->> 'amount')::numeric, 2);
    if v_amount is null or v_amount < 0 then
      raise exception 'Hay un descuento con importe inválido.';
    end if;
    if v_kind = 'cortesia' then
      raise exception 'La cortesía se indica marcando la reserva como cortesía, no como descuento.';
    elsif v_kind = 'convenio' then
      select * into v_agreement from public.agreements
      where id = (v_item ->> 'agreement_id')::uuid and workspace_id = p_workspace_id;
      if not found or not v_agreement.active then
        raise exception 'El convenio elegido no está vigente.';
      end if;
    elsif v_kind = 'manual' then
      if not private.has_role(p_workspace_id, array['propietario','administrador']) then
        raise exception 'Solo un administrador puede aplicar descuentos manuales.' using errcode = '42501';
      end if;
      if char_length(btrim(coalesce(v_item ->> 'reason', ''))) < 3 then
        raise exception 'Los descuentos manuales necesitan un motivo.';
      end if;
    elsif v_kind <> 'efectivo' then
      raise exception 'Tipo de descuento inválido.';
    end if;
    v_discount := v_discount + v_amount;
  end loop;

  if p_is_courtesy then
    if jsonb_array_length(p_discounts) > 0 then
      raise exception 'Una cortesía no lleva otros descuentos.';
    end if;
    if p_payment is not null then
      raise exception 'Una cortesía no genera cobros.';
    end if;
    v_discount := v_list;
  end if;

  if v_discount > v_list then
    raise exception 'Los descuentos superan el precio.';
  end if;
  v_total := v_list - v_discount;

  insert into public.reservations (id, workspace_id, customer_id, start_date, end_date, is_courtesy,
                                   list_amount, discount_amount, total_amount, notes, request_id, created_by)
  values (v_res_id, p_workspace_id, p_customer_id, p_start_date, p_end_date, coalesce(p_is_courtesy, false),
          v_list, v_discount, v_total, nullif(btrim(p_notes), ''), p_request_id, auth.uid())
  returning number into v_number;

  insert into public.reservation_changes (id, workspace_id, reservation_id, kind, description)
  values (v_change_id, p_workspace_id, v_res_id, 'creacion', format('Reserva #%s creada', v_number));

  for v_seg in select * from jsonb_array_elements(p_segments) loop
    insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
    values (p_workspace_id, v_res_id, (v_seg ->> 'space_id')::uuid,
            (v_seg ->> 'start_date')::date, (v_seg ->> 'end_date')::date, v_change_id);
  end loop;
  perform private.assert_coverage(v_res_id);

  v_pos := 0;
  for v_item in select * from jsonb_array_elements(p_charges) loop
    v_pos := v_pos + 1;
    insert into public.reservation_charges (workspace_id, reservation_id, position, description, space_kind,
                                            start_date, end_date, days, unit_price, amount, is_manual, rate_snapshot)
    values (p_workspace_id, v_res_id, v_pos,
            coalesce(nullif(btrim(v_item ->> 'description'), ''), 'Alquiler'),
            v_item ->> 'space_kind',
            (v_item ->> 'start_date')::date, (v_item ->> 'end_date')::date,
            (v_item ->> 'days')::integer,
            round((v_item ->> 'unit_price')::numeric, 2),
            round((v_item ->> 'amount')::numeric, 2),
            coalesce((v_item ->> 'is_manual')::boolean, false),
            v_item -> 'rate_snapshot');
  end loop;

  v_pos := 0;
  if p_is_courtesy then
    insert into public.reservation_discounts (workspace_id, reservation_id, position, kind, label, percent, amount, reason)
    values (p_workspace_id, v_res_id, 1, 'cortesia', 'Cortesía familiar', 100, v_list, 'Cortesía familiar');
  else
    for v_item in select * from jsonb_array_elements(p_discounts) loop
      v_pos := v_pos + 1;
      v_kind := v_item ->> 'kind';
      v_percent := (v_item ->> 'percent')::numeric;
      v_label := case v_kind when 'efectivo' then 'Pago en efectivo' when 'manual' then 'Descuento manual' else null end;
      if v_kind = 'convenio' then
        select * into v_agreement from public.agreements where id = (v_item ->> 'agreement_id')::uuid;
        v_label := 'Convenio ' || v_agreement.name;
        v_percent := v_agreement.percent;
      end if;
      insert into public.reservation_discounts (workspace_id, reservation_id, position, kind, agreement_id,
                                                label, percent, amount, reason)
      values (p_workspace_id, v_res_id, v_pos, v_kind,
              case when v_kind = 'convenio' then v_agreement.id end,
              v_label, v_percent, round((v_item ->> 'amount')::numeric, 2),
              nullif(btrim(v_item ->> 'reason'), ''));
    end loop;
  end if;

  if p_payment is not null then
    if coalesce((p_payment ->> 'amount')::numeric, 0) <= 0 then
      raise exception 'Ingresá el importe cobrado (o elegí "Cobrar después").';
    end if;
    v_payment_id := private.record_payment(p_workspace_id, v_res_id, 'cobro', (p_payment ->> 'amount')::numeric,
                                           p_payment ->> 'method', (p_payment ->> 'idempotency_key')::uuid,
                                           'Pago al reservar', null);
  end if;

  update public.reservation_changes set after_state = jsonb_build_object(
    'segments', private.segments_snapshot(v_res_id), 'total_amount', v_total)
  where id = v_change_id;

  return jsonb_build_object('reservation_id', v_res_id, 'number', v_number, 'total_amount', v_total,
                            'payment_id', v_payment_id, 'repetida', false);
end $$;

-- ---------------------------------------------------------------------
-- Cambio de carpa durante la estadía
--   Un solo día:            p_from = p_to = ese día
--   Resto de la estadía:    p_from = fecha del cambio, p_to = fin de la reserva
-- La reserva sigue siendo una sola; pagos y deuda no se tocan.
-- ---------------------------------------------------------------------
create or replace function public.relocate_reservation(
  p_reservation_id uuid, p_target_space_id uuid, p_from date, p_to date,
  p_expected_version integer, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_res public.reservations%rowtype;
  v_seg public.reservation_segments%rowtype;
  v_change_id uuid := gen_random_uuid();
  v_target public.spaces%rowtype;
  v_before jsonb;
  v_conflict text;
  v_space_ids uuid[];
begin
  select * into v_res from public.reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'La reserva no existe.';
  end if;
  perform private.require_member(v_res.workspace_id);
  if v_res.version <> p_expected_version then
    raise exception 'Esta reserva fue modificada desde otro dispositivo. Recargá e intentá de nuevo.'
      using errcode = '40001', hint = 'CONFLICTO_VERSION';
  end if;
  if v_res.status <> 'confirmada' then
    raise exception 'Solo se pueden cambiar de carpa reservas confirmadas.';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_from < v_res.start_date or p_to > v_res.end_date then
    raise exception 'Las fechas del cambio deben estar dentro de la estadía (% al %).',
      to_char(v_res.start_date, 'DD/MM/YYYY'), to_char(v_res.end_date, 'DD/MM/YYYY');
  end if;

  select * into v_target from public.spaces where id = p_target_space_id and workspace_id = v_res.workspace_id;
  if not found then
    raise exception 'El espacio de destino no existe.';
  end if;

  select array_agg(distinct space_id) || p_target_space_id into v_space_ids
  from public.reservation_segments where reservation_id = p_reservation_id and active;
  perform private.lock_spaces(v_space_ids);

  if not exists (select 1 from public.reservation_segments s
                 where s.reservation_id = p_reservation_id and s.active and s.space_id <> p_target_space_id
                   and daterange(s.start_date, s.end_date, '[]') && daterange(p_from, p_to, '[]')) then
    raise exception 'El cliente ya está en % en esas fechas.', v_target.code;
  end if;

  v_conflict := private.space_conflict(p_target_space_id, p_from, p_to, p_reservation_id);
  if v_conflict is not null then
    raise exception 'No se puede hacer el cambio: %', v_conflict using errcode = '23P01', hint = 'CONFLICTO_DISPONIBILIDAD';
  end if;

  v_before := private.segments_snapshot(p_reservation_id);
  perform set_config('app.reason', coalesce(p_reason, ''), true);

  insert into public.reservation_changes (id, workspace_id, reservation_id, kind, description, reason, before_state)
  values (v_change_id, v_res.workspace_id, p_reservation_id, 'reubicacion',
          case when p_from = p_to
               then format('Cambio a %s por el día %s', v_target.code, to_char(p_from, 'DD/MM/YYYY'))
               else format('Cambio a %s del %s al %s', v_target.code, to_char(p_from, 'DD/MM/YYYY'), to_char(p_to, 'DD/MM/YYYY'))
          end,
          nullif(btrim(p_reason), ''), jsonb_build_object('segments', v_before));

  -- Finaliza los tramos afectados y recrea las partes que quedan fuera del cambio.
  for v_seg in select * from public.reservation_segments s
               where s.reservation_id = p_reservation_id and s.active
                 and daterange(s.start_date, s.end_date, '[]') && daterange(p_from, p_to, '[]')
               order by s.start_date loop
    update public.reservation_segments set active = false, ended_by_change_id = v_change_id where id = v_seg.id;
    if v_seg.start_date < p_from then
      insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
      values (v_seg.workspace_id, p_reservation_id, v_seg.space_id, v_seg.start_date, p_from - 1, v_change_id);
    end if;
    if v_seg.end_date > p_to then
      insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
      values (v_seg.workspace_id, p_reservation_id, v_seg.space_id, p_to + 1, v_seg.end_date, v_change_id);
    end if;
  end loop;

  insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
  values (v_res.workspace_id, p_reservation_id, p_target_space_id, p_from, p_to, v_change_id);

  perform private.assert_coverage(p_reservation_id);

  update public.reservation_changes set after_state = jsonb_build_object('segments', private.segments_snapshot(p_reservation_id))
  where id = v_change_id;
  update public.reservations set version = version + 1 where id = p_reservation_id;

  return jsonb_build_object('change_id', v_change_id, 'segments', private.segments_snapshot(p_reservation_id));
end $$;

-- ---------------------------------------------------------------------
-- Cancelar reserva: libera los espacios, conserva pagos e historial.
-- Si hubo cobros, quedan como saldo a favor hasta que se registre
-- una devolución (decisión del administrador).
-- ---------------------------------------------------------------------
create or replace function public.cancel_reservation(
  p_reservation_id uuid, p_expected_version integer, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_res public.reservations%rowtype;
  v_change_id uuid := gen_random_uuid();
begin
  select * into v_res from public.reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'La reserva no existe.';
  end if;
  perform private.require_member(v_res.workspace_id);
  if v_res.version <> p_expected_version then
    raise exception 'Esta reserva fue modificada desde otro dispositivo. Recargá e intentá de nuevo.'
      using errcode = '40001', hint = 'CONFLICTO_VERSION';
  end if;
  if v_res.status = 'cancelada' then
    raise exception 'La reserva ya está cancelada.';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Indicá el motivo de la cancelación.';
  end if;

  perform set_config('app.reason', p_reason, true);
  insert into public.reservation_changes (id, workspace_id, reservation_id, kind, description, reason, before_state)
  values (v_change_id, v_res.workspace_id, p_reservation_id, 'cancelacion',
          format('Reserva #%s cancelada', v_res.number), btrim(p_reason),
          jsonb_build_object('segments', private.segments_snapshot(p_reservation_id)));

  update public.reservation_segments set active = false, ended_by_change_id = v_change_id
  where reservation_id = p_reservation_id and active;

  update public.reservations set status = 'cancelada', cancelled_at = now(), cancelled_by = auth.uid(),
         cancel_reason = btrim(p_reason), version = version + 1
  where id = p_reservation_id;

  update public.reservation_changes set after_state = jsonb_build_object('segments', '[]'::jsonb)
  where id = v_change_id;

  return jsonb_build_object('change_id', v_change_id);
end $$;

-- ---------------------------------------------------------------------
-- Revertir un cambio (cambio de carpa o cancelación).
-- Solo si es seguro: no debe haber cambios posteriores sobre los mismos
-- tramos y los espacios deben seguir libres. Nunca borra el cambio original.
-- ---------------------------------------------------------------------
create or replace function public.revert_change(p_change_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_chg public.reservation_changes%rowtype;
  v_res public.reservations%rowtype;
  v_new_id uuid := gen_random_uuid();
  v_seg public.reservation_segments%rowtype;
  v_conflict text;
  v_space_ids uuid[];
begin
  select * into v_chg from public.reservation_changes where id = p_change_id;
  if not found then
    raise exception 'El cambio no existe.';
  end if;
  perform private.require_member(v_chg.workspace_id);

  select * into v_res from public.reservations where id = v_chg.reservation_id for update;
  -- Vuelve a leer el cambio ya con la reserva bloqueada.
  select * into v_chg from public.reservation_changes where id = p_change_id;

  if v_chg.kind not in ('reubicacion','cancelacion') then
    raise exception 'Este tipo de cambio no se puede revertir desde el historial.';
  end if;
  if v_chg.reverted_by_change_id is not null then
    raise exception 'Este cambio ya fue revertido.';
  end if;

  -- Los tramos que dejó este cambio tienen que seguir vigentes tal cual
  -- (mismo espacio y mismas fechas); si no, hubo cambios posteriores encima.
  if exists (select 1 from public.reservation_segments c
             where c.created_by_change_id = p_change_id
               and not exists (select 1 from public.reservation_segments a
                               where a.reservation_id = c.reservation_id and a.active
                                 and a.space_id = c.space_id and a.start_date = c.start_date
                                 and a.end_date = c.end_date)) then
    raise exception 'Hay cambios posteriores sobre esta reserva. Revertí primero los más recientes.'
      using hint = 'REVERSION_INSEGURA';
  end if;

  select array_agg(distinct space_id) into v_space_ids from public.reservation_segments
  where ended_by_change_id = p_change_id or created_by_change_id = p_change_id;
  perform private.lock_spaces(v_space_ids);

  -- Los espacios a recuperar tienen que seguir libres.
  for v_seg in select * from public.reservation_segments where ended_by_change_id = p_change_id order by start_date loop
    v_conflict := private.space_conflict(v_seg.space_id, v_seg.start_date, v_seg.end_date, v_res.id);
    if v_conflict is not null then
      raise exception 'No se puede revertir: %', v_conflict using errcode = '23P01', hint = 'REVERSION_CONFLICTO';
    end if;
  end loop;

  perform set_config('app.reason', coalesce(p_reason, ''), true);
  insert into public.reservation_changes (id, workspace_id, reservation_id, kind, description, reason,
                                          before_state, reverts_change_id)
  values (v_new_id, v_chg.workspace_id, v_chg.reservation_id, 'reversion',
          'Reversión: ' || v_chg.description, nullif(btrim(p_reason), ''),
          jsonb_build_object('segments', private.segments_snapshot(v_chg.reservation_id)), p_change_id);

  if v_chg.kind = 'cancelacion' then
    if v_res.status <> 'cancelada' then
      raise exception 'La reserva ya no está cancelada.';
    end if;
    update public.reservations set status = 'confirmada', cancelled_at = null, cancelled_by = null,
           cancel_reason = null, version = version + 1
    where id = v_res.id;
  else
    update public.reservation_segments a set active = false, ended_by_change_id = v_new_id
    where a.reservation_id = v_res.id and a.active
      and exists (select 1 from public.reservation_segments c
                  where c.created_by_change_id = p_change_id and c.space_id = a.space_id
                    and c.start_date = a.start_date and c.end_date = a.end_date);
    update public.reservations set version = version + 1 where id = v_res.id;
  end if;

  -- Se recrean (como tramos nuevos) los tramos que el cambio había finalizado.
  for v_seg in select * from public.reservation_segments where ended_by_change_id = p_change_id order by start_date loop
    insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
    values (v_seg.workspace_id, v_seg.reservation_id, v_seg.space_id, v_seg.start_date, v_seg.end_date, v_new_id);
  end loop;

  perform private.assert_coverage(v_res.id);

  update public.reservation_changes set reverted_by_change_id = v_new_id where id = p_change_id;
  update public.reservation_changes set after_state = jsonb_build_object('segments', private.segments_snapshot(v_res.id))
  where id = v_new_id;

  return jsonb_build_object('change_id', v_new_id, 'segments', private.segments_snapshot(v_res.id));
end $$;

-- Último cambio reversible del balneario (para el botón "Deshacer").
create or replace function public.last_reversible_change(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.require_member(p_workspace_id);
  select jsonb_build_object('change_id', c.id, 'reservation_id', c.reservation_id, 'reservation_number', r.number,
                            'kind', c.kind, 'description', c.description, 'at', c.at, 'actor_email', c.actor_email)
    into v
  from public.reservation_changes c
  join public.reservations r on r.id = c.reservation_id
  where c.workspace_id = p_workspace_id and c.kind in ('reubicacion','cancelacion')
    and c.reverted_by_change_id is null
  order by c.at desc
  limit 1;
  return v;
end $$;

-- Editar observaciones de una reserva.
create or replace function public.update_reservation_notes(
  p_reservation_id uuid, p_expected_version integer, p_notes text
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid;
begin
  select workspace_id into v_ws from public.reservations where id = p_reservation_id;
  if not found then
    raise exception 'La reserva no existe.';
  end if;
  perform private.require_member(v_ws);
  update public.reservations set notes = nullif(btrim(p_notes), ''), version = p_expected_version + 1
  where id = p_reservation_id;
end $$;

revoke all on function
  public.create_reservation(uuid, uuid, uuid, date, date, jsonb, jsonb, jsonb, boolean, text, jsonb),
  public.relocate_reservation(uuid, uuid, date, date, integer, text),
  public.cancel_reservation(uuid, integer, text),
  public.revert_change(uuid, text),
  public.last_reversible_change(uuid),
  public.update_reservation_notes(uuid, integer, text)
  from public, anon;
grant execute on function
  public.create_reservation(uuid, uuid, uuid, date, date, jsonb, jsonb, jsonb, boolean, text, jsonb),
  public.relocate_reservation(uuid, uuid, date, date, integer, text),
  public.cancel_reservation(uuid, integer, text),
  public.revert_change(uuid, text),
  public.last_reversible_change(uuid),
  public.update_reservation_notes(uuid, integer, text)
  to authenticated;

-- >>> 0006_consultas.sql
-- =====================================================================
-- 0006 · Consultas centrales de disponibilidad.
-- Mapa, línea de tiempo, Nueva reserva y panel usan esta misma lógica.
-- =====================================================================

-- Estado de cada espacio en un día dado (para el mapa).
create or replace function public.map_day_status(p_workspace_id uuid, p_day date)
returns table (
  space_id uuid, code text, kind text, x numeric, y numeric, rotation numeric, active boolean,
  state text,                 -- disponible | ocupada | cortesia | reservada_futura | mantenimiento | desactivada
  reservation_id uuid, reservation_number bigint, customer_id uuid, customer_name text,
  reservation_start date, reservation_end date, days_remaining integer,
  due_amount numeric, maintenance_reason text, maintenance_end date, next_start date,
  version integer
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id);
  return query
  select sp.id, sp.code, sp.kind, sp.x, sp.y, sp.rotation, sp.active,
         case
           when not sp.active then 'desactivada'
           when m.id is not null then 'mantenimiento'
           when occ.reservation_id is not null and occ.is_courtesy then 'cortesia'
           when occ.reservation_id is not null then 'ocupada'
           when nxt.next_start is not null then 'reservada_futura'
           else 'disponible'
         end,
         occ.reservation_id, occ.number, occ.customer_id, occ.customer_name,
         occ.start_date, occ.end_date,
         case when occ.reservation_id is not null then (occ.end_date - p_day) end,
         occ.due_amount, m.reason, m.end_date, nxt.next_start, sp.version
  from public.spaces sp
  left join lateral (
    select mb.id, mb.reason, mb.end_date from public.maintenance_blocks mb
    where mb.space_id = sp.id and mb.active and p_day between mb.start_date and mb.end_date
    limit 1
  ) m on true
  left join lateral (
    select r.id as reservation_id, r.number, r.customer_id, r.is_courtesy, r.start_date, r.end_date,
           btrim(c.first_name || ' ' || c.last_name) as customer_name, b.due_amount
    from public.reservation_segments s
    join public.reservations r on r.id = s.reservation_id
    join public.customers c on c.id = r.customer_id
    join public.reservation_balances b on b.reservation_id = r.id
    where s.space_id = sp.id and s.active and p_day between s.start_date and s.end_date
    limit 1
  ) occ on true
  left join lateral (
    select min(s.start_date) as next_start from public.reservation_segments s
    where s.space_id = sp.id and s.active and s.start_date > p_day
  ) nxt on true
  where sp.workspace_id = p_workspace_id
  order by sp.kind, sp.code;
end $$;

-- Disponibilidad día por día (para Nueva reserva y alternativas).
-- Máximo 120 días por consulta.
create or replace function public.availability_grid(
  p_workspace_id uuid, p_from date, p_to date, p_kind text default null
) returns table (space_id uuid, code text, kind text, day date, free boolean, reason text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id);
  if p_to < p_from or p_to - p_from > 120 then
    raise exception 'El rango de fechas debe ser de hasta 120 días.';
  end if;
  return query
  select sp.id, sp.code, sp.kind, d::date,
         (sp.active and m.id is null and s.id is null),
         case when not sp.active then 'desactivada'
              when m.id is not null then 'mantenimiento'
              when s.id is not null then 'ocupada'
         end
  from public.spaces sp
  cross join generate_series(p_from, p_to, interval '1 day') d
  left join public.maintenance_blocks m
    on m.space_id = sp.id and m.active and d::date between m.start_date and m.end_date
  left join public.reservation_segments s
    on s.space_id = sp.id and s.active and d::date between s.start_date and s.end_date
  where sp.workspace_id = p_workspace_id
    and (p_kind is null or sp.kind = p_kind)
  order by sp.kind, sp.code, d;
end $$;

-- Elementos de la línea de tiempo: tramos y bloqueos dentro de un rango.
create or replace function public.timeline_items(p_workspace_id uuid, p_from date, p_to date)
returns table (
  item_type text, space_id uuid, start_date date, end_date date,
  reservation_id uuid, reservation_number bigint, customer_name text, is_courtesy boolean,
  reservation_start date, reservation_end date, is_relocation boolean, label text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id);
  if p_to < p_from or p_to - p_from > 400 then
    raise exception 'El rango de fechas debe ser de hasta 400 días.';
  end if;
  return query
  select 'tramo', s.space_id, s.start_date, s.end_date, r.id, r.number,
         btrim(c.first_name || ' ' || c.last_name), r.is_courtesy, r.start_date, r.end_date,
         (select count(*) from public.reservation_segments s2 where s2.reservation_id = r.id and s2.active) > 1,
         null::text
  from public.reservation_segments s
  join public.reservations r on r.id = s.reservation_id
  join public.customers c on c.id = r.customer_id
  where s.workspace_id = p_workspace_id and s.active
    and daterange(s.start_date, s.end_date, '[]') && daterange(p_from, p_to, '[]')
  union all
  select 'mantenimiento', m.space_id, m.start_date, m.end_date, null, null, null, false, null, null, false, m.reason
  from public.maintenance_blocks m
  where m.workspace_id = p_workspace_id and m.active
    and daterange(m.start_date, m.end_date, '[]') && daterange(p_from, p_to, '[]');
end $$;

-- Panel principal: todo lo del día en una sola consulta.
create or replace function public.dashboard_summary(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date;
  v_counts jsonb;
  v_starting jsonb;
  v_ending jsonb;
  v_debtors integer;
  v_session public.cash_sessions%rowtype;
  v_old_open public.cash_sessions%rowtype;
  v_income jsonb;
  v_expenses numeric(14,2);
begin
  perform private.require_member(p_workspace_id);
  v_today := private.ws_today(p_workspace_id);

  select jsonb_object_agg(kind, x) into v_counts from (
    select kind, jsonb_build_object(
      'total_activos', count(*) filter (where state <> 'desactivada'),
      'ocupados', count(*) filter (where state in ('ocupada','cortesia')),
      'cortesias', count(*) filter (where state = 'cortesia'),
      'disponibles', count(*) filter (where state in ('disponible','reservada_futura')),
      'mantenimiento', count(*) filter (where state = 'mantenimiento'),
      'desactivados', count(*) filter (where state = 'desactivada')
    ) as x
    from public.map_day_status(p_workspace_id, v_today) group by kind
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object(
           'reservation_id', r.id, 'number', r.number,
           'customer', btrim(c.first_name || ' ' || c.last_name), 'phone', c.phone,
           'start_date', r.start_date, 'end_date', r.end_date,
           'spaces', (select string_agg(sp.code, ', ' order by s.start_date) from public.reservation_segments s
                      join public.spaces sp on sp.id = s.space_id where s.reservation_id = r.id and s.active),
           'due_amount', b.due_amount, 'is_courtesy', r.is_courtesy) order by r.number), '[]'::jsonb)
    into v_starting
  from public.reservations r
  join public.customers c on c.id = r.customer_id
  join public.reservation_balances b on b.reservation_id = r.id
  where r.workspace_id = p_workspace_id and r.status = 'confirmada' and r.start_date = v_today;

  select coalesce(jsonb_agg(jsonb_build_object(
           'reservation_id', r.id, 'number', r.number,
           'customer', btrim(c.first_name || ' ' || c.last_name), 'phone', c.phone,
           'start_date', r.start_date, 'end_date', r.end_date,
           'spaces', (select string_agg(sp.code, ', ' order by s.start_date) from public.reservation_segments s
                      join public.spaces sp on sp.id = s.space_id where s.reservation_id = r.id and s.active),
           'due_amount', b.due_amount, 'is_courtesy', r.is_courtesy) order by b.due_amount desc, r.number), '[]'::jsonb)
    into v_ending
  from public.reservations r
  join public.customers c on c.id = r.customer_id
  join public.reservation_balances b on b.reservation_id = r.id
  where r.workspace_id = p_workspace_id and r.status = 'confirmada' and r.end_date = v_today;

  select count(distinct r.customer_id) into v_debtors
  from public.reservations r join public.reservation_balances b on b.reservation_id = r.id
  where r.workspace_id = p_workspace_id and b.due_amount > 0;

  select * into v_session from public.cash_sessions
  where workspace_id = p_workspace_id and business_date = v_today;
  select * into v_old_open from public.cash_sessions
  where workspace_id = p_workspace_id and closed_at is null and business_date < v_today;

  select jsonb_build_object(
           'efectivo', coalesce(sum(amount) filter (where method = 'efectivo'), 0),
           'transferencia', coalesce(sum(amount) filter (where method = 'transferencia'), 0),
           'tarjeta', coalesce(sum(amount) filter (where method = 'tarjeta'), 0),
           'total', coalesce(sum(amount), 0))
    into v_income
  from public.cash_movements
  where cash_session_id = v_session.id and direction = 'entrada';

  select coalesce(sum(e.amount), 0) into v_expenses
  from public.expenses e where e.workspace_id = p_workspace_id and e.spent_on = v_today and e.voided_at is null;

  return jsonb_build_object(
    'fecha', v_today,
    'espacios', coalesce(v_counts, '{}'::jsonb),
    'ingresan_hoy', v_starting,
    'finalizan_hoy', v_ending,
    'clientes_con_deuda', v_debtors,
    'ingresos_hoy', coalesce(v_income, jsonb_build_object('efectivo', 0, 'transferencia', 0, 'tarjeta', 0, 'total', 0)),
    'gastos_hoy', v_expenses,
    'caja', case
              when v_session.id is null then jsonb_build_object('estado', 'sin_abrir')
              when v_session.closed_at is null then jsonb_build_object('estado', 'abierta', 'session_id', v_session.id)
              else jsonb_build_object('estado', 'cerrada', 'session_id', v_session.id)
            end,
    'caja_anterior_sin_cerrar', case when v_old_open.id is not null
              then jsonb_build_object('session_id', v_old_open.id, 'fecha', v_old_open.business_date) end
  );
end $$;

revoke all on function
  public.map_day_status(uuid, date),
  public.availability_grid(uuid, date, date, text),
  public.timeline_items(uuid, date, date),
  public.dashboard_summary(uuid)
  from public, anon;
grant execute on function
  public.map_day_status(uuid, date),
  public.availability_grid(uuid, date, date, text),
  public.timeline_items(uuid, date, date),
  public.dashboard_summary(uuid)
  to authenticated;

-- >>> 0007_alta_balneario.sql
-- =====================================================================
-- 0007 · Alta del balneario con su inventario inicial.
-- Lo usa la primera persona que inicia sesión. Queda como propietaria.
-- =====================================================================

create or replace function public.create_workspace(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_user uuid := auth.uid();
  v_email text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email';
  i integer;
begin
  if v_user is null then
    raise exception 'Tenés que iniciar sesión.' using errcode = '28000';
  end if;
  if exists (select 1 from public.workspace_members where user_id = v_user) then
    raise exception 'Tu cuenta ya pertenece a un balneario.';
  end if;
  -- Instalación de un solo balneario: solo la primera cuenta puede crearlo.
  -- Las demás personas entran únicamente por invitación del propietario.
  perform pg_advisory_xact_lock(hashtextextended('alta-balneario', 0));
  if exists (select 1 from public.workspaces) then
    raise exception 'El balneario ya fue creado. Pedile al propietario que te invite.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'Ingresá el nombre del balneario.';
  end if;

  insert into public.workspaces (name, created_by) values (btrim(p_name), v_user) returning id into v_ws;
  insert into public.workspace_members (workspace_id, user_id, role, email) values (v_ws, v_user, 'propietario', v_email);

  -- Inventario inicial: 90 carpas (C01–C90) y 10 sombrillas (S01–S10).
  -- Es solo el punto de partida: se pueden mover, renombrar, agregar o desactivar.
  for i in 1..90 loop
    insert into public.spaces (workspace_id, kind, code, x, y)
    values (v_ws, 'carpa', 'C' || lpad(i::text, 2, '0'),
            150 + ((i - 1) % 15) * 110,
            330 + ((i - 1) / 15) * 120);
  end loop;
  for i in 1..10 loop
    insert into public.spaces (workspace_id, kind, code, x, y)
    values (v_ws, 'sombrilla', 'S' || lpad(i::text, 2, '0'), 150 + (i - 1) * 110, 1060);
  end loop;

  insert into public.expense_categories (workspace_id, name) values
    (v_ws, 'Proveedores e insumos'), (v_ws, 'Mantenimiento'), (v_ws, 'Reparaciones'),
    (v_ws, 'Limpieza'), (v_ws, 'Materiales y herramientas'), (v_ws, 'Otros gastos');

  insert into public.agreements (workspace_id, name, percent) values (v_ws, 'Parque Bonito', 30);

  insert into public.user_preferences (user_id) values (v_user) on conflict (user_id) do nothing;

  return v_ws;
end $$;

revoke all on function public.create_workspace(text) from public, anon;
grant execute on function public.create_workspace(text) to authenticated;

-- >>> 0008_parador_eolico.sql
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

-- >>> 0009_tarifas_y_precios.sql
-- =====================================================================
-- 0009 · Tarifario por quincena, paquetes, convenios con vigencia,
--        medios de pago ampliados y cálculo de precio en la base.
-- =====================================================================
-- ---------------------------------------------------------------------
-- Medios de pago: se agregan débito, crédito y Mercado Pago.
-- ("tarjeta" queda aceptado para registros anteriores.)
-- ---------------------------------------------------------------------
create or replace function private.valid_method(p text) returns boolean
language sql immutable as $$
  select p in ('efectivo','transferencia','debito','credito','mercado_pago','tarjeta')
$$;
grant execute on function private.valid_method(text) to authenticated;

alter table public.payments       drop constraint payments_method_check;
alter table public.expenses       drop constraint expenses_method_check;
alter table public.cash_movements drop constraint cash_movements_method_check;
alter table public.payments       add constraint payments_method_check       check (private.valid_method(method));
alter table public.expenses       add constraint expenses_method_check       check (private.valid_method(method));
alter table public.cash_movements add constraint cash_movements_method_check check (private.valid_method(method));

-- ---------------------------------------------------------------------
-- Datos nuevos de balneario, clientes, convenios y reservas
-- ---------------------------------------------------------------------
alter table public.workspaces
  add column cash_discount_percent numeric(5,2) not null default 10 check (cash_discount_percent >= 0 and cash_discount_percent <= 100),
  add column sea_bearing integer not null default 90 check (sea_bearing between 0 and 359),
  add column legal_id text check (char_length(legal_id) <= 30),
  add column phone text check (char_length(phone) <= 40),
  add column address text check (char_length(address) <= 200);
grant update (cash_discount_percent, sea_bearing, legal_id, phone, address) on public.workspaces to authenticated;

alter table public.customers add column locality text check (char_length(locality) <= 80);
grant insert (locality) on public.customers to authenticated;
grant update (locality) on public.customers to authenticated;

alter table public.agreements
  add column valid_from date,
  add column valid_to date,
  add column conditions text check (char_length(conditions) <= 500),
  add constraint agreements_validity check (valid_to is null or valid_from is null or valid_to >= valid_from);
grant insert (valid_from, valid_to, conditions) on public.agreements to authenticated;
grant update (valid_from, valid_to, conditions) on public.agreements to authenticated;

alter table public.reservations
  add column courtesy_beneficiary text check (char_length(courtesy_beneficiary) <= 120),
  add column pricing_options jsonb;

alter table public.reservation_discounts drop constraint reservation_discounts_kind_check;
alter table public.reservation_discounts add constraint reservation_discounts_kind_check
  check (kind in ('paquete','efectivo','convenio','manual','cortesia'));

-- ---------------------------------------------------------------------
-- Tarifario: precio por día, por quincena y por tipo de espacio.
-- La temporada se deriva de la fecha (julio a junio): ene 2027 → 2026/2027.
-- ---------------------------------------------------------------------
create table public.rates (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  space_kind   text not null check (space_kind in ('carpa','sombrilla')),
  year         integer not null check (year between 2000 and 2100),
  month        integer not null check (month between 1 and 12),
  half         smallint not null check (half in (1, 2)),
  season       text generated always as (
                 case when month >= 7 then year::text || '/' || (year + 1)::text
                      else (year - 1)::text || '/' || year::text end) stored,
  daily_price  numeric(14,2) not null check (daily_price >= 0),
  version      integer not null default 1,
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid(),
  unique (workspace_id, space_kind, year, month, half)
);
create index rates_season_idx on public.rates(workspace_id, season);

create trigger rates_version before update on public.rates
  for each row execute function private.check_version();
create trigger rates_audit after insert or update on public.rates
  for each row execute function private.audit();
create trigger rates_no_delete before delete on public.rates
  for each row execute function private.forbid_change();

-- Descuentos por cantidad de días (editables). Se aplica el escalón más alto alcanzado.
create table public.package_discounts (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  min_days     integer not null check (min_days between 2 and 366),
  percent      numeric(5,2) not null check (percent > 0 and percent <= 100),
  active       boolean not null default true,
  version      integer not null default 1,
  created_at   timestamptz not null default now()
);
create unique index package_discounts_days_unique on public.package_discounts(workspace_id, min_days) where active;

create trigger package_discounts_version before update on public.package_discounts
  for each row execute function private.check_version();
create trigger package_discounts_audit after insert or update on public.package_discounts
  for each row execute function private.audit();
create trigger package_discounts_no_delete before delete on public.package_discounts
  for each row execute function private.forbid_change();

alter table public.rates enable row level security;
alter table public.package_discounts enable row level security;
create policy "miembros leen tarifas" on public.rates for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen paquetes" on public.package_discounts for select to authenticated using (private.is_member(workspace_id));
create policy "admins crean paquetes" on public.package_discounts for insert to authenticated
  with check (private.has_role(workspace_id, array['propietario','administrador']));
create policy "admins editan paquetes" on public.package_discounts for update to authenticated
  using (private.has_role(workspace_id, array['propietario','administrador']))
  with check (private.has_role(workspace_id, array['propietario','administrador']));
revoke all on public.rates, public.package_discounts from anon, authenticated;
grant select on public.rates, public.package_discounts to authenticated;
grant insert (workspace_id, min_days, percent, active) on public.package_discounts to authenticated;
grant update (percent, active, version) on public.package_discounts to authenticated;

-- Escalones iniciales para balnearios existentes (editables desde el Tarifario).
insert into public.package_discounts (workspace_id, min_days, percent)
select w.id, v.d, v.p from public.workspaces w
cross join (values (5, 5), (7, 8), (15, 12), (30, 20)) v(d, p)
where not exists (select 1 from public.package_discounts x where x.workspace_id = w.id);

-- Guardar un precio (con control de edición simultánea).
create or replace function public.set_rate(
  p_workspace_id uuid, p_space_kind text, p_year integer, p_month integer, p_half smallint,
  p_daily_price numeric, p_expected_version integer default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.rates%rowtype;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  if p_daily_price is null or p_daily_price < 0 then
    raise exception 'El precio no puede ser negativo.';
  end if;
  select * into v from public.rates
  where workspace_id = p_workspace_id and space_kind = p_space_kind and year = p_year and month = p_month and half = p_half
  for update;
  if found then
    if p_expected_version is distinct from v.version then
      raise exception 'Este precio fue modificado desde otro dispositivo. Recargá e intentá de nuevo.'
        using errcode = '40001', hint = 'CONFLICTO_VERSION';
    end if;
    update public.rates set daily_price = round(p_daily_price, 2), version = v.version + 1, updated_at = now(), updated_by = auth.uid()
    where id = v.id returning * into v;
  else
    insert into public.rates (workspace_id, space_kind, year, month, half, daily_price)
    values (p_workspace_id, p_space_kind, p_year, p_month, p_half, round(p_daily_price, 2)) returning * into v;
  end if;
  return to_jsonb(v);
end $$;

-- Copiar precios de un período/mes a otro, con ajuste porcentual opcional (ej. inflación).
-- p_src_half / p_dst_half en null = las dos quincenas.
create or replace function public.copy_rates(
  p_workspace_id uuid, p_src_year integer, p_src_month integer, p_src_half smallint,
  p_dst_year integer, p_dst_month integer, p_dst_half smallint,
  p_adjust_percent numeric default 0, p_overwrite boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_dst_half smallint;
  v_copied integer := 0;
  v_skipped integer := 0;
  v_existing public.rates%rowtype;
  v_price numeric(14,2);
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  if (p_src_half is null) <> (p_dst_half is null) then
    raise exception 'Elegí una quincena de origen y una de destino, o el mes completo en ambos.';
  end if;
  for r in select * from public.rates
           where workspace_id = p_workspace_id and year = p_src_year and month = p_src_month
             and (p_src_half is null or half = p_src_half) loop
    v_dst_half := coalesce(p_dst_half, r.half);
    v_price := round(r.daily_price * (1 + coalesce(p_adjust_percent, 0) / 100));
    select * into v_existing from public.rates
    where workspace_id = p_workspace_id and space_kind = r.space_kind and year = p_dst_year and month = p_dst_month and half = v_dst_half
    for update;
    if found then
      if not p_overwrite then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      update public.rates set daily_price = v_price, version = v_existing.version + 1, updated_at = now(), updated_by = auth.uid()
      where id = v_existing.id;
    else
      insert into public.rates (workspace_id, space_kind, year, month, half, daily_price)
      values (p_workspace_id, r.space_kind, p_dst_year, p_dst_month, v_dst_half, v_price);
    end if;
    v_copied := v_copied + 1;
  end loop;
  return jsonb_build_object('copiados', v_copied, 'omitidos', v_skipped);
end $$;

-- Copiar toda una temporada (ej. 2026/2027 → 2027/2028) con ajuste porcentual.
create or replace function public.copy_season(
  p_workspace_id uuid, p_src_season text, p_dst_season text,
  p_adjust_percent numeric default 0, p_overwrite boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_offset integer;
  r record;
  v_copied integer := 0;
  v_skipped integer := 0;
  v_res jsonb;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  if p_src_season !~ '^\d{4}/\d{4}$' or p_dst_season !~ '^\d{4}/\d{4}$' then
    raise exception 'Temporada inválida (formato 2026/2027).';
  end if;
  v_offset := split_part(p_dst_season, '/', 1)::integer - split_part(p_src_season, '/', 1)::integer;
  if v_offset = 0 then
    raise exception 'Elegí una temporada de destino distinta.';
  end if;
  for r in select distinct year, month from public.rates where workspace_id = p_workspace_id and season = p_src_season loop
    v_res := public.copy_rates(p_workspace_id, r.year, r.month, null, r.year + v_offset, r.month, null, p_adjust_percent, p_overwrite);
    v_copied := v_copied + (v_res ->> 'copiados')::integer;
    v_skipped := v_skipped + (v_res ->> 'omitidos')::integer;
  end loop;
  return jsonb_build_object('copiados', v_copied, 'omitidos', v_skipped);
end $$;

-- ---------------------------------------------------------------------
-- Cálculo del precio (lo hace siempre la base: nadie puede alterarlo desde la pantalla)
--   1. Precio base: cada día al precio de su quincena y tipo de espacio.
--   2. Descuento por paquete: el escalón más alto que alcance la estadía.
--   3. Convenio: % sobre lo que queda.
--   4. Pago en efectivo: % (10 por defecto) sobre lo que queda.
--   5. Descuento manual: monto o % sobre lo que queda (solo administradores, con motivo).
--   Cada descuento se redondea hacia abajo al peso entero.
-- p_options: {"agreement_id", "cash": bool, "manual": {"type":"monto|porcentaje","value","reason"},
--             "courtesy": bool, "courtesy_beneficiary", "manual_base": numeric}
-- ---------------------------------------------------------------------
create or replace function private.compute_quote(
  p_workspace_id uuid, p_start date, p_end date, p_segments jsonb, p_options jsonb
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_opts jsonb := coalesce(p_options, '{}'::jsonb);
  v_seg jsonb;
  v_space public.spaces%rowtype;
  v_d date;
  v_period_end date;
  v_half smallint;
  v_price numeric(14,2);
  v_rate public.rates%rowtype;
  v_days integer;
  v_charges jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_discounts jsonb := '[]'::jsonb;
  v_base numeric(14,2) := 0;
  v_cur numeric(14,2);
  v_amt numeric(14,2);
  v_pct numeric(5,2);
  v_total_days integer := p_end - p_start + 1;
  v_agreement public.agreements%rowtype;
  v_ws public.workspaces%rowtype;
  v_manual jsonb := v_opts -> 'manual';
  v_courtesy boolean := coalesce((v_opts ->> 'courtesy')::boolean, false);
  v_month_names text[] := array['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
begin
  select * into v_ws from public.workspaces where id = p_workspace_id;
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'Revisá las fechas: la salida no puede ser anterior a la entrada.';
  end if;

  if v_opts ? 'manual_base' and (v_opts ->> 'manual_base') is not null then
    -- Precio manual acordado (solo administradores)
    if not private.has_role(p_workspace_id, array['propietario','administrador']) then
      raise exception 'Solo un administrador puede fijar un precio manual.' using errcode = '42501';
    end if;
    v_base := floor((v_opts ->> 'manual_base')::numeric);
    if v_base < 0 then
      raise exception 'El precio manual no puede ser negativo.';
    end if;
    v_charges := jsonb_build_array(jsonb_build_object(
      'description', 'Precio manual acordado', 'start_date', p_start, 'end_date', p_end,
      'days', v_total_days, 'amount', v_base, 'is_manual', true));
  else
    for v_seg in select * from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) order by (value ->> 'start_date') loop
      select * into v_space from public.spaces where id = (v_seg ->> 'space_id')::uuid and workspace_id = p_workspace_id;
      if not found then
        raise exception 'Uno de los espacios elegidos no existe.';
      end if;
      v_d := (v_seg ->> 'start_date')::date;
      while v_d <= (v_seg ->> 'end_date')::date loop
        v_half := case when extract(day from v_d) <= 15 then 1 else 2 end;
        v_period_end := least((v_seg ->> 'end_date')::date,
          case when v_half = 1 then make_date(extract(year from v_d)::int, extract(month from v_d)::int, 15)
               else (date_trunc('month', v_d) + interval '1 month - 1 day')::date end);
        v_days := v_period_end - v_d + 1;
        select * into v_rate from public.rates
        where workspace_id = p_workspace_id and space_kind = v_space.kind
          and year = extract(year from v_d)::int and month = extract(month from v_d)::int and half = v_half;
        if not found then
          v_missing := v_missing || jsonb_build_object('space_kind', v_space.kind, 'year', extract(year from v_d)::int,
                         'month', extract(month from v_d)::int, 'half', v_half);
        else
          v_charges := v_charges || jsonb_build_object(
            'description', format('%s · %s al %s · %s %s × %s', private.space_label(v_space.kind, v_space.code),
                                  to_char(v_d, 'DD/MM'), to_char(v_period_end, 'DD/MM'), v_days,
                                  case when v_days = 1 then 'día' else 'días' end,
                                  '$' || to_char(v_rate.daily_price, 'FM999G999G990')),
            'space_id', v_space.id, 'space_kind', v_space.kind, 'start_date', v_d, 'end_date', v_period_end,
            'days', v_days, 'unit_price', v_rate.daily_price, 'amount', v_rate.daily_price * v_days, 'is_manual', false,
            'rate_snapshot', jsonb_build_object('rate_id', v_rate.id, 'season', v_rate.season, 'year', v_rate.year,
                             'month', v_rate.month, 'half', v_rate.half, 'daily_price', v_rate.daily_price,
                             'periodo', (case v_half when 1 then '1ª' else '2ª' end) || ' quincena de '
                                        || v_month_names[v_rate.month] || ' ' || v_rate.year));
          v_base := v_base + v_rate.daily_price * v_days;
        end if;
        v_d := v_period_end + 1;
      end loop;
    end loop;
  end if;

  v_cur := v_base;
  if not v_courtesy then
    -- 2. Paquete por cantidad de días
    select percent into v_pct from public.package_discounts
    where workspace_id = p_workspace_id and active and min_days <= v_total_days
    order by min_days desc limit 1;
    if found and v_cur > 0 then
      v_amt := floor(v_cur * v_pct / 100);
      v_discounts := v_discounts || jsonb_build_object('kind', 'paquete', 'percent', v_pct, 'amount', v_amt,
                       'label', format('Paquete %s días (%s%%)', v_total_days, to_char(v_pct, 'FM990D##')));
      v_cur := v_cur - v_amt;
    end if;

    -- 3. Convenio
    if (v_opts ->> 'agreement_id') is not null then
      select * into v_agreement from public.agreements
      where id = (v_opts ->> 'agreement_id')::uuid and workspace_id = p_workspace_id;
      if not found or not v_agreement.active
         or (v_agreement.valid_from is not null and p_start < v_agreement.valid_from)
         or (v_agreement.valid_to is not null and p_start > v_agreement.valid_to) then
        raise exception 'El convenio elegido no está vigente para esas fechas.';
      end if;
      v_amt := floor(v_cur * v_agreement.percent / 100);
      v_discounts := v_discounts || jsonb_build_object('kind', 'convenio', 'agreement_id', v_agreement.id,
                       'percent', v_agreement.percent, 'amount', v_amt);
      v_cur := v_cur - v_amt;
    end if;

    -- 4. Pago en efectivo
    if coalesce((v_opts ->> 'cash')::boolean, false) and v_ws.cash_discount_percent > 0 then
      v_amt := floor(v_cur * v_ws.cash_discount_percent / 100);
      v_discounts := v_discounts || jsonb_build_object('kind', 'efectivo', 'percent', v_ws.cash_discount_percent, 'amount', v_amt);
      v_cur := v_cur - v_amt;
    end if;

    -- 5. Descuento manual
    if v_manual is not null and coalesce((v_manual ->> 'value')::numeric, 0) > 0 then
      if char_length(btrim(coalesce(v_manual ->> 'reason', ''))) < 3 then
        raise exception 'Los descuentos manuales necesitan un motivo.';
      end if;
      if v_manual ->> 'type' = 'porcentaje' then
        v_pct := (v_manual ->> 'value')::numeric;
        if v_pct > 100 then
          raise exception 'El porcentaje no puede superar 100.';
        end if;
        v_amt := floor(v_cur * v_pct / 100);
      else
        v_pct := null;
        v_amt := least(floor((v_manual ->> 'value')::numeric), v_cur);
      end if;
      v_discounts := v_discounts || jsonb_build_object('kind', 'manual', 'percent', v_pct, 'amount', v_amt,
                       'reason', btrim(v_manual ->> 'reason'));
      v_cur := v_cur - v_amt;
    end if;
  end if;

  return jsonb_build_object(
    'ok', jsonb_array_length(v_missing) = 0,
    'faltan_tarifas', v_missing,
    'charges', v_charges,
    'dias', v_total_days,
    'precio_base', v_base,
    'discounts', v_discounts,
    'cortesia', v_courtesy,
    'total', case when v_courtesy then 0 else v_cur end
  );
end $$;

-- Presupuesto para mostrar en pantalla antes de confirmar.
create or replace function public.quote_reservation(
  p_workspace_id uuid, p_start date, p_end date, p_segments jsonb, p_options jsonb default '{}'::jsonb
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id);
  return private.compute_quote(p_workspace_id, p_start, p_end, p_segments, p_options);
end $$;

-- ---------------------------------------------------------------------
-- Funciones de dinero actualizadas para los nuevos medios de pago
-- ---------------------------------------------------------------------
create or replace function private.record_payment(
  p_workspace_id uuid, p_reservation_id uuid, p_kind text, p_amount numeric, p_method text,
  p_idempotency_key uuid, p_note text, p_reason text, p_voids_payment_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.payments%rowtype;
  v_res public.reservations%rowtype;
  v_orig public.payments%rowtype;
  v_session uuid;
  v_paid numeric(14,2);
  v_signed numeric(14,2);
  v_amount numeric(14,2) := round(p_amount, 2);
  v_id uuid;
  v_category text;
  v_concept text;
begin
  if p_idempotency_key is null then
    raise exception 'Falta la clave de operación.';
  end if;

  select * into v_existing from public.payments
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.reservation_id <> p_reservation_id or v_existing.kind <> p_kind
       or (p_kind <> 'anulacion' and (v_existing.amount <> v_amount or v_existing.method <> p_method)) then
      raise exception 'Esta operación ya fue registrada con otros datos.';
    end if;
    return v_existing.id;
  end if;

  v_session := private.today_session(p_workspace_id);

  -- Bloquea la reserva: dos pagos simultáneos se procesan de a uno.
  select * into v_res from public.reservations
  where id = p_reservation_id and workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'La reserva no existe.';
  end if;

  -- Reintento simultáneo con la misma clave: el otro ya terminó.
  select * into v_existing from public.payments
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return v_existing.id;
  end if;

  select coalesce(sum(signed_amount), 0) into v_paid from public.payments where reservation_id = p_reservation_id;

  if p_kind = 'cobro' then
    if v_res.status = 'cancelada' then
      raise exception 'No se pueden registrar cobros en una reserva cancelada.';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'El importe debe ser mayor a cero.';
    end if;
    if v_amount > v_res.total_amount - v_paid then
      raise exception 'El cobro (%) supera el saldo pendiente (%).',
        to_char(v_amount, 'FM999G999G990D00'), to_char(greatest(v_res.total_amount - v_paid, 0), 'FM999G999G990D00');
    end if;
    v_signed := v_amount;
    v_category := 'cobro';
    v_concept := format('Cobro reserva #%s', v_res.number);

  elsif p_kind = 'devolucion' then
    if v_amount is null or v_amount <= 0 then
      raise exception 'El importe debe ser mayor a cero.';
    end if;
    if v_amount > v_paid then
      raise exception 'La devolución supera lo cobrado en la reserva.';
    end if;
    v_signed := -v_amount;
    v_category := 'devolucion';
    v_concept := format('Devolución reserva #%s', v_res.number);

  elsif p_kind = 'anulacion' then
    select * into v_orig from public.payments
    where id = p_voids_payment_id and reservation_id = p_reservation_id;
    if not found then
      raise exception 'El pago a anular no existe en esta reserva.';
    end if;
    if v_orig.kind = 'anulacion' then
      raise exception 'Una anulación no se puede anular.';
    end if;
    if exists (select 1 from public.payments where voids_payment_id = v_orig.id) then
      raise exception 'Ese pago ya fue anulado.';
    end if;
    v_amount := v_orig.amount;
    p_method := v_orig.method;
    v_signed := -v_orig.signed_amount;
    v_category := case v_orig.kind when 'cobro' then 'anulacion_cobro' else 'anulacion_devolucion' end;
    v_concept := format('Anulación de %s · reserva #%s', v_orig.kind, v_res.number);
  else
    raise exception 'Tipo de pago inválido.';
  end if;

  if p_method is null or not private.valid_method(p_method) then
    raise exception 'Medio de pago inválido.';
  end if;

  insert into public.payments (workspace_id, reservation_id, kind, amount, signed_amount, method,
                               voids_payment_id, cash_session_id, idempotency_key, note, reason)
  values (p_workspace_id, p_reservation_id, p_kind, v_amount, v_signed, p_method,
          p_voids_payment_id, v_session, p_idempotency_key, nullif(btrim(p_note), ''), nullif(btrim(p_reason), ''))
  returning id into v_id;

  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, payment_id)
  values (p_workspace_id, v_session, case when v_signed > 0 then 'entrada' else 'salida' end,
          p_method, v_amount, v_category, v_concept, v_id);

  return v_id;
end $$;

create or replace function public.register_expense(
  p_workspace_id uuid, p_idempotency_key uuid, p_amount numeric, p_spent_on date, p_concept text,
  p_category_id uuid, p_method text, p_supplier text default null, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.expenses%rowtype;
  v_session uuid;
  v_id uuid;
begin
  perform private.require_member(p_workspace_id);

  select * into v_existing from public.expenses
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('expense_id', v_existing.id, 'repetida', true);
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El importe debe ser mayor a cero.';
  end if;
  if p_spent_on is null or p_spent_on > private.ws_today(p_workspace_id) then
    raise exception 'Solo se registran gastos ya pagados (la fecha no puede ser futura).';
  end if;
  if p_method is null or not private.valid_method(p_method) then
    raise exception 'Medio de pago inválido.';
  end if;
  if not exists (select 1 from public.expense_categories c
                 where c.id = p_category_id and c.workspace_id = p_workspace_id and c.active) then
    raise exception 'Elegí una categoría válida.';
  end if;

  v_session := private.today_session(p_workspace_id);

  insert into public.expenses (workspace_id, cash_session_id, amount, spent_on, concept, category_id,
                               supplier, method, notes, idempotency_key)
  values (p_workspace_id, v_session, round(p_amount, 2), p_spent_on, btrim(p_concept), p_category_id,
          nullif(btrim(p_supplier), ''), p_method, nullif(btrim(p_notes), ''), p_idempotency_key)
  returning id into v_id;

  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, expense_id)
  values (p_workspace_id, v_session, 'salida', p_method, round(p_amount, 2), 'gasto', left('Gasto: ' || btrim(p_concept), 200), v_id);

  return jsonb_build_object('expense_id', v_id, 'repetida', false);
end $$;

create or replace function public.register_other_income(
  p_workspace_id uuid, p_idempotency_key uuid, p_amount numeric, p_method text, p_concept text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing uuid;
  v_session uuid;
  v_id uuid;
begin
  perform private.require_member(p_workspace_id);
  select id into v_existing from public.cash_movements
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('movement_id', v_existing, 'repetida', true);
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'El importe debe ser mayor a cero.';
  end if;
  if char_length(btrim(coalesce(p_concept, ''))) < 3 then
    raise exception 'Indicá el concepto del ingreso.';
  end if;
  if p_method is null or not private.valid_method(p_method) then
    raise exception 'Medio de pago inválido.';
  end if;
  v_session := private.today_session(p_workspace_id);
  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, idempotency_key)
  values (p_workspace_id, v_session, 'entrada', p_method, round(p_amount, 2), 'otro_ingreso', btrim(p_concept), p_idempotency_key)
  returning id into v_id;
  return jsonb_build_object('movement_id', v_id, 'repetida', false);
end $$;

create or replace function public.cash_session_summary(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_s public.cash_sessions%rowtype;
  v_methods jsonb;
  v_cash_in numeric(14,2);
  v_cash_out numeric(14,2);
begin
  select * into v_s from public.cash_sessions where id = p_session_id;
  if not found then
    raise exception 'La caja no existe.';
  end if;
  perform private.require_member(v_s.workspace_id);

  select coalesce(sum(amount) filter (where direction = 'entrada' and method = 'efectivo'), 0),
         coalesce(sum(amount) filter (where direction = 'salida' and method = 'efectivo'), 0)
    into v_cash_in, v_cash_out
  from public.cash_movements where cash_session_id = p_session_id;

  select coalesce(jsonb_object_agg(m.method, jsonb_build_object(
           'entradas', coalesce(x.entradas, 0), 'salidas', coalesce(x.salidas, 0))), '{}'::jsonb)
    into v_methods
  from (values ('efectivo'), ('transferencia'), ('debito'), ('credito'), ('mercado_pago'), ('tarjeta')) m(method)
  left join (
    select method,
           sum(amount) filter (where direction = 'entrada') as entradas,
           sum(amount) filter (where direction = 'salida') as salidas
    from public.cash_movements where cash_session_id = p_session_id group by method
  ) x on x.method = m.method;

  return jsonb_build_object(
    'session_id', v_s.id,
    'business_date', v_s.business_date,
    'opening_cash', v_s.opening_cash,
    'opened_at', v_s.opened_at,
    'opened_by', v_s.opened_by,
    'por_medio', v_methods,
    'efectivo_esperado', v_s.opening_cash + v_cash_in - v_cash_out,
    'closed_at', v_s.closed_at,
    'counted_cash', v_s.counted_cash,
    'difference', v_s.difference,
    'close_notes', v_s.close_notes,
    'version', v_s.version
  );
end $$;

-- Panel: nuevos indicadores (ocupación, ingresos del mes, saldo pendiente, efectivo en caja)
create or replace function public.dashboard_summary(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date;
  v_counts jsonb;
  v_starting jsonb;
  v_ending jsonb;
  v_debtors integer;
  v_session public.cash_sessions%rowtype;
  v_old_open public.cash_sessions%rowtype;
  v_income jsonb;
  v_expenses numeric(14,2);
begin
  perform private.require_member(p_workspace_id);
  v_today := private.ws_today(p_workspace_id);

  select jsonb_object_agg(kind, x) into v_counts from (
    select kind, jsonb_build_object(
      'total_activos', count(*) filter (where state <> 'desactivada'),
      'ocupados', count(*) filter (where state in ('ocupada','cortesia')),
      'cortesias', count(*) filter (where state = 'cortesia'),
      'disponibles', count(*) filter (where state in ('disponible','reservada_futura')),
      'mantenimiento', count(*) filter (where state = 'mantenimiento'),
      'desactivados', count(*) filter (where state = 'desactivada')
    ) as x
    from public.map_day_status(p_workspace_id, v_today) group by kind
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object(
           'reservation_id', r.id, 'number', r.number,
           'customer', btrim(c.first_name || ' ' || c.last_name), 'phone', c.phone,
           'start_date', r.start_date, 'end_date', r.end_date,
           'spaces', (select string_agg(sp.code, ', ' order by s.start_date) from public.reservation_segments s
                      join public.spaces sp on sp.id = s.space_id where s.reservation_id = r.id and s.active),
           'due_amount', b.due_amount, 'is_courtesy', r.is_courtesy) order by r.number), '[]'::jsonb)
    into v_starting
  from public.reservations r
  join public.customers c on c.id = r.customer_id
  join public.reservation_balances b on b.reservation_id = r.id
  where r.workspace_id = p_workspace_id and r.status = 'confirmada' and r.start_date = v_today;

  select coalesce(jsonb_agg(jsonb_build_object(
           'reservation_id', r.id, 'number', r.number,
           'customer', btrim(c.first_name || ' ' || c.last_name), 'phone', c.phone,
           'start_date', r.start_date, 'end_date', r.end_date,
           'spaces', (select string_agg(sp.code, ', ' order by s.start_date) from public.reservation_segments s
                      join public.spaces sp on sp.id = s.space_id where s.reservation_id = r.id and s.active),
           'due_amount', b.due_amount, 'is_courtesy', r.is_courtesy) order by b.due_amount desc, r.number), '[]'::jsonb)
    into v_ending
  from public.reservations r
  join public.customers c on c.id = r.customer_id
  join public.reservation_balances b on b.reservation_id = r.id
  where r.workspace_id = p_workspace_id and r.status = 'confirmada' and r.end_date = v_today;

  select count(distinct r.customer_id) into v_debtors
  from public.reservations r join public.reservation_balances b on b.reservation_id = r.id
  where r.workspace_id = p_workspace_id and b.due_amount > 0;

  select * into v_session from public.cash_sessions
  where workspace_id = p_workspace_id and business_date = v_today;
  select * into v_old_open from public.cash_sessions
  where workspace_id = p_workspace_id and closed_at is null and business_date < v_today;

  -- Cobrado hoy = cobros de reservas y otros ingresos (sin contar anulaciones ni la apertura)
  select jsonb_build_object(
           'efectivo', coalesce(sum(amount) filter (where method = 'efectivo'), 0),
           'otros_medios', coalesce(sum(amount) filter (where method <> 'efectivo'), 0),
           'total', coalesce(sum(amount), 0))
    into v_income
  from public.cash_movements
  where cash_session_id = v_session.id and direction = 'entrada' and category in ('cobro','otro_ingreso');

  select coalesce(sum(e.amount), 0) into v_expenses
  from public.expenses e where e.workspace_id = p_workspace_id and e.spent_on = v_today and e.voided_at is null;

  return jsonb_build_object(
    'fecha', v_today,
    'espacios', coalesce(v_counts, '{}'::jsonb),
    'ingresan_hoy', v_starting,
    'finalizan_hoy', v_ending,
    'clientes_con_deuda', v_debtors,
    'ingresos_hoy', coalesce(v_income, jsonb_build_object('efectivo', 0, 'otros_medios', 0, 'total', 0)),
    'gastos_hoy', v_expenses,
    'ingresos_mes', (select coalesce(sum(m.amount), 0) from public.cash_movements m
                     join public.cash_sessions cs on cs.id = m.cash_session_id
                     where cs.workspace_id = p_workspace_id and m.direction = 'entrada' and m.category in ('cobro','otro_ingreso')
                       and date_trunc('month', cs.business_date) = date_trunc('month', v_today)),
    'saldo_pendiente_total', (select coalesce(sum(b.due_amount), 0) from public.reservation_balances b
                              where b.workspace_id = p_workspace_id),
    'efectivo_en_caja', case when v_session.id is not null and v_session.closed_at is null
                             then (public.cash_session_summary(v_session.id) ->> 'efectivo_esperado')::numeric end,
    'caja', case
              when v_session.id is null then jsonb_build_object('estado', 'sin_abrir')
              when v_session.closed_at is null then jsonb_build_object('estado', 'abierta', 'session_id', v_session.id)
              else jsonb_build_object('estado', 'cerrada', 'session_id', v_session.id)
            end,
    'caja_anterior_sin_cerrar', case when v_old_open.id is not null
              then jsonb_build_object('session_id', v_old_open.id, 'fecha', v_old_open.business_date) end
  );
end $$;

-- ---------------------------------------------------------------------
-- Alta de reservas
--   public.create_reservation_v2 → la que usa la pantalla: calcula el precio en la base.
--   public.create_reservation    → carga con importes manuales, solo administradores.
-- ---------------------------------------------------------------------
alter function public.create_reservation(uuid, uuid, uuid, date, date, jsonb, jsonb, jsonb, boolean, text, jsonb) set schema private;
create or replace function private.create_reservation(
  p_workspace_id uuid,
  p_request_id uuid,
  p_customer_id uuid,
  p_start_date date,
  p_end_date date,
  p_segments jsonb,
  p_charges jsonb,
  p_discounts jsonb default '[]'::jsonb,
  p_is_courtesy boolean default false,
  p_notes text default null,
  p_payment jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.reservations%rowtype;
  v_res_id uuid := gen_random_uuid();
  v_change_id uuid := gen_random_uuid();
  v_number bigint;
  v_list numeric(14,2) := 0;
  v_discount numeric(14,2) := 0;
  v_total numeric(14,2);
  v_seg jsonb;
  v_item jsonb;
  v_pos integer := 0;
  v_conflict text;
  v_space_ids uuid[];
  v_agreement public.agreements%rowtype;
  v_payment_id uuid;
  v_kind text;
  v_amount numeric(14,2);
  v_label text;
  v_percent numeric(5,2);
begin
  perform private.require_member(p_workspace_id);

  -- Reintento (doble clic, recarga, red lenta): devuelve la misma reserva.
  select * into v_existing from public.reservations
  where workspace_id = p_workspace_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('reservation_id', v_existing.id, 'number', v_existing.number, 'repetida', true);
  end if;

  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'Revisá las fechas: la salida no puede ser anterior a la entrada.';
  end if;
  if not exists (select 1 from public.customers c where c.id = p_customer_id and c.workspace_id = p_workspace_id) then
    raise exception 'Elegí un cliente válido.';
  end if;
  if p_segments is null or jsonb_typeof(p_segments) <> 'array' or jsonb_array_length(p_segments) = 0 then
    raise exception 'Asigná al menos una carpa o sombrilla.';
  end if;
  if p_charges is null or jsonb_typeof(p_charges) <> 'array' then
    raise exception 'Falta el detalle de precio.';
  end if;
  p_discounts := coalesce(p_discounts, '[]'::jsonb);

  -- Cada tramo dentro de la estadía y sin días repetidos entre tramos.
  if exists (select 1 from jsonb_array_elements(p_segments) s
             where (s ->> 'start_date') is null or (s ->> 'end_date') is null or (s ->> 'space_id') is null
                or (s ->> 'end_date')::date < (s ->> 'start_date')::date
                or (s ->> 'start_date')::date < p_start_date or (s ->> 'end_date')::date > p_end_date) then
    raise exception 'Cada tramo de carpa tiene que estar dentro de las fechas de la estadía.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_segments) with ordinality a(s, i)
             join jsonb_array_elements(p_segments) with ordinality b(s, j) on a.i < b.j
             where daterange((a.s ->> 'start_date')::date, (a.s ->> 'end_date')::date, '[]')
                && daterange((b.s ->> 'start_date')::date, (b.s ->> 'end_date')::date, '[]')) then
    raise exception 'Los tramos de carpa se superponen: un cliente no puede tener dos carpas el mismo día.';
  end if;

  -- Bloquea todos los espacios involucrados (en orden, para evitar bloqueos cruzados)
  select array_agg((s ->> 'space_id')::uuid) into v_space_ids from jsonb_array_elements(p_segments) s;
  perform private.lock_spaces(v_space_ids);

  -- Revalida la disponibilidad al guardar, con el detalle de cada conflicto.
  for v_seg in select * from jsonb_array_elements(p_segments) loop
    if not exists (select 1 from public.spaces sp where sp.id = (v_seg ->> 'space_id')::uuid
                   and sp.workspace_id = p_workspace_id) then
      raise exception 'Uno de los espacios elegidos no existe.';
    end if;
    v_conflict := private.space_conflict((v_seg ->> 'space_id')::uuid,
                                         (v_seg ->> 'start_date')::date, (v_seg ->> 'end_date')::date);
    if v_conflict is not null then
      raise exception 'Ya no está disponible: %', v_conflict using errcode = '23P01', hint = 'CONFLICTO_DISPONIBILIDAD';
    end if;
  end loop;

  -- Precio de lista
  for v_item in select * from jsonb_array_elements(p_charges) loop
    v_amount := round((v_item ->> 'amount')::numeric, 2);
    if v_amount is null or v_amount < 0 then
      raise exception 'Hay un importe inválido en el detalle de precio.';
    end if;
    v_list := v_list + v_amount;
  end loop;

  -- Descuentos (cada uno queda registrado con su importe, motivo y responsable)
  for v_item in select * from jsonb_array_elements(p_discounts) loop
    v_kind := v_item ->> 'kind';
    v_amount := round((v_item ->> 'amount')::numeric, 2);
    if v_amount is null or v_amount < 0 then
      raise exception 'Hay un descuento con importe inválido.';
    end if;
    if v_kind = 'cortesia' then
      raise exception 'La cortesía se indica marcando la reserva como cortesía, no como descuento.';
    elsif v_kind = 'convenio' then
      select * into v_agreement from public.agreements
      where id = (v_item ->> 'agreement_id')::uuid and workspace_id = p_workspace_id;
      if not found or not v_agreement.active then
        raise exception 'El convenio elegido no está vigente.';
      end if;
    elsif v_kind = 'manual' then
      if not private.has_role(p_workspace_id, array['propietario','administrador']) then
        raise exception 'Solo un administrador puede aplicar descuentos manuales.' using errcode = '42501';
      end if;
      if char_length(btrim(coalesce(v_item ->> 'reason', ''))) < 3 then
        raise exception 'Los descuentos manuales necesitan un motivo.';
      end if;
    elsif v_kind not in ('efectivo','paquete') then
      raise exception 'Tipo de descuento inválido.';
    end if;
    v_discount := v_discount + v_amount;
  end loop;

  if p_is_courtesy then
    if jsonb_array_length(p_discounts) > 0 then
      raise exception 'Una cortesía no lleva otros descuentos.';
    end if;
    if p_payment is not null then
      raise exception 'Una cortesía no genera cobros.';
    end if;
    v_discount := v_list;
  end if;

  if v_discount > v_list then
    raise exception 'Los descuentos superan el precio.';
  end if;
  v_total := v_list - v_discount;

  insert into public.reservations (id, workspace_id, customer_id, start_date, end_date, is_courtesy,
                                   list_amount, discount_amount, total_amount, notes, request_id, created_by)
  values (v_res_id, p_workspace_id, p_customer_id, p_start_date, p_end_date, coalesce(p_is_courtesy, false),
          v_list, v_discount, v_total, nullif(btrim(p_notes), ''), p_request_id, auth.uid())
  returning number into v_number;

  insert into public.reservation_changes (id, workspace_id, reservation_id, kind, description)
  values (v_change_id, p_workspace_id, v_res_id, 'creacion', format('Reserva #%s creada', v_number));

  for v_seg in select * from jsonb_array_elements(p_segments) loop
    insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
    values (p_workspace_id, v_res_id, (v_seg ->> 'space_id')::uuid,
            (v_seg ->> 'start_date')::date, (v_seg ->> 'end_date')::date, v_change_id);
  end loop;
  perform private.assert_coverage(v_res_id);

  v_pos := 0;
  for v_item in select * from jsonb_array_elements(p_charges) loop
    v_pos := v_pos + 1;
    insert into public.reservation_charges (workspace_id, reservation_id, position, description, space_kind,
                                            start_date, end_date, days, unit_price, amount, is_manual, rate_snapshot)
    values (p_workspace_id, v_res_id, v_pos,
            coalesce(nullif(btrim(v_item ->> 'description'), ''), 'Alquiler'),
            v_item ->> 'space_kind',
            (v_item ->> 'start_date')::date, (v_item ->> 'end_date')::date,
            (v_item ->> 'days')::integer,
            round((v_item ->> 'unit_price')::numeric, 2),
            round((v_item ->> 'amount')::numeric, 2),
            coalesce((v_item ->> 'is_manual')::boolean, false),
            v_item -> 'rate_snapshot');
  end loop;

  v_pos := 0;
  if p_is_courtesy then
    insert into public.reservation_discounts (workspace_id, reservation_id, position, kind, label, percent, amount, reason)
    values (p_workspace_id, v_res_id, 1, 'cortesia', 'Cortesía familiar', 100, v_list, 'Cortesía familiar');
  else
    for v_item in select * from jsonb_array_elements(p_discounts) loop
      v_pos := v_pos + 1;
      v_kind := v_item ->> 'kind';
      v_percent := (v_item ->> 'percent')::numeric;
      v_label := case v_kind when 'efectivo' then 'Pago en efectivo' when 'manual' then 'Descuento manual'
                     when 'paquete' then coalesce(nullif(v_item ->> 'label', ''), 'Descuento por paquete') else null end;
      if v_kind = 'convenio' then
        select * into v_agreement from public.agreements where id = (v_item ->> 'agreement_id')::uuid;
        v_label := 'Convenio ' || v_agreement.name;
        v_percent := v_agreement.percent;
      end if;
      insert into public.reservation_discounts (workspace_id, reservation_id, position, kind, agreement_id,
                                                label, percent, amount, reason)
      values (p_workspace_id, v_res_id, v_pos, v_kind,
              case when v_kind = 'convenio' then v_agreement.id end,
              v_label, v_percent, round((v_item ->> 'amount')::numeric, 2),
              nullif(btrim(v_item ->> 'reason'), ''));
    end loop;
  end if;

  if p_payment is not null then
    if coalesce((p_payment ->> 'amount')::numeric, 0) <= 0 then
      raise exception 'Ingresá el importe cobrado (o elegí "Cobrar después").';
    end if;
    v_payment_id := private.record_payment(p_workspace_id, v_res_id, 'cobro', (p_payment ->> 'amount')::numeric,
                                           p_payment ->> 'method', (p_payment ->> 'idempotency_key')::uuid,
                                           'Pago al reservar', null);
  end if;

  update public.reservation_changes set after_state = jsonb_build_object(
    'segments', private.segments_snapshot(v_res_id), 'total_amount', v_total)
  where id = v_change_id;

  return jsonb_build_object('reservation_id', v_res_id, 'number', v_number, 'total_amount', v_total,
                            'payment_id', v_payment_id, 'repetida', false);
end $$;

revoke all on function private.create_reservation(uuid, uuid, uuid, date, date, jsonb, jsonb, jsonb, boolean, text, jsonb) from public, anon, authenticated;

create or replace function public.create_reservation(
  p_workspace_id uuid, p_request_id uuid, p_customer_id uuid, p_start_date date, p_end_date date,
  p_segments jsonb, p_charges jsonb, p_discounts jsonb default '[]'::jsonb, p_is_courtesy boolean default false,
  p_notes text default null, p_payment jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  return private.create_reservation(p_workspace_id, p_request_id, p_customer_id, p_start_date, p_end_date,
                                    p_segments, p_charges, p_discounts, p_is_courtesy, p_notes, p_payment);
end $$;

create or replace function public.create_reservation_v2(
  p_workspace_id uuid, p_request_id uuid, p_customer_id uuid, p_start_date date, p_end_date date,
  p_segments jsonb, p_options jsonb default '{}'::jsonb, p_notes text default null, p_payment jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.reservations%rowtype;
  v_quote jsonb;
  v_res jsonb;
  v_courtesy boolean := coalesce((p_options ->> 'courtesy')::boolean, false);
begin
  perform private.require_member(p_workspace_id);

  select * into v_existing from public.reservations where workspace_id = p_workspace_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('reservation_id', v_existing.id, 'number', v_existing.number, 'repetida', true);
  end if;

  v_quote := private.compute_quote(p_workspace_id, p_start_date, p_end_date, p_segments, p_options);
  if not (v_quote ->> 'ok')::boolean then
    raise exception 'Faltan tarifas cargadas para algunas fechas. Cargalas en el Tarifario o usá un precio manual.'
      using hint = 'FALTAN_TARIFAS';
  end if;
  if v_courtesy and char_length(btrim(coalesce(p_options ->> 'courtesy_beneficiary', ''))) < 2 then
    raise exception 'Indicá el familiar beneficiario de la cortesía.';
  end if;

  v_res := private.create_reservation(
    p_workspace_id, p_request_id, p_customer_id, p_start_date, p_end_date, p_segments,
    v_quote -> 'charges',
    case when v_courtesy then '[]'::jsonb else v_quote -> 'discounts' end,
    v_courtesy, p_notes, p_payment);

  update public.reservations
     set courtesy_beneficiary = case when v_courtesy then btrim(p_options ->> 'courtesy_beneficiary') end,
         pricing_options = p_options - 'courtesy_beneficiary',
         version = version + 1
   where id = (v_res ->> 'reservation_id')::uuid;

  return v_res || jsonb_build_object('quote', v_quote);
end $$;

revoke all on function public.create_reservation(uuid, uuid, uuid, date, date, jsonb, jsonb, jsonb, boolean, text, jsonb),
  public.create_reservation_v2(uuid, uuid, uuid, date, date, jsonb, jsonb, text, jsonb),
  public.quote_reservation(uuid, date, date, jsonb, jsonb),
  public.set_rate(uuid, text, integer, integer, smallint, numeric, integer),
  public.copy_rates(uuid, integer, integer, smallint, integer, integer, smallint, numeric, boolean),
  public.copy_season(uuid, text, text, numeric, boolean)
  from public, anon;
grant execute on function public.create_reservation(uuid, uuid, uuid, date, date, jsonb, jsonb, jsonb, boolean, text, jsonb),
  public.create_reservation_v2(uuid, uuid, uuid, date, date, jsonb, jsonb, text, jsonb),
  public.quote_reservation(uuid, date, date, jsonb, jsonb),
  public.set_rate(uuid, text, integer, integer, smallint, numeric, integer),
  public.copy_rates(uuid, integer, integer, smallint, integer, integer, smallint, numeric, boolean),
  public.copy_season(uuid, text, text, numeric, boolean)
  to authenticated;
revoke all on function private.compute_quote(uuid, date, date, jsonb, jsonb) from public, anon, authenticated;

-- Alta de balneario: incluye los escalones de paquete iniciales
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
  insert into public.package_discounts (workspace_id, min_days, percent)
  values (v_ws, 5, 5), (v_ws, 7, 8), (v_ws, 15, 12), (v_ws, 30, 20);
  insert into public.user_preferences (user_id) values (v_user) on conflict (user_id) do nothing;
  return v_ws;
end $$;

-- >>> 0010_config_informes_copias.sql
-- =====================================================================
-- 0010 · Identidad del balneario (logo, subtítulo), perfil del usuario,
--        copias de seguridad (manuales y automáticas) e informes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Logo y subtítulo del balneario. La imagen se guarda en la base
-- (achicada en el navegador, máx. ~300 KB), no en la computadora.
-- ---------------------------------------------------------------------
alter table public.workspaces
  add column logo_data text check (logo_data is null or (logo_data like 'data:image/%' and char_length(logo_data) <= 400000)),
  add column subtitle text check (char_length(subtitle) <= 80);
grant update (logo_data, subtitle) on public.workspaces to authenticated;

-- Foto y nombre visible de cada usuario (se sincroniza entre dispositivos).
alter table public.user_preferences
  add column avatar_data text check (avatar_data is null or (avatar_data like 'data:image/%' and char_length(avatar_data) <= 200000)),
  add column display_name text check (char_length(display_name) <= 80);

-- ---------------------------------------------------------------------
-- Copias de seguridad
-- Guardan una foto completa de los datos del balneario (clientes, reservas,
-- tramos, pagos, caja, gastos, tarifas, configuración e historial).
-- ---------------------------------------------------------------------
create table public.backups (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  kind         text not null check (kind in ('manual','automatica')),
  note         text check (char_length(note) <= 200),
  counts       jsonb not null,
  size_bytes   integer not null,
  data         jsonb not null,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  created_by_email text
);
create index backups_ws_idx on public.backups(workspace_id, created_at desc);

alter table public.backups enable row level security;
create policy "miembros ven copias" on public.backups for select to authenticated using (private.is_member(workspace_id));
revoke all on public.backups from anon, authenticated;
grant select on public.backups to authenticated;

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
    'maintenance_blocks','cash_sessions','payments','expenses','cash_movements','workspace_members','audit_log'
  ] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I x where x.workspace_id = $1', t)
      into v_rows using p_ws;
    v := v || jsonb_build_object(t, v_rows);
  end loop;
  select v || jsonb_build_object('workspace', to_jsonb(w) - 'logo_data') into v from public.workspaces w where w.id = p_ws;
  return v;
end $$;

-- Crea una copia. La automática se hace como máximo una vez cada 20 horas
-- (la pide la aplicación al abrirse) y se conservan las últimas 30.
create or replace function public.create_backup(p_workspace_id uuid, p_kind text default 'manual', p_note text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_data jsonb;
  v_counts jsonb;
  v_id uuid;
  v_size integer;
begin
  if p_kind = 'manual' then
    perform private.require_member(p_workspace_id, array['propietario','administrador']);
  elsif p_kind = 'automatica' then
    perform private.require_member(p_workspace_id);
    perform pg_advisory_xact_lock(hashtextextended('copia:' || p_workspace_id::text, 0));
    if exists (select 1 from public.backups where workspace_id = p_workspace_id and kind = 'automatica'
               and created_at > now() - interval '20 hours') then
      return jsonb_build_object('creada', false);
    end if;
  else
    raise exception 'Tipo de copia inválido.';
  end if;

  v_data := private.snapshot(p_workspace_id);
  select jsonb_object_agg(key, jsonb_array_length(value)) into v_counts
  from jsonb_each(v_data) where jsonb_typeof(value) = 'array';
  v_size := octet_length(v_data::text);

  insert into public.backups (workspace_id, kind, note, counts, size_bytes, data, created_by_email)
  values (p_workspace_id, p_kind, nullif(btrim(p_note), ''), v_counts, v_size, v_data,
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  returning id into v_id;

  delete from public.backups where id in (
    select id from public.backups where workspace_id = p_workspace_id and kind = 'automatica'
    order by created_at desc offset 30);

  return jsonb_build_object('creada', true, 'backup_id', v_id, 'counts', v_counts, 'size_bytes', v_size);
end $$;

revoke all on function public.create_backup(uuid, text, text) from public, anon;
grant execute on function public.create_backup(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Informes de un período (máx. 400 días). Todo sale de los registros reales.
-- Diferencia siempre lo CONTRATADO (precio de las reservas) de lo COBRADO (caja).
-- ---------------------------------------------------------------------
create or replace function public.report_summary(p_workspace_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_res jsonb := '{}'::jsonb;
begin
  perform private.require_member(p_workspace_id);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Elegí un período válido (hasta 400 días).';
  end if;

  -- Ocupación por día (espacios ocupados sobre espacios activos de cada tipo)
  v_res := v_res || jsonb_build_object('ocupacion', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'dia', d.day,
             'carpas', coalesce(o.carpas, 0), 'sombrillas', coalesce(o.sombrillas, 0),
             'cortesias', coalesce(o.cortesias, 0)) order by d.day), '[]'::jsonb)
    from (select gs::date as day from generate_series(p_from, p_to, interval '1 day') gs) d
    left join lateral (
      select count(*) filter (where sp.kind = 'carpa') as carpas,
             count(*) filter (where sp.kind = 'sombrilla') as sombrillas,
             count(*) filter (where r.is_courtesy) as cortesias
      from public.reservation_segments s
      join public.spaces sp on sp.id = s.space_id
      join public.reservations r on r.id = s.reservation_id
      where s.workspace_id = p_workspace_id and s.active and d.day between s.start_date and s.end_date
    ) o on true));
  v_res := v_res || jsonb_build_object('activos', (
    select jsonb_build_object('carpas', count(*) filter (where kind = 'carpa' and active),
                              'sombrillas', count(*) filter (where kind = 'sombrilla' and active))
    from public.spaces where workspace_id = p_workspace_id));

  -- Contratado: reservas confirmadas que comienzan en el período
  v_res := v_res || jsonb_build_object('contratado', (
    select jsonb_build_object(
      'reservas', count(*),
      'precio_lista', coalesce(sum(list_amount), 0),
      'descuentos', coalesce(sum(discount_amount), 0),
      'total', coalesce(sum(total_amount), 0),
      'cortesias', count(*) filter (where is_courtesy),
      'cortesias_dias', coalesce(sum(end_date - start_date + 1) filter (where is_courtesy), 0),
      'cortesias_valor', coalesce(sum(list_amount) filter (where is_courtesy), 0),
      'canceladas', (select count(*) from public.reservations c where c.workspace_id = p_workspace_id
                     and c.status = 'cancelada' and c.start_date between p_from and p_to))
    from public.reservations
    where workspace_id = p_workspace_id and status = 'confirmada' and start_date between p_from and p_to));

  -- Cobrado (caja): por tipo y medio de pago
  v_res := v_res || jsonb_build_object('caja_movimientos', (
    select coalesce(jsonb_agg(jsonb_build_object('categoria', category, 'medio', method, 'sentido', direction,
                                                 'importe', total, 'cantidad', n)), '[]'::jsonb)
    from (
      select m.category, m.method, m.direction, sum(m.amount) as total, count(*) as n
      from public.cash_movements m join public.cash_sessions s on s.id = m.cash_session_id
      where s.workspace_id = p_workspace_id and s.business_date between p_from and p_to
      group by m.category, m.method, m.direction
    ) x));

  -- Cobrado por día (entradas por cobros y otros ingresos, menos devoluciones y anulaciones de cobros)
  v_res := v_res || jsonb_build_object('cobrado_por_dia', (
    select coalesce(jsonb_agg(jsonb_build_object('dia', business_date, 'cobrado', cobrado, 'gastos', gastos) order by business_date), '[]'::jsonb)
    from (
      select s.business_date,
             coalesce(sum(case when m.category in ('cobro','otro_ingreso','anulacion_devolucion') then m.amount
                               when m.category in ('devolucion','anulacion_cobro') then -m.amount end), 0) as cobrado,
             coalesce(sum(case when m.category = 'gasto' then m.amount when m.category = 'anulacion_gasto' then -m.amount end), 0) as gastos
      from public.cash_sessions s left join public.cash_movements m on m.cash_session_id = s.id
      where s.workspace_id = p_workspace_id and s.business_date between p_from and p_to
      group by s.business_date
    ) x));

  -- Gastos por categoría (no anulados)
  v_res := v_res || jsonb_build_object('gastos', (
    select coalesce(jsonb_agg(jsonb_build_object('categoria', c.name, 'importe', t.total, 'cantidad', t.n,
                                                 'efectivo', t.efectivo) order by t.total desc), '[]'::jsonb)
    from (select e.category_id, sum(e.amount) as total, count(*) as n,
                 sum(e.amount) filter (where e.method = 'efectivo') as efectivo
          from public.expenses e
          where e.workspace_id = p_workspace_id and e.voided_at is null and e.spent_on between p_from and p_to
          group by e.category_id) t
    join public.expense_categories c on c.id = t.category_id));

  -- Cierres de caja y diferencias
  v_res := v_res || jsonb_build_object('cierres', (
    select coalesce(jsonb_agg(jsonb_build_object('fecha', business_date, 'apertura', opening_cash, 'esperado', expected_cash,
                                                 'contado', counted_cash, 'diferencia', difference, 'notas', close_notes)
                              order by business_date), '[]'::jsonb)
    from public.cash_sessions
    where workspace_id = p_workspace_id and business_date between p_from and p_to and closed_at is not null));

  -- Descuentos aplicados (reservas confirmadas que comienzan en el período)
  v_res := v_res || jsonb_build_object('descuentos', (
    select coalesce(jsonb_agg(jsonb_build_object('tipo', kind, 'detalle', label, 'importe', total, 'cantidad', n)
                              order by total desc), '[]'::jsonb)
    from (select d.kind, d.label, sum(d.amount) as total, count(*) as n
          from public.reservation_discounts d join public.reservations r on r.id = d.reservation_id
          where r.workspace_id = p_workspace_id and r.status = 'confirmada' and r.start_date between p_from and p_to
          group by d.kind, d.label) x));

  -- Deudas pendientes hoy (no dependen del período)
  v_res := v_res || jsonb_build_object('deudas', (
    select coalesce(jsonb_agg(jsonb_build_object('reserva', r.number, 'reservation_id', r.id,
             'cliente', btrim(c.first_name || ' ' || c.last_name), 'telefono', c.phone,
             'desde', r.start_date, 'hasta', r.end_date, 'total', r.total_amount, 'saldo', b.due_amount)
             order by r.end_date), '[]'::jsonb)
    from public.reservation_balances b
    join public.reservations r on r.id = b.reservation_id
    join public.customers c on c.id = r.customer_id
    where b.workspace_id = p_workspace_id and b.due_amount > 0));

  -- Clientes frecuentes (2 o más reservas confirmadas en total)
  v_res := v_res || jsonb_build_object('frecuentes', (
    select coalesce(jsonb_agg(x order by (x ->> 'reservas')::int desc, (x ->> 'pagado')::numeric desc), '[]'::jsonb)
    from (
      select jsonb_build_object('cliente', btrim(c.first_name || ' ' || c.last_name), 'customer_id', c.id, 'telefono', c.phone,
               'reservas', count(r.id), 'dias', sum(r.end_date - r.start_date + 1),
               'pagado', coalesce(sum(b.paid_amount), 0), 'ultima', max(r.start_date)) as x
      from public.customers c
      join public.reservations r on r.customer_id = c.id and r.status = 'confirmada'
      join public.reservation_balances b on b.reservation_id = r.id
      where c.workspace_id = p_workspace_id
      group by c.id
      having count(r.id) >= 2
      order by count(r.id) desc
      limit 30
    ) t));

  return v_res;
end $$;

revoke all on function public.report_summary(uuid, date, date) from public, anon;
grant execute on function public.report_summary(uuid, date, date) to authenticated;

-- >>> 0011_usuarios.sql
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

-- >>> 0012_juegos_partidos.sql
-- =====================================================================
-- 0012 · Juegos infantiles partidos en dos, uno a cada costado del camino.
-- =====================================================================

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
    ('area_comun','Juegos infantiles',482,1278,158,252,'#e9c98f'),
    ('area_comun','Juegos infantiles',695,1278,158,252,'#e9c98f'),
    ('area_comun','Juegos infantiles',1530,1278,144,252,'#e9c98f'),
    ('area_comun','Juegos infantiles',1737,1278,162,252,'#e9c98f')
  ) v(kind, label, x, y, width, height, color)
$$;

-- Balnearios existentes: se reemplazan los juegos (los anteriores quedan desactivados, no se borran).
do $$
declare w record;
begin
  for w in select id from public.workspaces loop
    if exists (select 1 from public.map_features where workspace_id = w.id and active and label = 'Juegos infantiles') then
      update public.map_features set active = false, version = version + 1
      where workspace_id = w.id and active and label = 'Juegos infantiles';
      insert into public.map_features (workspace_id, kind, label, x, y, width, height, color)
      select w.id, f.kind, f.label, f.x, f.y, f.width, f.height, f.color
      from private.parador_features() f where f.label = 'Juegos infantiles';
    end if;
  end loop;
end $$;

-- >>> 0013_windguru.sql
-- =====================================================================
-- 0013 · Pronóstico de Windguru (widget oficial) para el balneario.
-- Se guardan solo los parámetros del widget (spot, modelo, unidades…).
-- =====================================================================
alter table public.workspaces
  add column windguru_params text check (
    windguru_params is null or (char_length(windguru_params) <= 1000 and windguru_params ~ '^[A-Za-z0-9=&,._%-]+$' and windguru_params ~ '(^|&)s=[0-9]+')
  );
grant update (windguru_params) on public.workspaces to authenticated;

-- >>> 0014_capas_mapa.sql
-- =====================================================================
-- 0014 · Capas del plano: qué elemento se dibuja encima de cuál.
--   layer más alto = más arriba. Las carpas y sombrillas siempre van encima de todo.
-- =====================================================================
alter table public.map_features add column layer integer;

-- Capa inicial razonable según el tipo: sectores al fondo, luego el edificio,
-- caminos, áreas comunes y, arriba, las instalaciones (bar, oficina, baños…).
create or replace function private.default_layer(p_kind text, p_label text) returns integer
language sql immutable as $$
  select case
    when p_kind = 'sector' then 0
    when p_label = 'Parador' then 10
    when p_kind in ('camino','pasillo') then 20
    when p_kind = 'area_comun' then 30
    else 40
  end
$$;

create or replace function private.map_features_layer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.layer is null then
    -- Lo nuevo queda arriba de todo lo de su mismo tipo.
    select greatest(private.default_layer(new.kind, new.label), coalesce(max(m.layer) + 1, 0))
      into new.layer
    from public.map_features m
    where m.workspace_id = new.workspace_id and m.active
      and private.default_layer(m.kind, m.label) = private.default_layer(new.kind, new.label);
  end if;
  return new;
end $$;

create trigger map_features_layer before insert on public.map_features
  for each row execute function private.map_features_layer();

-- Elementos existentes: ordenar por tipo (arregla el bar, la oficina y los baños tapados por el edificio).
update public.map_features set layer = private.default_layer(kind, label), version = version + 1;

alter table public.map_features alter column layer set not null;
grant insert (layer) on public.map_features to authenticated;
grant update (layer) on public.map_features to authenticated;

-- =====================================================================
-- 0015 · Diseño de las carpas y sombrillas en el plano.
--   tent_style = null → el diseño clásico (a rayas del color del estado).
--   Se puede ejecutar aunque ya se haya aplicado la versión anterior (tent_color).
-- =====================================================================
create or replace function private.valid_tent_style(s jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  k text;
  hex constant text := '^#[0-9a-fA-F]{6}$';
begin
  if s is null then return true; end if;
  if jsonb_typeof(s) <> 'object' then return false; end if;
  for k in select jsonb_object_keys(s) loop
    if k not in ('pattern','fill','accent','border','borderWidth','numberBg','numberText','stateDot') then return false; end if;
  end loop;
  return coalesce(
        (s->>'pattern') in ('liso','rayas','rayas_finas','cuadros','lunares','franja')
    and ((s->>'fill') ~ hex or s->>'fill' = 'estado')
    and ((s->>'accent') ~ hex or s->>'accent' = 'estado')
    and ((s->>'border') ~ hex or s->>'border' in ('estado','ninguno'))
    and (s->'borderWidth') in ('1'::jsonb, '2'::jsonb, '3'::jsonb)
    and ((s->>'numberBg') ~ hex or s->>'numberBg' in ('estado','ninguno'))
    and ((s->>'numberText') ~ hex or s->>'numberText' = 'estado')
    and jsonb_typeof(s->'stateDot') = 'boolean', false);
end $$;

alter table public.workspaces add column if not exists tent_style jsonb;
alter table public.workspaces drop constraint if exists workspaces_tent_style_check;
alter table public.workspaces add constraint workspaces_tent_style_check check (private.valid_tent_style(tent_style));
grant update (tent_style) on public.workspaces to authenticated;

-- Versión anterior de esta actualización (solo un color): ya no se usa.
alter table public.workspaces drop column if exists tent_color;

-- =====================================================================
-- 0016 · Devoluciones con voucher del restaurante y cobros en dólares.
--   · Devolución: en efectivo (sale de la caja) o con un voucher para el
--     restaurante (no toca la caja). Cada voucher tiene un código.
--   · Cobro en dólares: se guarda el monto en dólares y la cotización;
--     la reserva se descuenta en pesos. En la caja los dólares se cuentan aparte.
-- =====================================================================

-- Medios válidos para pagos de reservas: los de siempre + dólares + voucher.
create or replace function private.valid_payment_method(p text) returns boolean
language sql immutable as $$
  select private.valid_method(p) or p in ('dolares', 'voucher')
$$;
grant execute on function private.valid_payment_method(text) to authenticated;

alter table public.payments drop constraint payments_method_check;
alter table public.payments add constraint payments_method_check check (private.valid_payment_method(method));
alter table public.payments add column usd_amount numeric(14,2) check (usd_amount is null or usd_amount > 0);
alter table public.payments add column exchange_rate numeric(14,4) check (exchange_rate is null or exchange_rate > 0);
alter table public.payments add constraint payments_usd_check
  check ((method = 'dolares') = (usd_amount is not null and exchange_rate is not null));
alter table public.payments add constraint payments_voucher_check check (method <> 'voucher' or kind <> 'cobro');

alter table public.cash_movements drop constraint cash_movements_method_check;
alter table public.cash_movements add constraint cash_movements_method_check
  check (private.valid_method(method) or method = 'dolares');
alter table public.cash_movements add column usd_amount numeric(14,2);
alter table public.cash_movements add constraint cash_movements_usd_check
  check ((method = 'dolares') = (usd_amount is not null));

-- ---------------------------------------------------------------------
-- Vouchers para el restaurante (crédito a favor del cliente)
-- ---------------------------------------------------------------------
create table public.restaurant_vouchers (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id),
  code           text not null,
  payment_id     uuid not null unique,
  reservation_id uuid not null,
  customer_id    uuid not null,
  amount         numeric(14,2) not null check (amount > 0),
  status         text not null default 'vigente' check (status in ('vigente', 'usado', 'anulado')),
  used_at        timestamptz,
  used_by        uuid,
  version        integer not null default 1,
  created_at     timestamptz not null default now(),
  unique (workspace_id, code),
  foreign key (workspace_id, payment_id) references public.payments(workspace_id, id),
  foreign key (workspace_id, reservation_id) references public.reservations(workspace_id, id),
  foreign key (workspace_id, customer_id) references public.customers(workspace_id, id),
  check ((status = 'usado') = (used_at is not null))
);
create index restaurant_vouchers_customer_idx on public.restaurant_vouchers(customer_id);
alter table public.restaurant_vouchers enable row level security;
create policy "miembros leen vouchers" on public.restaurant_vouchers for select to authenticated using (private.is_member(workspace_id));
grant select on public.restaurant_vouchers to authenticated;
create trigger restaurant_vouchers_version before update on public.restaurant_vouchers
  for each row execute function private.check_version();
create trigger restaurant_vouchers_no_delete before delete on public.restaurant_vouchers
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------
-- Registro de pagos (reemplaza la versión anterior)
-- ---------------------------------------------------------------------
drop function private.record_payment(uuid, uuid, text, numeric, text, uuid, text, text, uuid);

create or replace function private.record_payment(
  p_workspace_id uuid, p_reservation_id uuid, p_kind text, p_amount numeric, p_method text,
  p_idempotency_key uuid, p_note text, p_reason text, p_voids_payment_id uuid default null,
  p_usd numeric default null, p_rate numeric default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.payments%rowtype;
  v_res public.reservations%rowtype;
  v_orig public.payments%rowtype;
  v_session uuid;
  v_paid numeric(14,2);
  v_signed numeric(14,2);
  v_amount numeric(14,2) := round(p_amount, 2);
  v_id uuid;
  v_category text;
  v_concept text;
  v_usd numeric(14,2);
  v_rate numeric(14,4);
  v_code text;
begin
  -- Dólares: monto en dólares y cotización. Desde Nueva reserva llegan por la sesión (ver create_reservation_v2).
  if p_method = 'dolares' then
    v_usd := round(coalesce(p_usd, nullif(current_setting('app.pay_usd', true), '')::numeric), 2);
    v_rate := round(coalesce(p_rate, nullif(current_setting('app.pay_rate', true), '')::numeric), 4);
    if v_usd is null or v_usd <= 0 or v_rate is null or v_rate <= 0 then
      raise exception 'Para cobrar en dólares indicá el monto en dólares y la cotización.';
    end if;
    v_amount := round(v_usd * v_rate, 2);
  end if;

  if p_idempotency_key is null then
    raise exception 'Falta la clave de operación.';
  end if;

  select * into v_existing from public.payments
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.reservation_id <> p_reservation_id or v_existing.kind <> p_kind
       or (p_kind <> 'anulacion' and (v_existing.amount <> v_amount or v_existing.method <> p_method)) then
      raise exception 'Esta operación ya fue registrada con otros datos.';
    end if;
    return v_existing.id;
  end if;

  v_session := private.today_session(p_workspace_id);

  -- Bloquea la reserva: dos pagos simultáneos se procesan de a uno.
  select * into v_res from public.reservations
  where id = p_reservation_id and workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'La reserva no existe.';
  end if;

  -- Reintento simultáneo con la misma clave: el otro ya terminó.
  select * into v_existing from public.payments
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return v_existing.id;
  end if;

  select coalesce(sum(signed_amount), 0) into v_paid from public.payments where reservation_id = p_reservation_id;

  if p_kind = 'cobro' then
    if v_res.status = 'cancelada' then
      raise exception 'No se pueden registrar cobros en una reserva cancelada.';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'El importe debe ser mayor a cero.';
    end if;
    if v_amount > v_res.total_amount - v_paid then
      raise exception 'El cobro (%) supera el saldo pendiente (%).',
        to_char(v_amount, 'FM999G999G990D00'), to_char(greatest(v_res.total_amount - v_paid, 0), 'FM999G999G990D00');
    end if;
    if p_method = 'voucher' then
      raise exception 'El voucher del restaurante solo se usa para devoluciones.';
    end if;
    if p_method = 'dolares' and v_amount > v_res.total_amount - v_paid and v_amount - (v_res.total_amount - v_paid) < greatest(1, v_rate * 0.01) then
      v_amount := v_res.total_amount - v_paid;  -- "todo el saldo": diferencia menor a un centavo de dólar
    end if;
    v_signed := v_amount;
    v_category := 'cobro';
    v_concept := format('Cobro reserva #%s', v_res.number);

  elsif p_kind = 'devolucion' then
    if p_method not in ('efectivo', 'voucher') then
      raise exception 'Las devoluciones se hacen en efectivo o con un voucher para el restaurante.';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'El importe debe ser mayor a cero.';
    end if;
    if v_amount > v_paid then
      raise exception 'La devolución supera lo cobrado en la reserva.';
    end if;
    v_signed := -v_amount;
    v_category := 'devolucion';
    v_concept := format('Devolución reserva #%s', v_res.number);

  elsif p_kind = 'anulacion' then
    select * into v_orig from public.payments
    where id = p_voids_payment_id and reservation_id = p_reservation_id;
    if not found then
      raise exception 'El pago a anular no existe en esta reserva.';
    end if;
    if v_orig.kind = 'anulacion' then
      raise exception 'Una anulación no se puede anular.';
    end if;
    if exists (select 1 from public.payments where voids_payment_id = v_orig.id) then
      raise exception 'Ese pago ya fue anulado.';
    end if;
    if v_orig.method = 'voucher' and exists (select 1 from public.restaurant_vouchers
                                              where payment_id = v_orig.id and status = 'usado') then
      raise exception 'Ese voucher ya se usó en el restaurante; no se puede anular.';
    end if;
    v_amount := v_orig.amount;
    p_method := v_orig.method;
    v_usd := v_orig.usd_amount;
    v_rate := v_orig.exchange_rate;
    v_signed := -v_orig.signed_amount;
    v_category := case v_orig.kind when 'cobro' then 'anulacion_cobro' else 'anulacion_devolucion' end;
    v_concept := format('Anulación de %s · reserva #%s', v_orig.kind, v_res.number);
  else
    raise exception 'Tipo de pago inválido.';
  end if;

  if p_method is null or not private.valid_payment_method(p_method) then
    raise exception 'Medio de pago inválido.';
  end if;

  insert into public.payments (workspace_id, reservation_id, kind, amount, signed_amount, method,
                               voids_payment_id, cash_session_id, idempotency_key, note, reason, usd_amount, exchange_rate)
  values (p_workspace_id, p_reservation_id, p_kind, v_amount, v_signed, p_method,
          p_voids_payment_id, v_session, p_idempotency_key, nullif(btrim(p_note), ''), nullif(btrim(p_reason), ''),
          case when p_method = 'dolares' then v_usd end, case when p_method = 'dolares' then v_rate end)
  returning id into v_id;

  if p_method = 'voucher' then
    -- El voucher no es dinero de la caja: no genera movimiento de caja.
    if p_kind = 'devolucion' then
      loop
        v_code := 'V-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
        exit when not exists (select 1 from public.restaurant_vouchers where workspace_id = p_workspace_id and code = v_code);
      end loop;
      insert into public.restaurant_vouchers (workspace_id, code, payment_id, reservation_id, customer_id, amount)
      values (p_workspace_id, v_code, v_id, p_reservation_id, v_res.customer_id, v_amount);
    else
      update public.restaurant_vouchers set status = 'anulado', version = version + 1 where payment_id = p_voids_payment_id;
    end if;
  else
    insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, payment_id, usd_amount)
    values (p_workspace_id, v_session, case when v_signed > 0 then 'entrada' else 'salida' end,
            p_method, v_amount, v_category,
            v_concept || case when p_method = 'dolares' then format(' · US$ %s a $ %s', v_usd, v_rate) else '' end,
            v_id, case when p_method = 'dolares' then v_usd end);
  end if;

  return v_id;
end $$;

revoke all on function private.record_payment(uuid, uuid, text, numeric, text, uuid, text, text, uuid, numeric, numeric) from public, anon, authenticated;

-- Cobro en dólares desde Cobros o desde la reserva.
create or replace function public.register_payment_usd(
  p_workspace_id uuid, p_reservation_id uuid, p_usd numeric, p_rate numeric,
  p_idempotency_key uuid, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_member(p_workspace_id);
  v_id := private.record_payment(p_workspace_id, p_reservation_id, 'cobro', null, 'dolares',
                                 p_idempotency_key, p_note, null, null, p_usd, p_rate);
  return jsonb_build_object('payment_id', v_id, 'amount', (select amount from public.payments where id = v_id));
end $$;

-- El restaurante usó el voucher.
create or replace function public.use_voucher(p_voucher_id uuid, p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.restaurant_vouchers%rowtype;
begin
  select * into v from public.restaurant_vouchers where id = p_voucher_id for update;
  if not found then
    raise exception 'El voucher no existe.';
  end if;
  perform private.require_member(v.workspace_id);
  if v.status <> 'vigente' then
    raise exception 'Ese voucher ya está %.', v.status;
  end if;
  if v.version <> p_expected_version then
    raise exception 'Otro usuario modificó este voucher. Recargá la página.' using errcode = '40001';
  end if;
  update public.restaurant_vouchers
     set status = 'usado', used_at = now(), used_by = auth.uid(), version = version + 1
   where id = p_voucher_id;
  return jsonb_build_object('voucher_id', v.id, 'code', v.code);
end $$;

revoke all on function public.register_payment_usd(uuid, uuid, numeric, numeric, uuid, text),
  public.use_voucher(uuid, integer) from public, anon;
grant execute on function public.register_payment_usd(uuid, uuid, numeric, numeric, uuid, text),
  public.use_voucher(uuid, integer) to authenticated;

-- Nueva reserva: acepta cobro en dólares ("usd_amount" y "exchange_rate" dentro de p_payment).
create or replace function public.create_reservation_v2(
  p_workspace_id uuid, p_request_id uuid, p_customer_id uuid, p_start_date date, p_end_date date,
  p_segments jsonb, p_options jsonb default '{}'::jsonb, p_notes text default null, p_payment jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.reservations%rowtype;
  v_quote jsonb;
  v_res jsonb;
  v_courtesy boolean := coalesce((p_options ->> 'courtesy')::boolean, false);
begin
  perform private.require_member(p_workspace_id);

  select * into v_existing from public.reservations where workspace_id = p_workspace_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('reservation_id', v_existing.id, 'number', v_existing.number, 'repetida', true);
  end if;

  v_quote := private.compute_quote(p_workspace_id, p_start_date, p_end_date, p_segments, p_options);
  if not (v_quote ->> 'ok')::boolean then
    raise exception 'Faltan tarifas cargadas para algunas fechas. Cargalas en el Tarifario o usá un precio manual.'
      using hint = 'FALTAN_TARIFAS';
  end if;
  if v_courtesy and char_length(btrim(coalesce(p_options ->> 'courtesy_beneficiary', ''))) < 2 then
    raise exception 'Indicá el familiar beneficiario de la cortesía.';
  end if;

  -- Pago en dólares al reservar: el monto en dólares y la cotización viajan por la sesión.
  perform set_config('app.pay_usd', coalesce(p_payment ->> 'usd_amount', ''), true);
  perform set_config('app.pay_rate', coalesce(p_payment ->> 'exchange_rate', ''), true);

  v_res := private.create_reservation(
    p_workspace_id, p_request_id, p_customer_id, p_start_date, p_end_date, p_segments,
    v_quote -> 'charges',
    case when v_courtesy then '[]'::jsonb else v_quote -> 'discounts' end,
    v_courtesy, p_notes, p_payment);

  perform set_config('app.pay_usd', '', true);
  perform set_config('app.pay_rate', '', true);

  update public.reservations
     set courtesy_beneficiary = case when v_courtesy then btrim(p_options ->> 'courtesy_beneficiary') end,
         pricing_options = p_options - 'courtesy_beneficiary',
         version = version + 1
   where id = (v_res ->> 'reservation_id')::uuid;

  return v_res || jsonb_build_object('quote', v_quote);
end $$;

-- Caja: los dólares se informan aparte (no se suman al efectivo en pesos).
create or replace function public.cash_session_summary(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_s public.cash_sessions%rowtype;
  v_methods jsonb;
  v_cash_in numeric(14,2);
  v_cash_out numeric(14,2);
  v_usd_in numeric(14,2);
  v_usd_out numeric(14,2);
begin
  select * into v_s from public.cash_sessions where id = p_session_id;
  if not found then
    raise exception 'La caja no existe.';
  end if;
  perform private.require_member(v_s.workspace_id);

  select coalesce(sum(amount) filter (where direction = 'entrada' and method = 'efectivo'), 0),
         coalesce(sum(amount) filter (where direction = 'salida' and method = 'efectivo'), 0)
    into v_cash_in, v_cash_out
  from public.cash_movements where cash_session_id = p_session_id;

  select coalesce(sum(usd_amount) filter (where direction = 'entrada' and method = 'dolares'), 0),
         coalesce(sum(usd_amount) filter (where direction = 'salida' and method = 'dolares'), 0)
    into v_usd_in, v_usd_out
  from public.cash_movements where cash_session_id = p_session_id;

  select coalesce(jsonb_object_agg(m.method, jsonb_build_object(
           'entradas', coalesce(x.entradas, 0), 'salidas', coalesce(x.salidas, 0))), '{}'::jsonb)
    into v_methods
  from (values ('efectivo'), ('transferencia'), ('debito'), ('credito'), ('mercado_pago'), ('tarjeta'), ('dolares')) m(method)
  left join (
    select method,
           sum(amount) filter (where direction = 'entrada') as entradas,
           sum(amount) filter (where direction = 'salida') as salidas
    from public.cash_movements where cash_session_id = p_session_id group by method
  ) x on x.method = m.method;

  return jsonb_build_object(
    'session_id', v_s.id,
    'business_date', v_s.business_date,
    'opening_cash', v_s.opening_cash,
    'opened_at', v_s.opened_at,
    'opened_by', v_s.opened_by,
    'por_medio', v_methods,
    'efectivo_esperado', v_s.opening_cash + v_cash_in - v_cash_out,
    'dolares', jsonb_build_object('entradas', v_usd_in, 'salidas', v_usd_out, 'esperado', v_usd_in - v_usd_out),
    'closed_at', v_s.closed_at,
    'counted_cash', v_s.counted_cash,
    'difference', v_s.difference,
    'close_notes', v_s.close_notes,
    'version', v_s.version
  );
end $$;

-- =====================================================================
-- 0017 · Avisos leídos: cada usuario oculta los avisos que ya abrió.
--   Se guarda solo la lista del día ({"day": "AAAA-MM-DD", "ids": [...]});
--   al día siguiente los avisos que sigan vigentes vuelven a aparecer.
--   Marcar un aviso como leído no cambia deudas, pagos ni reservas.
-- =====================================================================
alter table public.user_preferences
  add column notices_read jsonb not null default '{}'::jsonb
  check (jsonb_typeof(notices_read) = 'object' and pg_column_size(notices_read) < 20000);

-- =====================================================================
-- 0018 · Notas del día para el personal ("hoy viene el proveedor de hielo").
--   Cualquier usuario del balneario las crea, las tilda como hechas o las quita.
--   No se borran: "quitar" las oculta y queda en el historial.
-- =====================================================================
create table public.day_notes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  day          date not null,
  text         text not null check (char_length(btrim(text)) between 1 and 300),
  done         boolean not null default false,
  done_at      timestamptz,
  done_by      uuid,
  active       boolean not null default true,
  created_by   uuid not null default auth.uid(),
  created_at   timestamptz not null default now(),
  version      integer not null default 1
);
create index day_notes_ws_day_idx on public.day_notes(workspace_id, day);

create trigger day_notes_version before update on public.day_notes
  for each row execute function private.check_version();
create trigger day_notes_audit after insert or update on public.day_notes
  for each row execute function private.audit();
create trigger day_notes_no_delete before delete on public.day_notes
  for each row execute function private.forbid_change();

alter table public.day_notes enable row level security;
create policy "miembros leen notas" on public.day_notes for select to authenticated using (private.is_member(workspace_id));
create policy "miembros crean notas" on public.day_notes for insert to authenticated
  with check (private.is_member(workspace_id) and created_by = auth.uid());
create policy "miembros editan notas" on public.day_notes for update to authenticated
  using (private.is_member(workspace_id)) with check (private.is_member(workspace_id));

revoke all on public.day_notes from anon, authenticated;
grant select on public.day_notes to authenticated;
grant insert (workspace_id, day, text) on public.day_notes to authenticated;
grant update (text, day, done, done_at, done_by, active, version) on public.day_notes to authenticated;

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

-- =====================================================================
-- 0020 · Varios balnearios: cualquier persona puede registrarse y crear el suyo.
--   · Cada balneario ve solo sus datos (como siempre: todo está separado por balneario).
--   · Una cuenta pertenece a un solo balneario. Los invitados no pueden crear balnearios.
--   · El balneario nuevo arranca con un plano genérico (filas de carpas y sombrillas)
--     que después se edita en el Mapa.
-- =====================================================================

create or replace function public.create_workspace(p_name text, p_tents integer default 90, p_umbrellas integer default 10)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_user uuid := auth.uid();
  v_email text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email';
  v_cols constant integer := 15;
  v_rows integer;
  v_w integer;
  v_h integer;
  v_digits integer;
  i integer;
begin
  if v_user is null then
    raise exception 'Tenés que iniciar sesión.' using errcode = '28000';
  end if;
  if private.is_guest() then
    raise exception 'En el modo invitado no se puede crear un balneario. Registrate con Google o con un usuario.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'Ingresá el nombre del balneario.';
  end if;
  if p_tents is null or p_tents < 0 or p_tents > 600 or p_umbrellas is null or p_umbrellas < 0 or p_umbrellas > 300 or p_tents + p_umbrellas = 0 then
    raise exception 'Indicá cuántas carpas (hasta 600) y sombrillas (hasta 300) tenés.';
  end if;
  -- Una cuenta, un balneario (evita duplicados por doble clic o dos pestañas).
  perform pg_advisory_xact_lock(hashtextextended('alta-balneario:' || v_user::text, 0));
  if exists (select 1 from public.workspace_members where user_id = v_user) then
    raise exception 'Tu cuenta ya pertenece a un balneario.';
  end if;

  -- Plano genérico: filas de 15 carpas y, más cerca del mar, las sombrillas.
  v_rows := ceil(p_tents / v_cols::numeric)::integer + ceil(p_umbrellas / v_cols::numeric)::integer;
  v_w := 300 + v_cols * 180;
  v_h := greatest(1200, 700 + v_rows * 160);
  v_digits := greatest(2, length((p_tents + p_umbrellas)::text));

  insert into public.workspaces (name, created_by, map_width, map_height, sea_side)
  values (btrim(p_name), v_user, v_w, v_h, 'bottom')
  returning id into v_ws;
  insert into public.workspace_members (workspace_id, user_id, role, email) values (v_ws, v_user, 'propietario', v_email);

  for i in 1..p_tents loop
    insert into public.spaces (workspace_id, kind, code, x, y)
    values (v_ws, 'carpa', lpad(i::text, v_digits, '0'), 240 + ((i - 1) % v_cols) * 180, 420 + ((i - 1) / v_cols) * 160);
  end loop;
  for i in 1..p_umbrellas loop
    insert into public.spaces (workspace_id, kind, code, x, y)
    values (v_ws, 'sombrilla', lpad((p_tents + i)::text, v_digits, '0'), 240 + ((i - 1) % v_cols) * 180,
            420 + (ceil(p_tents / v_cols::numeric)::integer + (i - 1) / v_cols) * 160 + 40);
  end loop;

  insert into public.map_features (workspace_id, kind, label, x, y, width, height, color) values
    (v_ws, 'instalacion', 'Parador', v_w / 2 - 300, 60, 600, 180, '#a86a1f'),
    (v_ws, 'camino', null, 150, 300, v_w - 300, 30, '#9a6a34');

  insert into public.expense_categories (workspace_id, name) values
    (v_ws, 'Proveedores e insumos'), (v_ws, 'Mantenimiento'), (v_ws, 'Reparaciones'),
    (v_ws, 'Limpieza'), (v_ws, 'Materiales y herramientas'), (v_ws, 'Personal'),
    (v_ws, 'Servicios'), (v_ws, 'Otros gastos');
  insert into public.package_discounts (workspace_id, min_days, percent)
  values (v_ws, 5, 5), (v_ws, 7, 8), (v_ws, 15, 12), (v_ws, 30, 20);
  insert into public.user_preferences (user_id) values (v_user) on conflict (user_id) do nothing;
  return v_ws;
end $$;

drop function if exists public.create_workspace(text);
revoke all on function public.create_workspace(text, integer, integer) from public, anon;
grant execute on function public.create_workspace(text, integer, integer) to authenticated;

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

-- =====================================================================
-- 0022 · Importar una copia de seguridad desde un archivo descargado.
--   · Solo el propietario. El archivo se revisa y queda guardado como una copia
--     más ("Importada"); para usarla hay que tocar Restaurar (dos pasos, a propósito).
--   · Si el archivo es de OTRO balneario (por ejemplo, para pasar los datos a una
--     cuenta nueva), se le asignan identificadores nuevos para que no choque con nada.
-- =====================================================================
alter table public.backups drop constraint if exists backups_kind_check;
alter table public.backups add constraint backups_kind_check check (kind in ('manual', 'automatica', 'importada'));

create or replace function public.import_backup(p_workspace_id uuid, p_data jsonb, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tables text[] := private.restore_tables();
  v_src text;
  v_remap boolean;
  v_out jsonb := '{}'::jsonb;
  v_rows jsonb;
  v_counts jsonb;
  v_total integer := 0;
  v_size integer;
  v_id uuid;
  t text;
begin
  perform private.require_member(p_workspace_id, array['propietario']);
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'El archivo no es una copia de seguridad del sistema.';
  end if;
  if coalesce(p_data ->> 'formato', 'balneario-copia-v1') <> 'balneario-copia-v1'
     or not (p_data ? 'reservations' and p_data ? 'customers') then
    raise exception 'El archivo no es una copia de seguridad del sistema (faltan reservas o clientes).';
  end if;
  v_size := octet_length(p_data::text);
  if v_size > 50 * 1024 * 1024 then
    raise exception 'El archivo es demasiado grande (máximo 50 MB).';
  end if;

  foreach t in array v_tables loop
    v_rows := coalesce(p_data -> t, '[]'::jsonb);
    if jsonb_typeof(v_rows) <> 'array' then
      raise exception 'El archivo está dañado (la parte "%" no es una lista).', t;
    end if;
    v_total := v_total + jsonb_array_length(v_rows);
  end loop;
  if v_total > 300000 then
    raise exception 'El archivo tiene demasiados registros.';
  end if;

  v_src := p_data -> 'workspace' ->> 'id';
  v_remap := v_src is distinct from p_workspace_id::text;

  -- Las copias viejas (antes de la actualización 0021) no guardaban bien las carpas: no se pueden pasar a otro balneario.
  if v_remap and jsonb_array_length(coalesce(p_data -> 'spaces', '[]'::jsonb)) > 0
     and jsonb_typeof(p_data -> 'spaces' -> 0) <> 'object' then
    raise exception 'Esta copia es anterior a la actualización de las copias y no guarda las carpas: solo se puede usar en el mismo balneario donde se hizo.';
  end if;

  -- Identificadores nuevos cuando la copia viene de otro balneario.
  create temporary table if not exists _idmap (old_txt text primary key, new uuid not null) on commit drop;
  truncate _idmap;
  if v_remap then
    foreach t in array v_tables loop
      insert into _idmap (old_txt, new)
      select r ->> 'id', gen_random_uuid()
      from jsonb_array_elements(coalesce(p_data -> t, '[]'::jsonb)) r
      where jsonb_typeof(r) = 'object' and r ? 'id'
      on conflict (old_txt) do nothing;
    end loop;
  end if;

  foreach t in array v_tables loop
    v_rows := coalesce(p_data -> t, '[]'::jsonb);
    select coalesce(jsonb_agg(
             case when jsonb_typeof(r) = 'object' then
               r
               || coalesce((select jsonb_object_agg(e.key, to_jsonb(m.new)) from jsonb_each_text(r) e join _idmap m on m.old_txt = e.value), '{}'::jsonb)
               || jsonb_build_object('workspace_id', p_workspace_id)
             else r end), '[]'::jsonb)
      into v_rows
    from jsonb_array_elements(v_rows) r;
    v_out := v_out || jsonb_build_object(t, v_rows);
  end loop;
  v_out := v_out || jsonb_build_object('workspace', jsonb_build_object('id', p_workspace_id),
                                       'importada_de', v_src, 'creada_original', p_data ->> 'creada');

  select jsonb_object_agg(key, jsonb_array_length(value)) into v_counts from jsonb_each(v_out) where jsonb_typeof(value) = 'array';
  insert into public.backups (workspace_id, kind, note, counts, size_bytes, data, created_by_email)
  values (p_workspace_id, 'importada',
          left(coalesce(nullif(btrim(p_note), ''), 'Archivo importado') ||
               case when p_data ? 'creada' then ' · copia del ' || to_char((p_data ->> 'creada')::timestamptz at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI') else '' end ||
               case when v_remap then ' · de otro balneario' else '' end, 200),
          v_counts, octet_length(v_out::text), v_out,
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  returning id into v_id;
  return jsonb_build_object('backup_id', v_id, 'counts', v_counts, 'de_otro_balneario', v_remap);
end $$;

revoke all on function public.import_backup(uuid, jsonb, text) from public, anon;
grant execute on function public.import_backup(uuid, jsonb, text) to authenticated;

-- =====================================================================
-- 0023 · Seguridad
--   1. Límite de intentos de inicio de sesión: después de 10 contraseñas
--      incorrectas para un mismo usuario (o 30 desde una misma conexión)
--      en 15 minutos, se bloquea por 15 minutos.
--   2. Se quitan permisos de más que habían quedado en algunas tablas
--      (no eran aprovechables desde la página, pero lo correcto es no tenerlos).
-- =====================================================================

-- 1. Intentos de inicio de sesión (solo los ve y usa el servidor).
create table private.login_attempts (
  id   bigint generated always as identity primary key,
  key  text not null,
  ok   boolean not null,
  at   timestamptz not null default now()
);
create index login_attempts_key_at_idx on private.login_attempts(key, at);
revoke all on private.login_attempts from public, anon, authenticated;

-- ¿Se puede intentar? (límite de fallas en los últimos 15 minutos)
create or replace function public.login_allowed(p_user_key text, p_ip_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select count(*) from private.login_attempts
          where key = p_user_key and not ok and at > now() - interval '15 minutes') < 10
     and (p_ip_key is null or (select count(*) from private.login_attempts
          where key = p_ip_key and not ok and at > now() - interval '15 minutes') < 30)
$$;

-- Anota el resultado. Si entró bien, se limpian sus fallas.
create or replace function public.login_record(p_user_key text, p_ip_key text, p_ok boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_ok then
    delete from private.login_attempts where key = p_user_key;
  else
    insert into private.login_attempts (key, ok) values (p_user_key, false);
    if p_ip_key is not null then
      insert into private.login_attempts (key, ok) values (p_ip_key, false);
    end if;
  end if;
  -- Limpieza: no hace falta guardar intentos de más de un día.
  delete from private.login_attempts where at < now() - interval '1 day';
end $$;

revoke all on function public.login_allowed(text, text), public.login_record(text, text, boolean) from public, anon, authenticated;
grant execute on function public.login_allowed(text, text), public.login_record(text, text, boolean) to service_role;

-- 2. Permisos de más.
revoke insert, update, delete, truncate, references, trigger on public.restaurant_vouchers from anon, authenticated;
revoke select on public.restaurant_vouchers from anon;
revoke insert, update, delete, truncate, references, trigger on public.reservation_balances from anon, authenticated;
revoke select on public.reservation_balances from anon;
revoke truncate, references, trigger on public.audit_log, public.workspace_members, public.workspaces from anon, authenticated;

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

-- =====================================================================
-- 0026 · "No vino": liberar la carpa y descontar el día.
--   · Reserva de 1 día: al marcar "no vino" la carpa se libera sola.
--   · Reserva de varios días: la reserva sigue; se puede liberar el día que
--     no vino y, si el administrador quiere, descontarlo del precio.
--   · La reserva nunca se cancela ni se borra. Liberar un día queda como un
--     cambio de la reserva (se puede revertir); el descuento no se revierte solo.
-- =====================================================================

-- Días liberados por "no vino" (cambios vigentes, no revertidos).
create or replace function private.released_days(p_reservation_id uuid) returns date[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg((c.after_state ->> 'liberado')::date), '{}')
  from public.reservation_changes c
  where c.reservation_id = p_reservation_id and c.kind = 'reubicacion'
    and c.after_state ? 'liberado' and c.reverted_by_change_id is null
$$;

-- Cobertura: cada día de la estadía tiene una carpa, salvo los liberados por "no vino".
create or replace function private.assert_coverage(p_reservation_id uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_res public.reservations%rowtype;
  v_released date[];
  v_missing date;
begin
  select * into v_res from public.reservations where id = p_reservation_id;
  if v_res.status = 'cancelada' then
    if exists (select 1 from public.reservation_segments where reservation_id = p_reservation_id and active) then
      raise exception 'Una reserva cancelada no puede ocupar espacios.';
    end if;
    return;
  end if;
  if exists (select 1 from public.reservation_segments
             where reservation_id = p_reservation_id and active
               and (start_date < v_res.start_date or end_date > v_res.end_date)) then
    raise exception 'Los tramos de carpa se salen de las fechas de la estadía.';
  end if;
  v_released := private.released_days(p_reservation_id);
  select min(d::date) into v_missing
  from generate_series(v_res.start_date, v_res.end_date, interval '1 day') d
  where not (d::date = any(v_released))
    and not exists (select 1 from public.reservation_segments s
                    where s.reservation_id = p_reservation_id and s.active
                      and d::date between s.start_date and s.end_date);
  if v_missing is not null then
    raise exception 'Los tramos de carpa dejan días sin asignar (falta el %).', to_char(v_missing, 'DD/MM/YYYY');
  end if;
end $$;

-- Libera un día de la reserva (sin tocar el dinero). Devuelve el id del cambio o null si ya estaba libre.
create or replace function private.release_day(p_res public.reservations, p_day date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_seg public.reservation_segments%rowtype;
  v_code text;
  v_change_id uuid := gen_random_uuid();
begin
  select * into v_seg from public.reservation_segments
  where reservation_id = p_res.id and active and p_day between start_date and end_date;
  if not found then
    return null;
  end if;
  select code into v_code from public.spaces where id = v_seg.space_id;
  perform private.lock_spaces(array[v_seg.space_id]);

  insert into public.reservation_changes (id, workspace_id, reservation_id, kind, description, reason, before_state)
  values (v_change_id, p_res.workspace_id, p_res.id, 'reubicacion',
          format('No vino: se liberó %s el %s', v_code, to_char(p_day, 'DD/MM/YYYY')), 'No vino',
          jsonb_build_object('segments', private.segments_snapshot(p_res.id)));

  update public.reservation_segments set active = false, ended_by_change_id = v_change_id where id = v_seg.id;
  if v_seg.start_date < p_day then
    insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
    values (v_seg.workspace_id, p_res.id, v_seg.space_id, v_seg.start_date, p_day - 1, v_change_id);
  end if;
  if v_seg.end_date > p_day then
    insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
    values (v_seg.workspace_id, p_res.id, v_seg.space_id, p_day + 1, v_seg.end_date, v_change_id);
  end if;

  update public.reservation_changes
     set after_state = jsonb_build_object('segments', private.segments_snapshot(p_res.id), 'liberado', p_day, 'space_code', v_code)
   where id = v_change_id;
  perform private.assert_coverage(p_res.id);
  update public.reservations set version = version + 1 where id = p_res.id;
  return v_change_id;
end $$;
revoke all on function private.release_day(public.reservations, date) from public, anon, authenticated;

-- Texto con el que se reconoce el descuento de un día de "no vino".
create or replace function private.no_show_reason(p_day date) returns text
language sql immutable as $$ select 'No vino el ' || to_char(p_day, 'DD/MM/YYYY') $$;

-- Liberar el día que no vino (cualquier usuario) y, opcionalmente, descontarlo (administradores).
create or replace function public.release_no_show_day(p_reservation_id uuid, p_day date, p_discount boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_res public.reservations%rowtype;
  v_today date;
  v_change uuid;
  v_days integer;
  v_prev numeric;
  v_amount numeric := 0;
  v_total numeric;
  v_pos integer;
begin
  select * into v_res from public.reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'La reserva no existe.';
  end if;
  if p_discount then
    perform private.require_member(v_res.workspace_id, array['propietario','administrador']);
  else
    perform private.require_member(v_res.workspace_id);
  end if;
  if v_res.status <> 'confirmada' then
    raise exception 'La reserva está cancelada.';
  end if;
  if v_res.arrival_status is distinct from 'no_vino' then
    raise exception 'Primero marcá que el cliente no vino.';
  end if;
  select (now() at time zone w.timezone)::date into v_today from public.workspaces w where w.id = v_res.workspace_id;
  if p_day is null or p_day < v_res.start_date or p_day > v_res.end_date then
    raise exception 'El día tiene que estar dentro de la estadía (del % al %).', to_char(v_res.start_date, 'DD/MM/YYYY'), to_char(v_res.end_date, 'DD/MM/YYYY');
  end if;
  if p_day > v_today then
    raise exception 'Solo se pueden liberar días de hoy o anteriores.';
  end if;

  v_change := private.release_day(v_res, p_day);
  if v_change is null and not (p_day = any(private.released_days(p_reservation_id))) then
    raise exception 'Ese día no tiene carpa asignada.';
  end if;

  if p_discount then
    if v_res.is_courtesy then
      raise exception 'Una cortesía no tiene precio para descontar.';
    end if;
    if exists (select 1 from public.reservation_discounts
               where reservation_id = p_reservation_id and kind = 'manual' and reason = private.no_show_reason(p_day)) then
      raise exception 'Ese día ya se descontó.';
    end if;
    -- Lo que vale un día de esta reserva (total contratado ÷ días), sin contar días ya descontados.
    select v.total_amount + coalesce(sum(d.amount), 0) into v_prev
    from public.reservations v
    left join public.reservation_discounts d on d.reservation_id = v.id and d.kind = 'manual' and d.reason like 'No vino el %'
    where v.id = p_reservation_id
    group by v.total_amount;
    v_days := v_res.end_date - v_res.start_date + 1;
    select total_amount into v_total from public.reservations where id = p_reservation_id;
    v_amount := least(round(v_prev / v_days, 2), v_total);
    if v_amount > 0 then
      select coalesce(max(position), 0) + 1 into v_pos from public.reservation_discounts where reservation_id = p_reservation_id;
      insert into public.reservation_discounts (workspace_id, reservation_id, position, kind, label, amount, reason)
      values (v_res.workspace_id, p_reservation_id, v_pos, 'manual', 'Día no usado (no vino)', v_amount, private.no_show_reason(p_day));
      perform set_config('app.reason', private.no_show_reason(p_day) || ': se descuenta el día', true);
      update public.reservations
         set discount_amount = discount_amount + v_amount, total_amount = total_amount - v_amount, version = version + 1
       where id = p_reservation_id;
    end if;
  end if;

  return jsonb_build_object('change_id', v_change, 'liberado', p_day, 'descuento', v_amount);
end $$;
revoke all on function public.release_no_show_day(uuid, date, boolean) from public, anon;
grant execute on function public.release_no_show_day(uuid, date, boolean) to authenticated;

-- Un día liberado y descontado no se vuelve a ocupar revirtiendo el cambio
-- (habría que deshacer también el descuento, que es dinero).
create or replace function private.block_revert_discounted() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_day date;
begin
  if new.kind <> 'reversion' or new.reverts_change_id is null or private.restoring(new.workspace_id::text) then
    return new;
  end if;
  select (after_state ->> 'liberado')::date into v_day from public.reservation_changes where id = new.reverts_change_id;
  if v_day is not null and exists (select 1 from public.reservation_discounts
                                   where reservation_id = new.reservation_id and kind = 'manual' and reason = private.no_show_reason(v_day)) then
    raise exception 'Ese día ya se descontó del precio: no se puede volver a ocupar automáticamente. Si vino, hacé una reserva nueva para ese día.'
      using hint = 'REVERSION_CON_DESCUENTO';
  end if;
  return new;
end $$;
create trigger reservation_changes_block_discounted before insert on public.reservation_changes
  for each row execute function private.block_revert_discounted();

-- Llegó / no vino: la reserva de 1 día se libera sola al marcar "no vino";
-- si después se corrige la marca, se vuelve a ocupar (si sigue libre y no se descontó).
create or replace function public.set_arrival(p_reservation_id uuid, p_state text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_res public.reservations%rowtype;
  v_today date;
  v_chg uuid;
  v_released uuid;
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

  -- Deja de ser "no vino": se vuelven a ocupar los días liberados (el más reciente primero).
  if v_res.arrival_status = 'no_vino' then
    for v_chg in select c.id from public.reservation_changes c
                 where c.reservation_id = p_reservation_id and c.kind = 'reubicacion'
                   and c.after_state ? 'liberado' and c.reverted_by_change_id is null
                 order by c.at desc loop
      perform public.revert_change(v_chg, 'Se corrigió la marca de "no vino"');
    end loop;
    select * into v_res from public.reservations where id = p_reservation_id;
  end if;

  update public.reservations
     set arrival_status = p_state,
         arrival_at = case when p_state is null then null else now() end,
         arrival_by = case when p_state is null then null else auth.uid() end,
         version = version + 1
   where id = p_reservation_id
  returning * into v_res;

  if p_state = 'no_vino' and v_res.start_date = v_res.end_date then
    v_released := private.release_day(v_res, v_res.start_date);
  end if;
  return jsonb_build_object('arrival_status', p_state, 'liberado', v_released is not null);
end $$;
revoke all on function public.set_arrival(uuid, text) from public, anon;
grant execute on function public.set_arrival(uuid, text) to authenticated;

-- =====================================================================
-- 0027 · Mensajes de WhatsApp propios de cada balneario.
--   message_templates = { "deuda_hoy": "Hola {nombre}…", … } (null o vacío → los de siempre).
-- =====================================================================
create or replace function private.valid_message_templates(s jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare k text;
begin
  if s is null then return true; end if;
  if jsonb_typeof(s) <> 'object' then return false; end if;
  for k in select jsonb_object_keys(s) loop
    if k not in ('deuda_hoy', 'deuda_manana', 'deuda_vencida', 'deuda_otros') then return false; end if;
    if jsonb_typeof(s -> k) <> 'string' or char_length(s ->> k) > 1000 then return false; end if;
  end loop;
  return true;
end $$;

alter table public.workspaces add column if not exists message_templates jsonb;
alter table public.workspaces drop constraint if exists workspaces_message_templates_check;
alter table public.workspaces add constraint workspaces_message_templates_check check (private.valid_message_templates(message_templates));
grant update (message_templates) on public.workspaces to authenticated;

-- =====================================================================
-- 0028 · Altas cerradas: nadie puede crear un balneario por su cuenta.
--   · Solo pueden crear su balneario las cuentas cuyo correo esté habilitado
--     (por ejemplo, cuando un cliente contrata un plan).
--   · Las cuentas que ya tienen balneario y los usuarios que crea cada propietario
--     siguen funcionando igual. La demo tampoco cambia.
--
--   Para habilitar a un cliente (en Supabase → SQL Editor):
--     select private.permitir_alta('cliente@gmail.com', 'Plan 1, pagó el 05/11');
--   Para volver a abrir las altas a todo el mundo:
--     update private.plataforma set altas_abiertas = true;
-- =====================================================================
create table if not exists private.plataforma (
  id             integer primary key default 1 check (id = 1),
  altas_abiertas boolean not null default false
);
insert into private.plataforma (id) values (1) on conflict (id) do nothing;

create table if not exists private.signup_allowlist (
  email        text primary key check (email = lower(email) and email like '%@%'),
  note         text,
  created_at   timestamptz not null default now(),
  used_at      timestamptz,
  workspace_id uuid
);
alter table private.plataforma enable row level security;
alter table private.signup_allowlist enable row level security;
revoke all on private.plataforma, private.signup_allowlist from public, anon, authenticated;

create or replace function private.permitir_alta(p_email text, p_note text default null) returns void
language sql security definer set search_path = '' as $$
  insert into private.signup_allowlist (email, note) values (lower(btrim(p_email)), p_note)
  on conflict (email) do update set note = coalesce(excluded.note, private.signup_allowlist.note)
$$;
revoke all on function private.permitir_alta(text, text) from public, anon, authenticated;

create or replace function private.can_create_workspace(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user is not null
     and not coalesce((select u.is_anonymous from auth.users u where u.id = p_user), false)
     and (
       (select altas_abiertas from private.plataforma where id = 1)
       or exists (select 1 from private.signup_allowlist a
                  join auth.users u on lower(u.email::text) = a.email
                  where u.id = p_user and a.used_at is null)
     )
$$;
revoke all on function private.can_create_workspace(uuid) from public, anon, authenticated;

-- Para la pantalla: ¿esta cuenta puede crear su balneario?
create or replace function public.can_create_workspace() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_create_workspace(auth.uid())
$$;
revoke all on function public.can_create_workspace() from public, anon;
grant execute on function public.can_create_workspace() to authenticated;

create or replace function public.create_workspace(p_name text, p_tents integer default 90, p_umbrellas integer default 10)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_user uuid := auth.uid();
  v_email text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email';
  v_cols constant integer := 15;
  v_rows integer;
  v_w integer;
  v_h integer;
  v_digits integer;
  i integer;
begin
  if v_user is null then
    raise exception 'Tenés que iniciar sesión.' using errcode = '28000';
  end if;
  if private.is_guest() then
    raise exception 'En el modo invitado no se puede crear un balneario. Registrate con Google o con un usuario.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'Ingresá el nombre del balneario.';
  end if;
  if p_tents is null or p_tents < 0 or p_tents > 600 or p_umbrellas is null or p_umbrellas < 0 or p_umbrellas > 300 or p_tents + p_umbrellas = 0 then
    raise exception 'Indicá cuántas carpas (hasta 600) y sombrillas (hasta 300) tenés.';
  end if;
  -- Una cuenta, un balneario (evita duplicados por doble clic o dos pestañas).
  perform pg_advisory_xact_lock(hashtextextended('alta-balneario:' || v_user::text, 0));
  if exists (select 1 from public.workspace_members where user_id = v_user) then
    raise exception 'Tu cuenta ya pertenece a un balneario.';
  end if;
  if not private.can_create_workspace(v_user) then
    raise exception 'Para crear un balneario hace falta un plan. Mirá los planes en la página principal o escribinos.'
      using errcode = '42501', hint = 'SIN_PLAN';
  end if;

  -- Plano genérico: filas de 15 carpas y, más cerca del mar, las sombrillas.
  v_rows := ceil(p_tents / v_cols::numeric)::integer + ceil(p_umbrellas / v_cols::numeric)::integer;
  v_w := 300 + v_cols * 180;
  v_h := greatest(1200, 700 + v_rows * 160);
  v_digits := greatest(2, length((p_tents + p_umbrellas)::text));

  insert into public.workspaces (name, created_by, map_width, map_height, sea_side)
  values (btrim(p_name), v_user, v_w, v_h, 'bottom')
  returning id into v_ws;
  insert into public.workspace_members (workspace_id, user_id, role, email) values (v_ws, v_user, 'propietario', v_email);

  for i in 1..p_tents loop
    insert into public.spaces (workspace_id, kind, code, x, y)
    values (v_ws, 'carpa', lpad(i::text, v_digits, '0'), 240 + ((i - 1) % v_cols) * 180, 420 + ((i - 1) / v_cols) * 160);
  end loop;
  for i in 1..p_umbrellas loop
    insert into public.spaces (workspace_id, kind, code, x, y)
    values (v_ws, 'sombrilla', lpad((p_tents + i)::text, v_digits, '0'), 240 + ((i - 1) % v_cols) * 180,
            420 + (ceil(p_tents / v_cols::numeric)::integer + (i - 1) / v_cols) * 160 + 40);
  end loop;

  insert into public.map_features (workspace_id, kind, label, x, y, width, height, color) values
    (v_ws, 'instalacion', 'Parador', v_w / 2 - 300, 60, 600, 180, '#a86a1f'),
    (v_ws, 'camino', null, 150, 300, v_w - 300, 30, '#9a6a34');

  insert into public.expense_categories (workspace_id, name) values
    (v_ws, 'Proveedores e insumos'), (v_ws, 'Mantenimiento'), (v_ws, 'Reparaciones'),
    (v_ws, 'Limpieza'), (v_ws, 'Materiales y herramientas'), (v_ws, 'Personal'),
    (v_ws, 'Servicios'), (v_ws, 'Otros gastos');
  insert into public.package_discounts (workspace_id, min_days, percent)
  values (v_ws, 5, 5), (v_ws, 7, 8), (v_ws, 15, 12), (v_ws, 30, 20);
  insert into public.user_preferences (user_id) values (v_user) on conflict (user_id) do nothing;
  update private.signup_allowlist set used_at = now(), workspace_id = v_ws
   where email = lower(coalesce((select u.email::text from auth.users u where u.id = v_user), '')) and used_at is null;
  return v_ws;
end $$;

revoke all on function public.create_workspace(text, integer, integer) from public, anon;
grant execute on function public.create_workspace(text, integer, integer) to authenticated;

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

-- =====================================================================
-- 0030 · Planes de Mi Balneario (mensual o temporada) con débito automático.
--   · Cada balneario habilitado con plan tiene una "suscripción": plan, precio y
--     hasta qué día está pago.
--   · Mercado Pago debita solo (mensual: cada mes; temporada: cada 1/12). El servidor
--     recibe los avisos de Mercado Pago y extiende la fecha.
--   · Si el plan vence (el cliente canceló o rebotó el débito), a los 3 días de gracia
--     el balneario queda en "solo lectura": ve y descarga todo, pero no carga cambios.
--   · Los balnearios sin plan (por ejemplo el tuyo) no tienen vencimiento.
-- =====================================================================

-- Precios y reglas generales (los cambia el dueño desde su panel)
alter table private.plataforma add column if not exists precio_mensual   numeric(14,2) not null default 0 check (precio_mensual >= 0);
alter table private.plataforma add column if not exists precio_temporada numeric(14,2) not null default 0 check (precio_temporada >= 0);
alter table private.plataforma add column if not exists dias_gracia      integer not null default 3 check (dias_gracia between 0 and 30);

-- El correo habilitado lleva el plan contratado
alter table private.signup_allowlist add column if not exists plan text check (plan in ('mensual','temporada'));
alter table private.signup_allowlist add column if not exists price numeric(14,2) check (price >= 0);

create or replace function private.today_ar() returns date
language sql stable as $$ select (now() at time zone 'America/Argentina/Buenos_Aires')::date $$;

-- Fin de la temporada que incluye (o sigue a) una fecha: la temporada va del 1/12 al 31/3.
create or replace function private.season_end(p_day date) returns date
language sql immutable as $$
  select case when extract(month from p_day) <= 3 then make_date(extract(year from p_day)::int, 3, 31)
              else make_date(extract(year from p_day)::int + 1, 3, 31) end
$$;
-- Próximo 1/12 (el de este año si todavía no pasó).
create or replace function private.next_season_start(p_day date) returns date
language sql immutable as $$
  select case when p_day <= make_date(extract(year from p_day)::int, 12, 1) then make_date(extract(year from p_day)::int, 12, 1)
              else make_date(extract(year from p_day)::int + 1, 12, 1) end
$$;

create table public.subscriptions (
  workspace_id        uuid primary key references public.workspaces(id) on delete cascade,
  plan                text not null check (plan in ('mensual','temporada')),
  price               numeric(14,2) not null check (price >= 0),
  -- pendiente: todavía no activó el débito · activa: débito automático autorizado ·
  -- cancelada: el cliente decidió no renovar · manual: paga por transferencia/efectivo ·
  -- exenta: sin vencimiento
  status              text not null default 'pendiente' check (status in ('pendiente','activa','cancelada','manual','exenta')),
  paid_until          date,
  mp_preapproval_id   text unique,
  mp_payer_email      text,
  next_charge_on      date,
  last_payment_at     timestamptz,
  last_payment_status text check (last_payment_status in ('aprobado','rechazado')),
  last_payment_amount numeric(14,2),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
create policy "miembros ven su plan" on public.subscriptions for select to authenticated using (private.is_member(workspace_id));
revoke all on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;
grant select, insert, update on public.subscriptions to service_role;

create table public.subscription_events (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind         text not null check (kind in ('alta','debito_activado','pago_aprobado','pago_rechazado','cancelada','pago_manual','cambio_plan')),
  amount       numeric(14,2),
  detail       text,
  external_id  text,
  actor_id     uuid,
  created_at   timestamptz not null default now(),
  seen_at      timestamptz,
  unique (kind, external_id)
);
create index subscription_events_ws_idx on public.subscription_events (workspace_id, created_at desc);
alter table public.subscription_events enable row level security;
create policy "miembros ven los movimientos de su plan" on public.subscription_events for select to authenticated using (private.is_member(workspace_id));
revoke all on public.subscription_events from anon, authenticated;
grant select on public.subscription_events to authenticated;

-- ---------------------------------------------------------------------
-- ¿Puede cargar cambios? (pausa del dueño o plan vencido)
-- ---------------------------------------------------------------------
create or replace function private.plan_expired(p_ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.subscriptions s
    where s.workspace_id = p_ws and s.status <> 'exenta'
      and coalesce(s.paid_until, s.created_at::date) + (select dias_gracia from private.plataforma where id = 1) < private.today_ar()
  )
$$;

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
  if private.plan_expired(v_ws::uuid) then
    raise exception 'Tu plan de Mi Balneario venció: podés ver y descargar tus datos, pero no cargar cambios. Renovalo en Configuración → Mi plan.'
      using errcode = '42501', hint = 'PLAN_VENCIDO';
  end if;
  return coalesce(new, old);
end $$;

-- Hasta qué día queda pago después de un cobro.
create or replace function private.extend_until(p_plan text, p_current date, p_paid_on date) returns date
language sql immutable as $$
  select case p_plan
    when 'mensual' then (greatest(coalesce(p_current, p_paid_on), p_paid_on) + interval '1 month')::date
    else case when private.season_end(p_paid_on) > coalesce(p_current, p_paid_on - 1)
              then private.season_end(p_paid_on)
              else private.season_end(p_current + 1) end
  end
$$;

-- Al crear el balneario con un correo habilitado con plan, nace su suscripción.
-- Arranca con la fecha de hoy: tiene los días de gracia para activar el débito.
create or replace function private.allowlist_creates_subscription() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.workspace_id is not null and old.workspace_id is null and new.plan is not null then
    insert into public.subscriptions (workspace_id, plan, price, paid_until)
    values (new.workspace_id, new.plan,
            coalesce(new.price, (select case new.plan when 'mensual' then precio_mensual else precio_temporada end from private.plataforma where id = 1)),
            private.today_ar())
    on conflict (workspace_id) do nothing;
    insert into public.subscription_events (workspace_id, kind, detail) values (new.workspace_id, 'alta', 'Plan ' || new.plan);
  end if;
  return new;
end $$;
drop trigger if exists allowlist_creates_subscription on private.signup_allowlist;
create trigger allowlist_creates_subscription after update on private.signup_allowlist
  for each row execute function private.allowlist_creates_subscription();

-- ---------------------------------------------------------------------
-- Para el balneario: ver su plan y decidir no renovar (si no tiene débito)
-- ---------------------------------------------------------------------
create or replace function public.my_plan(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions%rowtype; v_grace int;
begin
  perform private.require_member(p_workspace_id);
  select * into s from public.subscriptions where workspace_id = p_workspace_id;
  if not found then return null; end if;
  select dias_gracia into v_grace from private.plataforma where id = 1;
  return jsonb_build_object(
    'plan', s.plan, 'precio', s.price, 'estado', s.status, 'pago_hasta', s.paid_until,
    'bloquea_desde', case when s.status = 'exenta' then null else coalesce(s.paid_until, s.created_at::date) + v_grace + 1 end,
    'vencido', private.plan_expired(p_workspace_id), 'dias_gracia', v_grace,
    'proximo_debito', s.next_charge_on, 'debito_automatico', s.mp_preapproval_id is not null and s.status = 'activa',
    'pagador', s.mp_payer_email, 'ultimo_pago', s.last_payment_at, 'ultimo_estado', s.last_payment_status,
    'temporada_hasta', private.season_end(private.today_ar()), 'hoy', private.today_ar(),
    'movimientos', coalesce((select jsonb_agg(jsonb_build_object('tipo', e.kind, 'importe', e.amount, 'detalle', e.detail, 'fecha', e.created_at) order by e.created_at desc)
                             from (select * from public.subscription_events where workspace_id = p_workspace_id order by created_at desc limit 12) e), '[]'::jsonb)
  );
end $$;
revoke all on function public.my_plan(uuid) from public, anon;
grant execute on function public.my_plan(uuid) to authenticated;

-- "No renovar" cuando no hay débito automático (si lo hay, lo cancela el servidor en Mercado Pago).
create or replace function public.cancel_my_plan(p_workspace_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions%rowtype;
begin
  perform private.require_member(p_workspace_id, array['propietario']);
  select * into s from public.subscriptions where workspace_id = p_workspace_id for update;
  if not found or s.status in ('cancelada','exenta') then raise exception 'No hay un plan para cancelar.'; end if;
  if s.mp_preapproval_id is not null and s.status = 'activa' then
    raise exception 'El débito automático se cancela desde el botón «No renovar» (avisa a Mercado Pago).';
  end if;
  update public.subscriptions set status = 'cancelada', updated_at = now() where workspace_id = p_workspace_id;
  insert into public.subscription_events (workspace_id, kind, detail, actor_id) values (p_workspace_id, 'cancelada', 'El cliente decidió no renovar', auth.uid());
end $$;
revoke all on function public.cancel_my_plan(uuid) from public, anon;
grant execute on function public.cancel_my_plan(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Para el servidor (Mercado Pago). Solo con la clave secreta (service_role).
-- ---------------------------------------------------------------------
create or replace function public.plan_for_checkout(p_workspace_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('plan', s.plan, 'precio', s.price, 'estado', s.status, 'preapproval', s.mp_preapproval_id,
                            'balneario', w.name, 'pago_hasta', s.paid_until, 'hoy', private.today_ar(),
                            'inicio_temporada', private.next_season_start(private.today_ar()))
  from public.subscriptions s join public.workspaces w on w.id = s.workspace_id
  where s.workspace_id = p_workspace_id
$$;

create or replace function public.plan_mp_link(p_workspace_id uuid, p_preapproval_id text, p_payer_email text) returns void
language sql security definer set search_path = '' as $$
  update public.subscriptions set mp_preapproval_id = p_preapproval_id, mp_payer_email = p_payer_email, updated_at = now()
  where workspace_id = p_workspace_id
$$;

-- Estado del débito según Mercado Pago (authorized / paused / cancelled / pending).
create or replace function public.plan_mp_status(p_preapproval_id text, p_status text, p_next_charge date, p_actor uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions%rowtype;
begin
  select * into s from public.subscriptions where mp_preapproval_id = p_preapproval_id for update;
  if not found then return; end if;
  if p_status = 'authorized' then
    -- Con el débito autorizado queda cubierto hasta el primer cobro (temporada: el 1/12).
    -- Si se suma con la temporada ya empezada, esta temporada no la cubre el débito
    -- (empieza el próximo 1/12): esa la registra el dueño como pago aparte.
    update public.subscriptions
       set status = 'activa', next_charge_on = p_next_charge,
           paid_until = case when s.plan = 'temporada' and extract(month from private.today_ar()) in (12, 1, 2, 3)
                             then paid_until
                             else greatest(coalesce(paid_until, private.today_ar()), coalesce(p_next_charge, private.today_ar())) end,
           updated_at = now()
     where workspace_id = s.workspace_id;
    if s.status <> 'activa' then
      insert into public.subscription_events (workspace_id, kind, detail, external_id)
      values (s.workspace_id, 'debito_activado', 'Débito automático activado en Mercado Pago', p_preapproval_id || ':authorized')
      on conflict (kind, external_id) do nothing;
    end if;
  elsif p_status in ('cancelled', 'paused') then
    if s.status = 'activa' then
      update public.subscriptions set status = 'cancelada', next_charge_on = null, updated_at = now() where workspace_id = s.workspace_id;
      insert into public.subscription_events (workspace_id, kind, detail, external_id, actor_id)
      values (s.workspace_id, 'cancelada',
              case when p_status = 'paused' then 'Débito pausado en Mercado Pago' else 'Débito automático cancelado: no se renueva' end,
              p_preapproval_id || ':' || p_status || ':' || now()::date, p_actor)
      on conflict (kind, external_id) do nothing;
    end if;
  else
    update public.subscriptions set next_charge_on = p_next_charge, updated_at = now() where workspace_id = s.workspace_id;
  end if;
end $$;

-- Un cobro del débito (aprobado o rechazado). No se aplica dos veces el mismo pago.
create or replace function public.plan_mp_payment(p_preapproval_id text, p_payment_id text, p_status text, p_amount numeric, p_paid_on date) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions%rowtype; v_new boolean;
begin
  select * into s from public.subscriptions where mp_preapproval_id = p_preapproval_id for update;
  if not found then return; end if;
  if p_status = 'approved' then
    insert into public.subscription_events (workspace_id, kind, amount, detail, external_id)
    values (s.workspace_id, 'pago_aprobado', p_amount, 'Débito automático (Mercado Pago)', p_payment_id)
    on conflict (kind, external_id) do nothing
    returning true into v_new;
    if v_new then
      update public.subscriptions
         set paid_until = private.extend_until(s.plan, s.paid_until, p_paid_on),
             last_payment_at = now(), last_payment_status = 'aprobado', last_payment_amount = p_amount, updated_at = now()
       where workspace_id = s.workspace_id;
    end if;
  elsif p_status = 'rejected' then
    insert into public.subscription_events (workspace_id, kind, amount, detail, external_id)
    values (s.workspace_id, 'pago_rechazado', p_amount, 'Mercado Pago no pudo debitar el plan', p_payment_id)
    on conflict (kind, external_id) do nothing
    returning true into v_new;
    if v_new then
      update public.subscriptions set last_payment_at = now(), last_payment_status = 'rechazado', last_payment_amount = p_amount, updated_at = now()
       where workspace_id = s.workspace_id;
    end if;
  end if;
end $$;

-- Balnearios con débito, para revisarlos una vez por día por si se perdió algún aviso.
create or replace function public.plan_mp_pending() returns setof text
language sql stable security definer set search_path = '' as $$
  select mp_preapproval_id from public.subscriptions where mp_preapproval_id is not null and status in ('pendiente','activa')
$$;

revoke all on function public.plan_for_checkout(uuid), public.plan_mp_link(uuid, text, text), public.plan_mp_status(text, text, date, uuid),
  public.plan_mp_payment(text, text, text, numeric, date), public.plan_mp_pending() from public, anon, authenticated;
grant execute on function public.plan_for_checkout(uuid), public.plan_mp_link(uuid, text, text), public.plan_mp_status(text, text, date, uuid),
  public.plan_mp_payment(text, text, text, numeric, date), public.plan_mp_pending() to service_role;
grant execute on function private.today_ar(), private.season_end(date), private.next_season_start(date), private.extend_until(text, date, date),
  private.plan_expired(uuid) to service_role;

-- ---------------------------------------------------------------------
-- Panel del dueño
-- ---------------------------------------------------------------------
create or replace function public.admin_set_prices(p_mensual numeric, p_temporada numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  if p_mensual is null or p_mensual < 0 or p_temporada is null or p_temporada < 0 then raise exception 'Precio inválido.'; end if;
  update private.plataforma set precio_mensual = p_mensual, precio_temporada = p_temporada where id = 1;
end $$;

drop function if exists public.admin_allow_signup(text, text);
create or replace function public.admin_allow_signup(p_email text, p_note text default null, p_plan text default null, p_price numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v text := lower(btrim(coalesce(p_email, '')));
begin
  perform private.require_platform_admin();
  if v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Correo inválido.'; end if;
  if p_plan is not null and p_plan not in ('mensual','temporada') then raise exception 'Plan inválido.'; end if;
  if p_price is not null and p_price < 0 then raise exception 'Precio inválido.'; end if;
  insert into private.signup_allowlist (email, note, plan, price) values (v, nullif(btrim(coalesce(p_note, '')), ''), p_plan, p_price)
  on conflict (email) do update set note = coalesce(excluded.note, private.signup_allowlist.note), plan = excluded.plan, price = excluded.price
  where private.signup_allowlist.used_at is null;
end $$;

-- Asignar o cambiar el plan de un balneario (también "exento" = sin vencimiento).
create or replace function public.admin_set_plan(p_workspace_id uuid, p_plan text, p_price numeric, p_exempt boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  if p_plan not in ('mensual','temporada') then raise exception 'Plan inválido.'; end if;
  if p_price is null or p_price < 0 then raise exception 'Precio inválido.'; end if;
  if not exists (select 1 from public.workspaces where id = p_workspace_id and not is_demo) then raise exception 'El balneario no existe.'; end if;
  insert into public.subscriptions (workspace_id, plan, price, status, paid_until)
  values (p_workspace_id, p_plan, p_price, case when p_exempt then 'exenta' else 'pendiente' end, private.today_ar())
  on conflict (workspace_id) do update
    set plan = excluded.plan, price = excluded.price,
        status = case when p_exempt then 'exenta'
                      when public.subscriptions.status = 'exenta' then 'pendiente'
                      else public.subscriptions.status end,
        updated_at = now();
  insert into public.subscription_events (workspace_id, kind, amount, detail, actor_id)
  values (p_workspace_id, 'cambio_plan', p_price, 'Plan ' || p_plan || case when p_exempt then ' (sin vencimiento)' else '' end, auth.uid());
end $$;

-- Pago por fuera de Mercado Pago (transferencia, efectivo): extiende el plan.
create or replace function public.admin_register_payment(p_workspace_id uuid, p_amount numeric, p_until date default null, p_note text default null) returns date
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions%rowtype; v_until date;
begin
  perform private.require_platform_admin();
  select * into s from public.subscriptions where workspace_id = p_workspace_id for update;
  if not found then raise exception 'Ese balneario no tiene plan. Asignale uno primero.'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Importe inválido.'; end if;
  v_until := coalesce(p_until, private.extend_until(s.plan, s.paid_until, private.today_ar()));
  if v_until < private.today_ar() then raise exception 'La fecha tiene que ser hoy o más adelante.'; end if;
  update public.subscriptions
     set paid_until = v_until, status = case when status in ('pendiente','cancelada') then 'manual' else status end,
         last_payment_at = now(), last_payment_status = 'aprobado', last_payment_amount = p_amount, updated_at = now()
   where workspace_id = p_workspace_id;
  insert into public.subscription_events (workspace_id, kind, amount, detail, actor_id)
  values (p_workspace_id, 'pago_manual', p_amount, coalesce(nullif(btrim(p_note), ''), 'Pago registrado a mano') || ' · pago hasta el ' || to_char(v_until, 'DD/MM/YYYY'), auth.uid());
  return v_until;
end $$;

create or replace function public.admin_mark_seen(p_event_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  update public.subscription_events set seen_at = now() where id = p_event_id and seen_at is null;
end $$;

-- Cantidad de avisos para el dueño (para el número rojo del menú).
create or replace function public.admin_alert_count() returns integer
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return (select count(*) from public.subscription_events where kind in ('cancelada','pago_rechazado') and seen_at is null)
       + (select count(*) from public.subscriptions s where private.plan_expired(s.workspace_id));
end $$;

create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_grace int;
begin
  perform private.require_platform_admin();
  select dias_gracia into v_grace from private.plataforma where id = 1;
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
          'ultimo_uso', (select max(a.at) from public.audit_log a where a.workspace_id = w.id),
          'plan', (select jsonb_build_object('plan', s.plan, 'precio', s.price, 'estado', s.status, 'pago_hasta', s.paid_until,
                                             'vencido', private.plan_expired(w.id), 'debito', s.mp_preapproval_id is not null and s.status = 'activa',
                                             'proximo_debito', s.next_charge_on, 'ultimo_estado', s.last_payment_status, 'ultimo_pago', s.last_payment_at)
                   from public.subscriptions s where s.workspace_id = w.id)
        ) as x
        from public.workspaces w
        where not w.is_demo
      ) t), '[]'::jsonb),
    'habilitaciones', coalesce((
      select jsonb_agg(jsonb_build_object('correo', a.email, 'nota', a.note, 'creado', a.created_at, 'usado', a.used_at,
                                          'plan', a.plan, 'precio', a.price,
                                          'balneario', (select name from public.workspaces where id = a.workspace_id))
                       order by a.created_at desc)
      from private.signup_allowlist a), '[]'::jsonb),
    'avisos', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'tipo', e.kind, 'balneario', w.name, 'workspace_id', e.workspace_id,
                                          'importe', e.amount, 'detalle', e.detail, 'fecha', e.created_at) order by e.created_at desc)
      from public.subscription_events e join public.workspaces w on w.id = e.workspace_id
      where e.kind in ('cancelada','pago_rechazado') and e.seen_at is null), '[]'::jsonb),
    'precios', (select jsonb_build_object('mensual', precio_mensual, 'temporada', precio_temporada, 'dias_gracia', dias_gracia) from private.plataforma where id = 1),
    'hoy', private.today_ar(),
    'demos_abiertas', (select count(*) from public.workspaces where is_demo)
  ) into v;
  return v;
end $$;

revoke all on function public.admin_set_prices(numeric, numeric), public.admin_allow_signup(text, text, text, numeric),
  public.admin_set_plan(uuid, text, numeric, boolean), public.admin_register_payment(uuid, numeric, date, text),
  public.admin_mark_seen(uuid), public.admin_alert_count() from public, anon;
grant execute on function public.admin_set_prices(numeric, numeric), public.admin_allow_signup(text, text, text, numeric),
  public.admin_set_plan(uuid, text, numeric, boolean), public.admin_register_payment(uuid, numeric, date, text),
  public.admin_mark_seen(uuid), public.admin_alert_count() to authenticated;

-- =====================================================================
-- 0031 · Importes con formato argentino en los textos que arma la base
--   ($ 18.000 en vez de $18,000; $ 1.234,50 en vez de 1,234.50).
--   · Descripción de cada tramo de precio de las reservas.
--   · Mensajes de error de los cobros ("supera el saldo pendiente").
--   · Corrige el texto de los tramos ya guardados (solo el formato del número).
-- =====================================================================

create or replace function private.ars(p numeric) returns text
language sql immutable as $$
  select case when p < 0 then '-' else '' end || '$ '
         || replace(to_char(trunc(abs(round(p, 2))), 'FM999,999,999,990'), ',', '.')
         || case when abs(round(p, 2)) - trunc(abs(round(p, 2))) > 0
                 then ',' || lpad(((abs(round(p, 2)) - trunc(abs(round(p, 2)))) * 100)::int::text, 2, '0') else '' end
$$;

create or replace function private.compute_quote(
  p_workspace_id uuid, p_start date, p_end date, p_segments jsonb, p_options jsonb
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_opts jsonb := coalesce(p_options, '{}'::jsonb);
  v_seg jsonb;
  v_space public.spaces%rowtype;
  v_d date;
  v_period_end date;
  v_half smallint;
  v_price numeric(14,2);
  v_rate public.rates%rowtype;
  v_days integer;
  v_charges jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_discounts jsonb := '[]'::jsonb;
  v_base numeric(14,2) := 0;
  v_cur numeric(14,2);
  v_amt numeric(14,2);
  v_pct numeric(5,2);
  v_total_days integer := p_end - p_start + 1;
  v_agreement public.agreements%rowtype;
  v_ws public.workspaces%rowtype;
  v_manual jsonb := v_opts -> 'manual';
  v_courtesy boolean := coalesce((v_opts ->> 'courtesy')::boolean, false);
  v_month_names text[] := array['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
begin
  select * into v_ws from public.workspaces where id = p_workspace_id;
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'Revisá las fechas: la salida no puede ser anterior a la entrada.';
  end if;

  if v_opts ? 'manual_base' and (v_opts ->> 'manual_base') is not null then
    -- Precio manual acordado (solo administradores)
    if not private.has_role(p_workspace_id, array['propietario','administrador']) then
      raise exception 'Solo un administrador puede fijar un precio manual.' using errcode = '42501';
    end if;
    v_base := floor((v_opts ->> 'manual_base')::numeric);
    if v_base < 0 then
      raise exception 'El precio manual no puede ser negativo.';
    end if;
    v_charges := jsonb_build_array(jsonb_build_object(
      'description', 'Precio manual acordado', 'start_date', p_start, 'end_date', p_end,
      'days', v_total_days, 'amount', v_base, 'is_manual', true));
  else
    for v_seg in select * from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) order by (value ->> 'start_date') loop
      select * into v_space from public.spaces where id = (v_seg ->> 'space_id')::uuid and workspace_id = p_workspace_id;
      if not found then
        raise exception 'Uno de los espacios elegidos no existe.';
      end if;
      v_d := (v_seg ->> 'start_date')::date;
      while v_d <= (v_seg ->> 'end_date')::date loop
        v_half := case when extract(day from v_d) <= 15 then 1 else 2 end;
        v_period_end := least((v_seg ->> 'end_date')::date,
          case when v_half = 1 then make_date(extract(year from v_d)::int, extract(month from v_d)::int, 15)
               else (date_trunc('month', v_d) + interval '1 month - 1 day')::date end);
        v_days := v_period_end - v_d + 1;
        select * into v_rate from public.rates
        where workspace_id = p_workspace_id and space_kind = v_space.kind
          and year = extract(year from v_d)::int and month = extract(month from v_d)::int and half = v_half;
        if not found then
          v_missing := v_missing || jsonb_build_object('space_kind', v_space.kind, 'year', extract(year from v_d)::int,
                         'month', extract(month from v_d)::int, 'half', v_half);
        else
          v_charges := v_charges || jsonb_build_object(
            'description', format('%s · %s al %s · %s %s × %s', private.space_label(v_space.kind, v_space.code),
                                  to_char(v_d, 'DD/MM'), to_char(v_period_end, 'DD/MM'), v_days,
                                  case when v_days = 1 then 'día' else 'días' end,
                                  private.ars(v_rate.daily_price)),
            'space_id', v_space.id, 'space_kind', v_space.kind, 'start_date', v_d, 'end_date', v_period_end,
            'days', v_days, 'unit_price', v_rate.daily_price, 'amount', v_rate.daily_price * v_days, 'is_manual', false,
            'rate_snapshot', jsonb_build_object('rate_id', v_rate.id, 'season', v_rate.season, 'year', v_rate.year,
                             'month', v_rate.month, 'half', v_rate.half, 'daily_price', v_rate.daily_price,
                             'periodo', (case v_half when 1 then '1ª' else '2ª' end) || ' quincena de '
                                        || v_month_names[v_rate.month] || ' ' || v_rate.year));
          v_base := v_base + v_rate.daily_price * v_days;
        end if;
        v_d := v_period_end + 1;
      end loop;
    end loop;
  end if;

  v_cur := v_base;
  if not v_courtesy then
    -- 2. Paquete por cantidad de días
    select percent into v_pct from public.package_discounts
    where workspace_id = p_workspace_id and active and min_days <= v_total_days
    order by min_days desc limit 1;
    if found and v_cur > 0 then
      v_amt := floor(v_cur * v_pct / 100);
      v_discounts := v_discounts || jsonb_build_object('kind', 'paquete', 'percent', v_pct, 'amount', v_amt,
                       'label', format('Paquete %s días (%s%%)', v_total_days, to_char(v_pct, 'FM990D##')));
      v_cur := v_cur - v_amt;
    end if;

    -- 3. Convenio
    if (v_opts ->> 'agreement_id') is not null then
      select * into v_agreement from public.agreements
      where id = (v_opts ->> 'agreement_id')::uuid and workspace_id = p_workspace_id;
      if not found or not v_agreement.active
         or (v_agreement.valid_from is not null and p_start < v_agreement.valid_from)
         or (v_agreement.valid_to is not null and p_start > v_agreement.valid_to) then
        raise exception 'El convenio elegido no está vigente para esas fechas.';
      end if;
      v_amt := floor(v_cur * v_agreement.percent / 100);
      v_discounts := v_discounts || jsonb_build_object('kind', 'convenio', 'agreement_id', v_agreement.id,
                       'percent', v_agreement.percent, 'amount', v_amt);
      v_cur := v_cur - v_amt;
    end if;

    -- 4. Pago en efectivo
    if coalesce((v_opts ->> 'cash')::boolean, false) and v_ws.cash_discount_percent > 0 then
      v_amt := floor(v_cur * v_ws.cash_discount_percent / 100);
      v_discounts := v_discounts || jsonb_build_object('kind', 'efectivo', 'percent', v_ws.cash_discount_percent, 'amount', v_amt);
      v_cur := v_cur - v_amt;
    end if;

    -- 5. Descuento manual
    if v_manual is not null and coalesce((v_manual ->> 'value')::numeric, 0) > 0 then
      if char_length(btrim(coalesce(v_manual ->> 'reason', ''))) < 3 then
        raise exception 'Los descuentos manuales necesitan un motivo.';
      end if;
      if v_manual ->> 'type' = 'porcentaje' then
        v_pct := (v_manual ->> 'value')::numeric;
        if v_pct > 100 then
          raise exception 'El porcentaje no puede superar 100.';
        end if;
        v_amt := floor(v_cur * v_pct / 100);
      else
        v_pct := null;
        v_amt := least(floor((v_manual ->> 'value')::numeric), v_cur);
      end if;
      v_discounts := v_discounts || jsonb_build_object('kind', 'manual', 'percent', v_pct, 'amount', v_amt,
                       'reason', btrim(v_manual ->> 'reason'));
      v_cur := v_cur - v_amt;
    end if;
  end if;

  return jsonb_build_object(
    'ok', jsonb_array_length(v_missing) = 0,
    'faltan_tarifas', v_missing,
    'charges', v_charges,
    'dias', v_total_days,
    'precio_base', v_base,
    'discounts', v_discounts,
    'cortesia', v_courtesy,
    'total', case when v_courtesy then 0 else v_cur end
  );
end $$;

create or replace function private.record_payment(
  p_workspace_id uuid, p_reservation_id uuid, p_kind text, p_amount numeric, p_method text,
  p_idempotency_key uuid, p_note text, p_reason text, p_voids_payment_id uuid default null,
  p_usd numeric default null, p_rate numeric default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.payments%rowtype;
  v_res public.reservations%rowtype;
  v_orig public.payments%rowtype;
  v_session uuid;
  v_paid numeric(14,2);
  v_signed numeric(14,2);
  v_amount numeric(14,2) := round(p_amount, 2);
  v_id uuid;
  v_category text;
  v_concept text;
  v_usd numeric(14,2);
  v_rate numeric(14,4);
  v_code text;
begin
  -- Dólares: monto en dólares y cotización. Desde Nueva reserva llegan por la sesión (ver create_reservation_v2).
  if p_method = 'dolares' then
    v_usd := round(coalesce(p_usd, nullif(current_setting('app.pay_usd', true), '')::numeric), 2);
    v_rate := round(coalesce(p_rate, nullif(current_setting('app.pay_rate', true), '')::numeric), 4);
    if v_usd is null or v_usd <= 0 or v_rate is null or v_rate <= 0 then
      raise exception 'Para cobrar en dólares indicá el monto en dólares y la cotización.';
    end if;
    v_amount := round(v_usd * v_rate, 2);
  end if;

  if p_idempotency_key is null then
    raise exception 'Falta la clave de operación.';
  end if;

  select * into v_existing from public.payments
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.reservation_id <> p_reservation_id or v_existing.kind <> p_kind
       or (p_kind <> 'anulacion' and (v_existing.amount <> v_amount or v_existing.method <> p_method)) then
      raise exception 'Esta operación ya fue registrada con otros datos.';
    end if;
    return v_existing.id;
  end if;

  v_session := private.today_session(p_workspace_id);

  -- Bloquea la reserva: dos pagos simultáneos se procesan de a uno.
  select * into v_res from public.reservations
  where id = p_reservation_id and workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'La reserva no existe.';
  end if;

  -- Reintento simultáneo con la misma clave: el otro ya terminó.
  select * into v_existing from public.payments
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return v_existing.id;
  end if;

  select coalesce(sum(signed_amount), 0) into v_paid from public.payments where reservation_id = p_reservation_id;

  if p_kind = 'cobro' then
    if v_res.status = 'cancelada' then
      raise exception 'No se pueden registrar cobros en una reserva cancelada.';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'El importe debe ser mayor a cero.';
    end if;
    if v_amount > v_res.total_amount - v_paid then
      raise exception 'El cobro (%) supera el saldo pendiente (%).',
        private.ars(v_amount), private.ars(greatest(v_res.total_amount - v_paid, 0));
    end if;
    if p_method = 'voucher' then
      raise exception 'El voucher del restaurante solo se usa para devoluciones.';
    end if;
    if p_method = 'dolares' and v_amount > v_res.total_amount - v_paid and v_amount - (v_res.total_amount - v_paid) < greatest(1, v_rate * 0.01) then
      v_amount := v_res.total_amount - v_paid;  -- "todo el saldo": diferencia menor a un centavo de dólar
    end if;
    v_signed := v_amount;
    v_category := 'cobro';
    v_concept := format('Cobro reserva #%s', v_res.number);

  elsif p_kind = 'devolucion' then
    if p_method not in ('efectivo', 'voucher') then
      raise exception 'Las devoluciones se hacen en efectivo o con un voucher para el restaurante.';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'El importe debe ser mayor a cero.';
    end if;
    if v_amount > v_paid then
      raise exception 'La devolución supera lo cobrado en la reserva.';
    end if;
    v_signed := -v_amount;
    v_category := 'devolucion';
    v_concept := format('Devolución reserva #%s', v_res.number);

  elsif p_kind = 'anulacion' then
    select * into v_orig from public.payments
    where id = p_voids_payment_id and reservation_id = p_reservation_id;
    if not found then
      raise exception 'El pago a anular no existe en esta reserva.';
    end if;
    if v_orig.kind = 'anulacion' then
      raise exception 'Una anulación no se puede anular.';
    end if;
    if exists (select 1 from public.payments where voids_payment_id = v_orig.id) then
      raise exception 'Ese pago ya fue anulado.';
    end if;
    if v_orig.method = 'voucher' and exists (select 1 from public.restaurant_vouchers
                                              where payment_id = v_orig.id and status = 'usado') then
      raise exception 'Ese voucher ya se usó en el restaurante; no se puede anular.';
    end if;
    v_amount := v_orig.amount;
    p_method := v_orig.method;
    v_usd := v_orig.usd_amount;
    v_rate := v_orig.exchange_rate;
    v_signed := -v_orig.signed_amount;
    v_category := case v_orig.kind when 'cobro' then 'anulacion_cobro' else 'anulacion_devolucion' end;
    v_concept := format('Anulación de %s · reserva #%s', v_orig.kind, v_res.number);
  else
    raise exception 'Tipo de pago inválido.';
  end if;

  if p_method is null or not private.valid_payment_method(p_method) then
    raise exception 'Medio de pago inválido.';
  end if;

  insert into public.payments (workspace_id, reservation_id, kind, amount, signed_amount, method,
                               voids_payment_id, cash_session_id, idempotency_key, note, reason, usd_amount, exchange_rate)
  values (p_workspace_id, p_reservation_id, p_kind, v_amount, v_signed, p_method,
          p_voids_payment_id, v_session, p_idempotency_key, nullif(btrim(p_note), ''), nullif(btrim(p_reason), ''),
          case when p_method = 'dolares' then v_usd end, case when p_method = 'dolares' then v_rate end)
  returning id into v_id;

  if p_method = 'voucher' then
    -- El voucher no es dinero de la caja: no genera movimiento de caja.
    if p_kind = 'devolucion' then
      loop
        v_code := 'V-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
        exit when not exists (select 1 from public.restaurant_vouchers where workspace_id = p_workspace_id and code = v_code);
      end loop;
      insert into public.restaurant_vouchers (workspace_id, code, payment_id, reservation_id, customer_id, amount)
      values (p_workspace_id, v_code, v_id, p_reservation_id, v_res.customer_id, v_amount);
    else
      update public.restaurant_vouchers set status = 'anulado', version = version + 1 where payment_id = p_voids_payment_id;
    end if;
  else
    insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, payment_id, usd_amount)
    values (p_workspace_id, v_session, case when v_signed > 0 then 'entrada' else 'salida' end,
            p_method, v_amount, v_category,
            v_concept || case when p_method = 'dolares' then format(' · US$ %s a $ %s', v_usd, v_rate) else '' end,
            v_id, case when p_method = 'dolares' then v_usd end);
  end if;

  return v_id;
end $$;

revoke all on function private.record_payment(uuid, uuid, text, numeric, text, uuid, text, text, uuid, numeric, numeric) from public, anon, authenticated;

-- Textos ya guardados: "$18,000" pasa a "$ 18.000" (no cambia ningún importe).
alter table public.reservation_charges disable trigger reservation_charges_immutable;
do $$
declare i int;
begin
  for i in 1..4 loop
    update public.reservation_charges
       set description = regexp_replace(description, '(\$ ?\d{1,3}(\.\d{3})*),(\d{3})(?!\d)', '\1.\3', 'g')
     where description ~ '\$ ?\d{1,3}(\.\d{3})*,\d{3}(?!\d)';
  end loop;
  update public.reservation_charges set description = regexp_replace(description, '\$(\d)', '$ \1', 'g') where description ~ '\$\d';
end $$;
alter table public.reservation_charges enable trigger reservation_charges_immutable;

-- =====================================================================
-- 0032 · Convenios que se pueden eliminar y forma de combinar los descuentos.
--   · Eliminar un convenio: deja de aparecer y de ofrecerse; las reservas que ya lo
--     usaron conservan su descuento tal cual (no se borra historia).
--   · Cada balneario elige cómo se combinan los descuentos automáticos
--     (paquete por días, convenio y pago en efectivo):
--       cascada  → cada uno sobre lo que queda (como funcionaba hasta ahora)
--       sumados  → cada uno sobre el precio base, y se suman
--       mayor    → no acumulables: se aplica solo el de mayor porcentaje
--     El descuento manual (con motivo, de un administrador) se aplica siempre, al final.
--   · Las reservas ya hechas no cambian: guardan sus descuentos.
-- =====================================================================

alter table public.agreements add column if not exists deleted_at timestamptz;
drop index if exists public.agreements_name_unique;
create unique index agreements_name_unique on public.agreements(workspace_id, lower(btrim(name))) where deleted_at is null;

create or replace function public.delete_agreement(p_agreement_id uuid, p_expected_version integer) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.agreements%rowtype;
begin
  select * into a from public.agreements where id = p_agreement_id for update;
  if not found or a.deleted_at is not null then raise exception 'El convenio no existe.'; end if;
  perform private.require_member(a.workspace_id, array['propietario','administrador']);
  update public.agreements set active = false, deleted_at = now(), version = p_expected_version + 1
   where id = p_agreement_id;
end $$;
revoke all on function public.delete_agreement(uuid, integer) from public, anon;
grant execute on function public.delete_agreement(uuid, integer) to authenticated;

-- Un convenio eliminado no se puede volver a activar ni editar.
create or replace function private.agreements_deleted_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.deleted_at is not null and not coalesce(private.purging(old.workspace_id::text) or private.restoring(old.workspace_id::text), false) then
    raise exception 'Ese convenio fue eliminado.';
  end if;
  return new;
end $$;
drop trigger if exists agreements_deleted_guard on public.agreements;
create trigger agreements_deleted_guard before update on public.agreements
  for each row execute function private.agreements_deleted_guard();

alter table public.workspaces add column if not exists discount_mode text not null default 'cascada'
  check (discount_mode in ('cascada','sumados','mayor'));
grant update (discount_mode) on public.workspaces to authenticated;

create or replace function private.compute_quote(
  p_workspace_id uuid, p_start date, p_end date, p_segments jsonb, p_options jsonb
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_opts jsonb := coalesce(p_options, '{}'::jsonb);
  v_seg jsonb;
  v_space public.spaces%rowtype;
  v_d date;
  v_period_end date;
  v_half smallint;
  v_price numeric(14,2);
  v_rate public.rates%rowtype;
  v_days integer;
  v_charges jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_discounts jsonb := '[]'::jsonb;
  v_base numeric(14,2) := 0;
  v_cur numeric(14,2);
  v_amt numeric(14,2);
  v_pct numeric(5,2);
  v_total_days integer := p_end - p_start + 1;
  v_agreement public.agreements%rowtype;
  v_ws public.workspaces%rowtype;
  v_manual jsonb := v_opts -> 'manual';
  v_courtesy boolean := coalesce((v_opts ->> 'courtesy')::boolean, false);
  v_mode text;
  v_cands jsonb := '[]'::jsonb;
  v_best jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_c jsonb;
  v_month_names text[] := array['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
begin
  select * into v_ws from public.workspaces where id = p_workspace_id;
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'Revisá las fechas: la salida no puede ser anterior a la entrada.';
  end if;

  if v_opts ? 'manual_base' and (v_opts ->> 'manual_base') is not null then
    -- Precio manual acordado (solo administradores)
    if not private.has_role(p_workspace_id, array['propietario','administrador']) then
      raise exception 'Solo un administrador puede fijar un precio manual.' using errcode = '42501';
    end if;
    v_base := floor((v_opts ->> 'manual_base')::numeric);
    if v_base < 0 then
      raise exception 'El precio manual no puede ser negativo.';
    end if;
    v_charges := jsonb_build_array(jsonb_build_object(
      'description', 'Precio manual acordado', 'start_date', p_start, 'end_date', p_end,
      'days', v_total_days, 'amount', v_base, 'is_manual', true));
  else
    for v_seg in select * from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) order by (value ->> 'start_date') loop
      select * into v_space from public.spaces where id = (v_seg ->> 'space_id')::uuid and workspace_id = p_workspace_id;
      if not found then
        raise exception 'Uno de los espacios elegidos no existe.';
      end if;
      v_d := (v_seg ->> 'start_date')::date;
      while v_d <= (v_seg ->> 'end_date')::date loop
        v_half := case when extract(day from v_d) <= 15 then 1 else 2 end;
        v_period_end := least((v_seg ->> 'end_date')::date,
          case when v_half = 1 then make_date(extract(year from v_d)::int, extract(month from v_d)::int, 15)
               else (date_trunc('month', v_d) + interval '1 month - 1 day')::date end);
        v_days := v_period_end - v_d + 1;
        select * into v_rate from public.rates
        where workspace_id = p_workspace_id and space_kind = v_space.kind
          and year = extract(year from v_d)::int and month = extract(month from v_d)::int and half = v_half;
        if not found then
          v_missing := v_missing || jsonb_build_object('space_kind', v_space.kind, 'year', extract(year from v_d)::int,
                         'month', extract(month from v_d)::int, 'half', v_half);
        else
          v_charges := v_charges || jsonb_build_object(
            'description', format('%s · %s al %s · %s %s × %s', private.space_label(v_space.kind, v_space.code),
                                  to_char(v_d, 'DD/MM'), to_char(v_period_end, 'DD/MM'), v_days,
                                  case when v_days = 1 then 'día' else 'días' end,
                                  private.ars(v_rate.daily_price)),
            'space_id', v_space.id, 'space_kind', v_space.kind, 'start_date', v_d, 'end_date', v_period_end,
            'days', v_days, 'unit_price', v_rate.daily_price, 'amount', v_rate.daily_price * v_days, 'is_manual', false,
            'rate_snapshot', jsonb_build_object('rate_id', v_rate.id, 'season', v_rate.season, 'year', v_rate.year,
                             'month', v_rate.month, 'half', v_rate.half, 'daily_price', v_rate.daily_price,
                             'periodo', (case v_half when 1 then '1ª' else '2ª' end) || ' quincena de '
                                        || v_month_names[v_rate.month] || ' ' || v_rate.year));
          v_base := v_base + v_rate.daily_price * v_days;
        end if;
        v_d := v_period_end + 1;
      end loop;
    end loop;
  end if;

  v_cur := v_base;
  v_mode := coalesce(v_ws.discount_mode, 'cascada');
  if not v_courtesy then
    -- Descuentos automáticos que corresponden (paquete, convenio, efectivo), en este orden.
    -- 2. Paquete por cantidad de días
    select percent into v_pct from public.package_discounts
    where workspace_id = p_workspace_id and active and min_days <= v_total_days
    order by min_days desc limit 1;
    if found and v_base > 0 then
      v_cands := v_cands || jsonb_build_object('kind', 'paquete', 'percent', v_pct,
                   'label', format('Paquete %s días (%s%%)', v_total_days, to_char(v_pct, 'FM990D##')));
    end if;

    -- 3. Convenio
    if (v_opts ->> 'agreement_id') is not null then
      select * into v_agreement from public.agreements
      where id = (v_opts ->> 'agreement_id')::uuid and workspace_id = p_workspace_id;
      if not found or not v_agreement.active or v_agreement.deleted_at is not null
         or (v_agreement.valid_from is not null and p_start < v_agreement.valid_from)
         or (v_agreement.valid_to is not null and p_start > v_agreement.valid_to) then
        raise exception 'El convenio elegido no está vigente para esas fechas.';
      end if;
      v_cands := v_cands || jsonb_build_object('kind', 'convenio', 'agreement_id', v_agreement.id, 'percent', v_agreement.percent,
                   'label', 'Convenio ' || v_agreement.name);
    end if;

    -- 4. Pago en efectivo
    if coalesce((v_opts ->> 'cash')::boolean, false) and v_ws.cash_discount_percent > 0 then
      v_cands := v_cands || jsonb_build_object('kind', 'efectivo', 'percent', v_ws.cash_discount_percent, 'label', 'Pago en efectivo');
    end if;

    -- Cómo se combinan (lo decide cada balneario en Convenios y descuentos):
    --   cascada: cada uno sobre lo que queda · sumados: cada uno sobre el precio base ·
    --   mayor: no acumulables, se aplica solo el de mayor porcentaje.
    if v_mode = 'mayor' and jsonb_array_length(v_cands) > 1 then
      select c into v_best from jsonb_array_elements(v_cands) with ordinality as t(c, n)
      order by (c ->> 'percent')::numeric desc, n limit 1;
      select coalesce(jsonb_agg(c), '[]'::jsonb) into v_skipped from jsonb_array_elements(v_cands) with ordinality as t(c, n)
      where c is distinct from v_best;
      v_cands := jsonb_build_array(v_best);
    end if;
    for v_c in select * from jsonb_array_elements(v_cands) loop
      v_pct := (v_c ->> 'percent')::numeric;
      v_amt := least(floor((case when v_mode = 'sumados' then v_base else v_cur end) * v_pct / 100), v_cur);
      v_discounts := v_discounts || (v_c - 'label' || jsonb_build_object('amount', v_amt)
                     || case when v_c ->> 'kind' = 'paquete' then jsonb_build_object('label', v_c ->> 'label') else '{}'::jsonb end);
      v_cur := v_cur - v_amt;
    end loop;

    -- 5. Descuento manual (decisión del administrador: se aplica siempre, al final)
    if v_manual is not null and coalesce((v_manual ->> 'value')::numeric, 0) > 0 then
      if char_length(btrim(coalesce(v_manual ->> 'reason', ''))) < 3 then
        raise exception 'Los descuentos manuales necesitan un motivo.';
      end if;
      if v_manual ->> 'type' = 'porcentaje' then
        v_pct := (v_manual ->> 'value')::numeric;
        if v_pct > 100 then
          raise exception 'El porcentaje no puede superar 100.';
        end if;
        v_amt := least(floor((case when v_mode = 'sumados' then v_base else v_cur end) * v_pct / 100), v_cur);
      else
        v_pct := null;
        v_amt := least(floor((v_manual ->> 'value')::numeric), v_cur);
      end if;
      v_discounts := v_discounts || jsonb_build_object('kind', 'manual', 'percent', v_pct, 'amount', v_amt,
                       'reason', btrim(v_manual ->> 'reason'));
      v_cur := v_cur - v_amt;
    end if;
  end if;

  return jsonb_build_object(
    'ok', jsonb_array_length(v_missing) = 0,
    'faltan_tarifas', v_missing,
    'charges', v_charges,
    'dias', v_total_days,
    'precio_base', v_base,
    'discounts', v_discounts,
    'cortesia', v_courtesy,
    'total', case when v_courtesy then 0 else v_cur end,
    'modo_descuentos', v_mode,
    'no_aplicados', v_skipped
  );
end $$;

-- =====================================================================
-- 0033 · Plano más grande, tope de descuento y límite de efectivo en caja.
--   · Agrandar (o achicar) el plano del balneario sin perder la ubicación de nada:
--     lo que está cerca del mar queda cerca del mar; el lugar nuevo se suma del lado de tierra.
--   · Tope de descuento (% del precio base) configurable por balneario.
--   · Límite de efectivo en caja: por encima, se avisa que conviene hacer un depósito.
--     El depósito se registra como salida de efectivo (no es un gasto) y se puede anular.
-- =====================================================================

alter table public.workspaces add column if not exists discount_cap_percent numeric(5,2)
  check (discount_cap_percent is null or (discount_cap_percent > 0 and discount_cap_percent <= 100));
alter table public.workspaces add column if not exists cash_limit numeric(14,2) check (cash_limit is null or cash_limit > 0);
grant update (discount_cap_percent, cash_limit) on public.workspaces to authenticated;

-- ---------------------------------------------------------------------
-- Depósitos de efectivo (sacar plata de la caja para llevarla al banco)
-- ---------------------------------------------------------------------
alter table public.cash_movements add column if not exists voids_movement_id uuid unique references public.cash_movements(id);
alter table public.cash_movements drop constraint if exists cash_movements_category_check;
alter table public.cash_movements add constraint cash_movements_category_check check (category in (
  'cobro','devolucion','anulacion_cobro','anulacion_devolucion','gasto','anulacion_gasto','otro_ingreso','deposito','anulacion_deposito'));
alter table public.cash_movements add constraint cash_movements_deposito_check check (
  category not in ('deposito','anulacion_deposito') or (method = 'efectivo' and idempotency_key is not null));
alter table public.cash_movements add constraint cash_movements_anulacion_deposito_check check (
  (category = 'anulacion_deposito') = (voids_movement_id is not null));

create or replace function public.register_cash_deposit(p_workspace_id uuid, p_idempotency_key uuid, p_amount numeric, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing uuid;
  v_session uuid;
  v_open numeric;
  v_cash numeric;
  v_id uuid;
begin
  perform private.require_member(p_workspace_id);
  if p_idempotency_key is null then raise exception 'Falta la clave de operación.'; end if;
  select id into v_existing from public.cash_movements where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('movement_id', v_existing, 'repetida', true); end if;
  if p_amount is null or p_amount <= 0 then raise exception 'El importe debe ser mayor a cero.'; end if;
  v_session := private.today_session(p_workspace_id);
  perform 1 from public.cash_sessions where id = v_session for update;
  select opening_cash into v_open from public.cash_sessions where id = v_session;
  select v_open + coalesce(sum(case when direction = 'entrada' then amount else -amount end), 0) into v_cash
  from public.cash_movements where cash_session_id = v_session and method = 'efectivo';
  if round(p_amount, 2) > v_cash then
    raise exception 'El depósito (%) supera el efectivo que tiene que haber en la caja (%).', private.ars(p_amount), private.ars(v_cash);
  end if;
  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, idempotency_key)
  values (p_workspace_id, v_session, 'salida', 'efectivo', round(p_amount, 2), 'deposito',
          left('Depósito de efectivo' || coalesce(' · ' || nullif(btrim(p_note), ''), ''), 200), p_idempotency_key)
  returning id into v_id;
  return jsonb_build_object('movement_id', v_id, 'repetida', false);
end $$;

create or replace function public.void_cash_deposit(p_movement_id uuid, p_idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.cash_movements%rowtype;
  v_session uuid;
  v_id uuid;
begin
  select * into m from public.cash_movements where id = p_movement_id;
  if not found or m.category <> 'deposito' then raise exception 'El depósito no existe.'; end if;
  perform private.require_member(m.workspace_id, array['propietario','administrador']);
  select id into v_id from public.cash_movements where voids_movement_id = m.id;
  if found then raise exception 'Ese depósito ya fue anulado.'; end if;
  v_session := private.today_session(m.workspace_id);
  if v_session <> m.cash_session_id then raise exception 'Solo se puede anular un depósito de la caja de hoy.'; end if;
  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, idempotency_key, voids_movement_id)
  values (m.workspace_id, v_session, 'entrada', 'efectivo', m.amount, 'anulacion_deposito', 'Anulación de depósito de efectivo', p_idempotency_key, m.id)
  returning id into v_id;
  return jsonb_build_object('movement_id', v_id);
end $$;

revoke all on function public.register_cash_deposit(uuid, uuid, numeric, text), public.void_cash_deposit(uuid, uuid) from public, anon;
grant execute on function public.register_cash_deposit(uuid, uuid, numeric, text), public.void_cash_deposit(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Agrandar o achicar el plano
-- ---------------------------------------------------------------------
create or replace function public.resize_map(p_workspace_id uuid, p_width integer, p_height integer, p_expected_version integer) returns jsonb
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
  -- El lado del mar queda fijo: lo nuevo se agrega del lado de tierra (y a lo ancho, repartido a los costados).
  dx := case w.sea_side when 'left' then 0 when 'right' then p_width - w.map_width else round((p_width - w.map_width) / 2.0) end;
  dy := case w.sea_side when 'top' then 0 when 'bottom' then p_height - w.map_height else round((p_height - w.map_height) / 2.0) end;
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
revoke all on function public.resize_map(uuid, integer, integer, integer) from public, anon;
grant execute on function public.resize_map(uuid, integer, integer, integer) to authenticated;

create or replace function private.compute_quote(
  p_workspace_id uuid, p_start date, p_end date, p_segments jsonb, p_options jsonb
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_opts jsonb := coalesce(p_options, '{}'::jsonb);
  v_seg jsonb;
  v_space public.spaces%rowtype;
  v_d date;
  v_period_end date;
  v_half smallint;
  v_price numeric(14,2);
  v_rate public.rates%rowtype;
  v_days integer;
  v_charges jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_discounts jsonb := '[]'::jsonb;
  v_base numeric(14,2) := 0;
  v_cur numeric(14,2);
  v_amt numeric(14,2);
  v_pct numeric(5,2);
  v_total_days integer := p_end - p_start + 1;
  v_agreement public.agreements%rowtype;
  v_ws public.workspaces%rowtype;
  v_manual jsonb := v_opts -> 'manual';
  v_courtesy boolean := coalesce((v_opts ->> 'courtesy')::boolean, false);
  v_mode text;
  v_cap numeric(14,2);
  v_excess numeric(14,2);
  v_new jsonb;
  v_i integer;
  v_capped boolean := false;
  v_cands jsonb := '[]'::jsonb;
  v_best jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_c jsonb;
  v_month_names text[] := array['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
begin
  select * into v_ws from public.workspaces where id = p_workspace_id;
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'Revisá las fechas: la salida no puede ser anterior a la entrada.';
  end if;

  if v_opts ? 'manual_base' and (v_opts ->> 'manual_base') is not null then
    -- Precio manual acordado (solo administradores)
    if not private.has_role(p_workspace_id, array['propietario','administrador']) then
      raise exception 'Solo un administrador puede fijar un precio manual.' using errcode = '42501';
    end if;
    v_base := floor((v_opts ->> 'manual_base')::numeric);
    if v_base < 0 then
      raise exception 'El precio manual no puede ser negativo.';
    end if;
    v_charges := jsonb_build_array(jsonb_build_object(
      'description', 'Precio manual acordado', 'start_date', p_start, 'end_date', p_end,
      'days', v_total_days, 'amount', v_base, 'is_manual', true));
  else
    for v_seg in select * from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) order by (value ->> 'start_date') loop
      select * into v_space from public.spaces where id = (v_seg ->> 'space_id')::uuid and workspace_id = p_workspace_id;
      if not found then
        raise exception 'Uno de los espacios elegidos no existe.';
      end if;
      v_d := (v_seg ->> 'start_date')::date;
      while v_d <= (v_seg ->> 'end_date')::date loop
        v_half := case when extract(day from v_d) <= 15 then 1 else 2 end;
        v_period_end := least((v_seg ->> 'end_date')::date,
          case when v_half = 1 then make_date(extract(year from v_d)::int, extract(month from v_d)::int, 15)
               else (date_trunc('month', v_d) + interval '1 month - 1 day')::date end);
        v_days := v_period_end - v_d + 1;
        select * into v_rate from public.rates
        where workspace_id = p_workspace_id and space_kind = v_space.kind
          and year = extract(year from v_d)::int and month = extract(month from v_d)::int and half = v_half;
        if not found then
          v_missing := v_missing || jsonb_build_object('space_kind', v_space.kind, 'year', extract(year from v_d)::int,
                         'month', extract(month from v_d)::int, 'half', v_half);
        else
          v_charges := v_charges || jsonb_build_object(
            'description', format('%s · %s al %s · %s %s × %s', private.space_label(v_space.kind, v_space.code),
                                  to_char(v_d, 'DD/MM'), to_char(v_period_end, 'DD/MM'), v_days,
                                  case when v_days = 1 then 'día' else 'días' end,
                                  private.ars(v_rate.daily_price)),
            'space_id', v_space.id, 'space_kind', v_space.kind, 'start_date', v_d, 'end_date', v_period_end,
            'days', v_days, 'unit_price', v_rate.daily_price, 'amount', v_rate.daily_price * v_days, 'is_manual', false,
            'rate_snapshot', jsonb_build_object('rate_id', v_rate.id, 'season', v_rate.season, 'year', v_rate.year,
                             'month', v_rate.month, 'half', v_rate.half, 'daily_price', v_rate.daily_price,
                             'periodo', (case v_half when 1 then '1ª' else '2ª' end) || ' quincena de '
                                        || v_month_names[v_rate.month] || ' ' || v_rate.year));
          v_base := v_base + v_rate.daily_price * v_days;
        end if;
        v_d := v_period_end + 1;
      end loop;
    end loop;
  end if;

  v_cur := v_base;
  v_mode := coalesce(v_ws.discount_mode, 'cascada');
  if not v_courtesy then
    -- Descuentos automáticos que corresponden (paquete, convenio, efectivo), en este orden.
    -- 2. Paquete por cantidad de días
    select percent into v_pct from public.package_discounts
    where workspace_id = p_workspace_id and active and min_days <= v_total_days
    order by min_days desc limit 1;
    if found and v_base > 0 then
      v_cands := v_cands || jsonb_build_object('kind', 'paquete', 'percent', v_pct,
                   'label', format('Paquete %s días (%s%%)', v_total_days, to_char(v_pct, 'FM990D##')));
    end if;

    -- 3. Convenio
    if (v_opts ->> 'agreement_id') is not null then
      select * into v_agreement from public.agreements
      where id = (v_opts ->> 'agreement_id')::uuid and workspace_id = p_workspace_id;
      if not found or not v_agreement.active or v_agreement.deleted_at is not null
         or (v_agreement.valid_from is not null and p_start < v_agreement.valid_from)
         or (v_agreement.valid_to is not null and p_start > v_agreement.valid_to) then
        raise exception 'El convenio elegido no está vigente para esas fechas.';
      end if;
      v_cands := v_cands || jsonb_build_object('kind', 'convenio', 'agreement_id', v_agreement.id, 'percent', v_agreement.percent,
                   'label', 'Convenio ' || v_agreement.name);
    end if;

    -- 4. Pago en efectivo
    if coalesce((v_opts ->> 'cash')::boolean, false) and v_ws.cash_discount_percent > 0 then
      v_cands := v_cands || jsonb_build_object('kind', 'efectivo', 'percent', v_ws.cash_discount_percent, 'label', 'Pago en efectivo');
    end if;

    -- Cómo se combinan (lo decide cada balneario en Convenios y descuentos):
    --   cascada: cada uno sobre lo que queda · sumados: cada uno sobre el precio base ·
    --   mayor: no acumulables, se aplica solo el de mayor porcentaje.
    if v_mode = 'mayor' and jsonb_array_length(v_cands) > 1 then
      select c into v_best from jsonb_array_elements(v_cands) with ordinality as t(c, n)
      order by (c ->> 'percent')::numeric desc, n limit 1;
      select coalesce(jsonb_agg(c), '[]'::jsonb) into v_skipped from jsonb_array_elements(v_cands) with ordinality as t(c, n)
      where c is distinct from v_best;
      v_cands := jsonb_build_array(v_best);
    end if;
    for v_c in select * from jsonb_array_elements(v_cands) loop
      v_pct := (v_c ->> 'percent')::numeric;
      v_amt := least(floor((case when v_mode = 'sumados' then v_base else v_cur end) * v_pct / 100), v_cur);
      v_discounts := v_discounts || (v_c - 'label' || jsonb_build_object('amount', v_amt)
                     || case when v_c ->> 'kind' = 'paquete' then jsonb_build_object('label', v_c ->> 'label') else '{}'::jsonb end);
      v_cur := v_cur - v_amt;
    end loop;

    -- 5. Descuento manual (decisión del administrador: se aplica siempre, al final)
    if v_manual is not null and coalesce((v_manual ->> 'value')::numeric, 0) > 0 then
      if char_length(btrim(coalesce(v_manual ->> 'reason', ''))) < 3 then
        raise exception 'Los descuentos manuales necesitan un motivo.';
      end if;
      if v_manual ->> 'type' = 'porcentaje' then
        v_pct := (v_manual ->> 'value')::numeric;
        if v_pct > 100 then
          raise exception 'El porcentaje no puede superar 100.';
        end if;
        v_amt := least(floor((case when v_mode = 'sumados' then v_base else v_cur end) * v_pct / 100), v_cur);
      else
        v_pct := null;
        v_amt := least(floor((v_manual ->> 'value')::numeric), v_cur);
      end if;
      v_discounts := v_discounts || jsonb_build_object('kind', 'manual', 'percent', v_pct, 'amount', v_amt,
                       'reason', btrim(v_manual ->> 'reason'));
      v_cur := v_cur - v_amt;
    end if;
  end if;

  -- Tope de descuento del balneario: el total de descuentos no pasa de ese % del precio base.
  -- Si se pasa, se recorta desde el último descuento hacia atrás (primero el manual).
  if not v_courtesy and v_ws.discount_cap_percent is not null and v_base > 0 then
    v_cap := floor(v_base * v_ws.discount_cap_percent / 100);
    v_excess := (v_base - v_cur) - v_cap;
    if v_excess > 0 then
      v_new := '[]'::jsonb;
      for v_i in reverse jsonb_array_length(v_discounts) - 1 .. 0 loop
        v_c := v_discounts -> v_i;
        v_amt := least((v_c ->> 'amount')::numeric, v_excess);
        v_excess := v_excess - v_amt;
        v_c := jsonb_set(v_c, '{amount}', to_jsonb((v_c ->> 'amount')::numeric - v_amt));
        if (v_c ->> 'amount')::numeric > 0 then
          v_new := jsonb_build_array(v_c) || v_new;
        end if;
      end loop;
      v_discounts := v_new;
      v_cur := v_base - v_cap;
      v_capped := true;
    end if;
  end if;

  return jsonb_build_object(
    'ok', jsonb_array_length(v_missing) = 0,
    'faltan_tarifas', v_missing,
    'charges', v_charges,
    'dias', v_total_days,
    'precio_base', v_base,
    'discounts', v_discounts,
    'cortesia', v_courtesy,
    'total', case when v_courtesy then 0 else v_cur end,
    'modo_descuentos', v_mode,
    'no_aplicados', v_skipped,
    'tope', v_ws.discount_cap_percent,
    'tope_aplicado', v_capped
  );
end $$;

-- =====================================================================
-- 0034 · Número de reserva correlativo por balneario y mensajes con más datos.
--   · Cada balneario numera sus reservas desde 1, sin saltos (antes el número era
--     compartido entre todos los balnearios y las demos, y quedaban huecos).
--     Las reservas existentes se renumeran en el orden en que se crearon, y los
--     textos de la caja que las nombran ("Cobro reserva #…") se actualizan igual.
--   · Mensajes: se suman el asunto y el texto del correo al cliente.
-- =====================================================================

create table if not exists private.reservation_counters (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  last_number  bigint not null default 0
);
alter table private.reservation_counters enable row level security;
revoke all on private.reservation_counters from public, anon, authenticated;

-- El número deja de ser global.
alter table public.reservations alter column number drop identity if exists;

-- Renumerar lo que ya existe (por balneario, en orden de creación).
create temporary table _renum as
  select id, workspace_id, number as old_number,
         row_number() over (partition by workspace_id order by created_at, number) as new_number
  from public.reservations;

alter table public.reservations disable trigger reservations_version;
alter table public.reservations disable trigger reservations_audit;
alter table public.reservations disable trigger reservations_pausa;
update public.reservations r set number = m.new_number
  from _renum m where m.id = r.id and r.number <> m.new_number;
alter table public.reservations enable trigger reservations_version;
alter table public.reservations enable trigger reservations_audit;
alter table public.reservations enable trigger reservations_pausa;

-- Los movimientos de caja nombran la reserva por número: se actualiza solo ese número.
alter table public.cash_movements disable trigger cash_movements_immutable;
alter table public.cash_movements disable trigger cash_movements_guard;
alter table public.cash_movements disable trigger cash_movements_pausa;
update public.cash_movements cm
   set concept = regexp_replace(cm.concept, 'reserva #' || m.old_number || '(?![0-9])', 'reserva #' || m.new_number)
  from public.payments p join _renum m on m.id = p.reservation_id
 where cm.payment_id = p.id and m.old_number <> m.new_number;
alter table public.cash_movements enable trigger cash_movements_immutable;
alter table public.cash_movements enable trigger cash_movements_guard;
alter table public.cash_movements enable trigger cash_movements_pausa;

insert into private.reservation_counters (workspace_id, last_number)
  select workspace_id, max(number) from public.reservations group by workspace_id
on conflict (workspace_id) do update set last_number = excluded.last_number;

drop table _renum;

alter table public.reservations drop constraint if exists reservations_number_unique;
alter table public.reservations add constraint reservations_number_unique unique (workspace_id, number);

-- Número para cada reserva nueva: el siguiente del balneario. Al restaurar una copia
-- (que trae sus números), el contador se pone al día para no repetir.
create or replace function private.assign_reservation_number() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v bigint;
begin
  if new.number is null then
    insert into private.reservation_counters (workspace_id, last_number) values (new.workspace_id, 1)
    on conflict (workspace_id) do update set last_number = private.reservation_counters.last_number + 1
    returning last_number into v;
    new.number := v;
  else
    insert into private.reservation_counters (workspace_id, last_number) values (new.workspace_id, new.number)
    on conflict (workspace_id) do update set last_number = greatest(private.reservation_counters.last_number, excluded.last_number);
  end if;
  return new;
end $$;
drop trigger if exists reservations_number on public.reservations;
create trigger reservations_number before insert on public.reservations
  for each row execute function private.assign_reservation_number();

-- ---------------------------------------------------------------------
-- Mensajes: también el correo al cliente (asunto y texto)
-- ---------------------------------------------------------------------
create or replace function private.valid_message_templates(s jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare k text; v_max integer;
begin
  if s is null then return true; end if;
  if jsonb_typeof(s) <> 'object' then return false; end if;
  for k in select jsonb_object_keys(s) loop
    if k not in ('deuda_hoy', 'deuda_manana', 'deuda_vencida', 'deuda_otros', 'mail_asunto', 'mail_cuerpo') then return false; end if;
    if jsonb_typeof(s -> k) <> 'string' then return false; end if;
    v_max := (case k when 'mail_asunto' then 200 when 'mail_cuerpo' then 3000 else 1000 end);
    if char_length(s ->> k) > v_max then return false; end if;
  end loop;
  return true;
end $$;

-- =====================================================================
-- 0035 · Con qué correo trabaja el balneario (para el botón «Enviar correo»).
--   gmail · outlook (Hotmail/Outlook.com) · office365 (Outlook de empresa) · yahoo ·
--   app (el programa de correo instalado en la compu)
-- =====================================================================
alter table public.workspaces add column if not exists mail_provider text not null default 'gmail'
  check (mail_provider in ('gmail','outlook','office365','yahoo','app'));
grant update (mail_provider) on public.workspaces to authenticated;

-- =====================================================================
-- 0036 · Plano: mover varias cosas juntas y copiar/pegar.
--   · move_map_items: guarda de una sola vez la ubicación nueva de varias
--     carpas, sombrillas y elementos (o se guardan todas, o ninguna).
--   · paste_map_items: duplica carpas, sombrillas y elementos. Las carpas y
--     sombrillas copiadas reciben el número siguiente libre (no se repiten).
-- =====================================================================

create or replace function public.move_map_items(p_workspace_id uuid, p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_ws public.workspaces%rowtype;
  v_it jsonb;
  v_x numeric;
  v_y numeric;
  v_n integer := 0;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'No hay nada para mover.';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'Son demasiadas cosas para mover de una vez.';
  end if;
  select * into v_ws from public.workspaces where id = p_workspace_id;
  for v_it in select * from jsonb_array_elements(p_items) loop
    v_x := round((v_it ->> 'x')::numeric);
    v_y := round((v_it ->> 'y')::numeric);
    if v_x is null or v_y is null or v_x < 0 or v_y < 0 or v_x > v_ws.map_width or v_y > v_ws.map_height then
      raise exception 'Hay cosas que quedarían fuera del plano.';
    end if;
    if v_it ->> 'type' = 'space' then
      update public.spaces set x = v_x, y = v_y, version = version + 1
       where id = (v_it ->> 'id')::uuid and workspace_id = p_workspace_id and version = (v_it ->> 'version')::integer;
    elsif v_it ->> 'type' = 'feature' then
      update public.map_features set x = v_x, y = v_y, version = version + 1
       where id = (v_it ->> 'id')::uuid and workspace_id = p_workspace_id and version = (v_it ->> 'version')::integer;
    else
      raise exception 'Tipo de elemento desconocido.';
    end if;
    if not found then
      raise exception 'Este dato fue modificado desde otro dispositivo. Recargá la pantalla e intentá de nuevo.'
        using errcode = '40001', hint = 'CONFLICTO_VERSION';
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.move_map_items(uuid, jsonb) from public, anon;
grant execute on function public.move_map_items(uuid, jsonb) to authenticated;

-- Número siguiente libre para una copia: "17" → el mayor número + 1; "C17" → "C" + (mayor de las "C…" + 1).
create or replace function private.next_space_code(p_workspace_id uuid, p_code text) returns text
language plpgsql set search_path = '' as $$
declare
  v_prefix text := coalesce(substring(btrim(p_code) from '^(.*?)[0-9]+$'), btrim(p_code) || ' ');
  v_max bigint;
  v_try text;
  v_i integer := 1;
begin
  select max(substring(btrim(code) from char_length(v_prefix) + 1)::bigint) into v_max
    from public.spaces
   where workspace_id = p_workspace_id
     and lower(left(btrim(code), char_length(v_prefix))) = lower(v_prefix)
     and substring(btrim(code) from char_length(v_prefix) + 1) ~ '^[0-9]{1,15}$';
  v_max := coalesce(v_max, 0);
  loop
    v_try := v_prefix || (v_max + v_i)::text;
    exit when char_length(v_try) <= 20 and not exists (
      select 1 from public.spaces where workspace_id = p_workspace_id and lower(btrim(code)) = lower(v_try));
    v_i := v_i + 1;
    if v_i > 100000 or char_length(v_try) > 20 then
      raise exception 'No se pudo numerar la copia de %.', p_code;
    end if;
  end loop;
  return v_try;
end $$;
revoke all on function private.next_space_code(uuid, text) from public, anon, authenticated;

create or replace function public.paste_map_items(p_workspace_id uuid, p_items jsonb, p_dx numeric, p_dy numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ws public.workspaces%rowtype;
  v_it jsonb;
  v_s public.spaces%rowtype;
  v_f public.map_features%rowtype;
  v_x numeric;
  v_y numeric;
  v_id uuid;
  v_out jsonb := '[]'::jsonb;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'No hay nada copiado.';
  end if;
  if jsonb_array_length(p_items) > 300 then
    raise exception 'Se pueden pegar hasta 300 cosas de una vez.';
  end if;
  select * into v_ws from public.workspaces where id = p_workspace_id for update; -- los números de las copias no se pisan
  for v_it in select * from jsonb_array_elements(p_items) loop
    if v_it ->> 'type' = 'space' then
      select * into v_s from public.spaces where id = (v_it ->> 'id')::uuid and workspace_id = p_workspace_id;
      if not found then raise exception 'Una de las carpas copiadas ya no existe.'; end if;
      v_x := least(v_ws.map_width, greatest(0, round(v_s.x + coalesce(p_dx, 0))));
      v_y := least(v_ws.map_height, greatest(0, round(v_s.y + coalesce(p_dy, 0))));
      insert into public.spaces (workspace_id, kind, code, x, y, rotation)
        values (p_workspace_id, v_s.kind, private.next_space_code(p_workspace_id, v_s.code), v_x, v_y, v_s.rotation)
        returning id into v_id;
      v_out := v_out || jsonb_build_object('type', 'space', 'id', v_id);
    elsif v_it ->> 'type' = 'feature' then
      select * into v_f from public.map_features where id = (v_it ->> 'id')::uuid and workspace_id = p_workspace_id and active;
      if not found then raise exception 'Uno de los elementos copiados ya no existe.'; end if;
      v_x := least(v_ws.map_width, greatest(0, round(v_f.x + coalesce(p_dx, 0))));
      v_y := least(v_ws.map_height, greatest(0, round(v_f.y + coalesce(p_dy, 0))));
      insert into public.map_features (workspace_id, kind, label, x, y, width, height, rotation, color, layer)
        values (p_workspace_id, v_f.kind, v_f.label, v_x, v_y, v_f.width, v_f.height, v_f.rotation, v_f.color, v_f.layer)
        returning id into v_id;
      v_out := v_out || jsonb_build_object('type', 'feature', 'id', v_id);
    else
      raise exception 'Tipo de elemento desconocido.';
    end if;
  end loop;
  return v_out;
end $$;
revoke all on function public.paste_map_items(uuid, jsonb, numeric, numeric) from public, anon;
grant execute on function public.paste_map_items(uuid, jsonb, numeric, numeric) to authenticated;

-- =====================================================================
-- 0037 · Demo mucho más completa (modo invitado).
--   El balneario de demostración se llena con datos inventados que cubren
--   todo lo que el sistema hace: un mes de historia con cajas abiertas y
--   cerradas (con alguna diferencia), cobros en efectivo, transferencia y
--   tarjeta, señas, pagos en cuotas, deudores, gastos de todas las
--   categorías, convenios (10% y 15%), descuento por efectivo, cortesías,
--   extras (reposeras, gazebo…), cambios de carpa por un día y por viento,
--   reservas pegadas una detrás de otra, mantenimiento, una cancelación con
--   devolución y reservas lejanas. Hoy y los próximos días, casi lleno.
--   Solo afecta a los balnearios de demostración (nunca a uno real).
-- =====================================================================

-- Cobro con fecha pasada, en la caja de ese día (solo para armar la demo).
create or replace function private.demo_pay(p_ws uuid, p_res uuid, p_amount numeric, p_method text, p_day date, p_at timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare v_session uuid; v_pid uuid; v_num bigint;
begin
  if not exists (select 1 from public.workspaces where id = p_ws and is_demo) then
    raise exception 'Solo para balnearios de demostración.';
  end if;
  if p_amount is null or p_amount <= 0 then return; end if;
  select id into v_session from public.cash_sessions where workspace_id = p_ws and business_date = p_day;
  if v_session is null then return; end if;
  select number into v_num from public.reservations where id = p_res;
  insert into public.payments (workspace_id, reservation_id, kind, amount, signed_amount, method, cash_session_id, idempotency_key, created_at)
  values (p_ws, p_res, 'cobro', p_amount, p_amount, p_method, v_session, gen_random_uuid(), p_at)
  returning id into v_pid;
  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, payment_id, created_at)
  values (p_ws, v_session, 'entrada', p_method, p_amount, 'cobro', format('Cobro reserva #%s', v_num), v_pid, p_at);
end $$;
revoke all on function private.demo_pay(uuid, uuid, numeric, text, date, timestamptz) from public, anon, authenticated;

-- Gasto con fecha pasada, en la caja de ese día.
create or replace function private.demo_expense(p_ws uuid, p_day date, p_at timestamptz, p_amount numeric, p_concept text,
  p_category text, p_method text, p_supplier text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_session uuid; v_cat uuid; v_id uuid;
begin
  if not exists (select 1 from public.workspaces where id = p_ws and is_demo) then
    raise exception 'Solo para balnearios de demostración.';
  end if;
  select id into v_session from public.cash_sessions where workspace_id = p_ws and business_date = p_day;
  select id into v_cat from public.expense_categories where workspace_id = p_ws and name = p_category;
  if v_session is null or v_cat is null then return; end if;
  -- Si en la caja no alcanza el efectivo, se paga por transferencia (la caja nunca queda en negativo).
  if p_method = 'efectivo' and p_amount > (select s.opening_cash
        + coalesce(sum(m.amount) filter (where m.direction = 'entrada' and m.method = 'efectivo'), 0)
        - coalesce(sum(m.amount) filter (where m.direction = 'salida' and m.method = 'efectivo'), 0)
        from public.cash_sessions s left join public.cash_movements m on m.cash_session_id = s.id where s.id = v_session group by s.opening_cash) then
    p_method := 'transferencia';
  end if;
  insert into public.expenses (workspace_id, cash_session_id, amount, spent_on, concept, category_id, supplier, method, idempotency_key, created_at)
  values (p_ws, v_session, p_amount, p_day, p_concept, v_cat, p_supplier, p_method, gen_random_uuid(), p_at)
  returning id into v_id;
  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, expense_id, created_at)
  values (p_ws, v_session, 'salida', p_method, p_amount, 'gasto', left('Gasto: ' || p_concept, 200), v_id, p_at);
end $$;
revoke all on function private.demo_expense(uuid, date, timestamptz, numeric, text, text, text, text) from public, anon, authenticated;

create or replace function private.seed_demo(p_ws uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := private.ws_today(p_ws);
  v_tz text := (select timezone from public.workspaces where id = p_ws);
  v_hist int := 30;          -- días de historia
  v_far int := 80;           -- hasta dónde llegan las reservas lejanas
  v_first text[] := array['Juan','María','Carlos','Laura','Diego','Sofía','Martín','Valentina','Pablo','Lucía','Federico','Camila',
    'Nicolás','Florencia','Gustavo','Agustina','Hernán','Julieta','Sebastián','Paula','Ricardo','Silvina','Alejandro','Mariana',
    'Gonzalo','Carolina','Matías','Romina','Andrés','Natalia','Leandro','Verónica','Facundo','Daniela','Ezequiel','Gabriela',
    'Tomás','Micaela','Ignacio','Rocío','Marcelo','Claudia','Esteban','Lorena','Rodrigo','Analía','Franco','Belén','Javier','Cecilia'];
  v_last text[] := array['González','Rodríguez','Fernández','López','Martínez','Pérez','Gómez','Sánchez','Romero','Díaz','Álvarez',
    'Torres','Ruiz','Ramírez','Flores','Acosta','Benítez','Medina','Herrera','Suárez','Aguirre','Giménez','Molina','Castro','Ortiz',
    'Silva','Núñez','Luna','Juárez','Cabrera','Ríos','Ferreyra','Godoy','Morales','Domínguez','Moreno','Peralta','Vega','Carrizo','Quiroga'];
  v_towns text[] := array['Mar de Ajó','San Bernardo','Buenos Aires','La Plata','Córdoba','Rosario','Mendoza','San Juan','Tandil','Bahía Blanca','Lomas de Zamora','Quilmes'];
  v_cnotes text[] := array['Prefiere primera fila','Viene con perro (chico)','Pide sombra a la tarde','Cliente de hace años','Paga siempre por transferencia',
    'Familia numerosa: pide carpas juntas','Le molesta el viento: ubicar resguardado','Avisar si se libera la carpa de siempre'];
  v_n_cust int := 230;
  v_custs uuid[] := '{}';
  v_cid uuid; v_i int; v_j int; v_d date; v_end date; v_len int; v_kind text; v_m date; v_price numeric; v_half int;
  v_sp record; v_r record; v_res jsonb; v_rid uuid; v_total numeric; v_paid numeric; v_amt numeric; v_amt2 numeric;
  v_opts jsonb; v_segs jsonb; v_book date; v_method text; v_p numeric; v_x numeric; v_gap int;
  v_ag10 uuid; v_ag15 uuid; v_ex record; v_exr uuid; v_exs uuid; v_exg uuid; v_exm uuid;
  v_target uuid; v_ver int; v_sess uuid; v_exp numeric; v_diff numeric; v_pay uuid; v_cnt int;
  v_lens int[] := array[1,2,3,3,5,5,5,7,7,7,7,10,10,14,15,15,15,21,30];
  v_methods text[] := array['efectivo','efectivo','transferencia','transferencia','tarjeta'];
  v_plan jsonb := '[]'::jsonb;  -- cobros a registrar día por día
  v_ps date;                    -- temporada pasada: desde el 1/12 …
  v_pe date;                    -- … hasta el 31/3
  v_plan2 jsonb := '[]'::jsonb; -- cobros de la temporada pasada
begin
  if not exists (select 1 from public.workspaces where id = p_ws and is_demo) then
    raise exception 'Solo para balnearios de demostración.';
  end if;
  perform setseed(0.27);

  -- ── Configuración ────────────────────────────────────────────────
  update public.workspaces set cash_limit = 400000, version = version + 1 where id = p_ws;

  -- Tarifas: desde antes de la historia hasta después de las reservas lejanas
  for v_kind in select unnest(array['carpa','sombrilla']) loop
    for v_m in select generate_series(date_trunc('month', v_today - v_hist - 31), date_trunc('month', v_today + v_far + 31), interval '1 month')::date loop
      for v_half in 1..2 loop
        v_price := case extract(month from v_m) when 1 then 42000 when 2 then 38000 when 12 then 28000 when 3 then 24000 else 18000 end;
        if v_half = 2 and extract(month from v_m) = 12 then v_price := 36000; end if;
        if v_kind = 'sombrilla' then v_price := round(v_price * 0.55 / 500) * 500; end if;
        perform public.set_rate(p_ws, v_kind, extract(year from v_m)::int, extract(month from v_m)::int, v_half::smallint, v_price);
      end loop;
    end loop;
  end loop;

  -- Tarifas de la temporada pasada (más baratas: así se ve la diferencia al comparar temporadas)
  v_ps := make_date(extract(year from v_today)::int - case when extract(month from v_today) >= 7 then 1 else 2 end, 12, 1);
  v_pe := make_date(extract(year from v_ps)::int + 1, 3, 31);
  -- La temporada pasada arranca el mismo día que la historia de esta, un año antes: así «Comparar temporadas»
  -- tiene con qué comparar también los meses flojos del principio.
  v_ps := least(v_ps, ((v_today - v_hist) - interval '1 year')::date);
  for v_kind in select unnest(array['carpa','sombrilla']) loop
    for v_m in select generate_series(v_ps, v_pe, interval '1 month')::date loop
      for v_half in 1..2 loop
        v_price := case extract(month from v_m) when 1 then 26000 when 2 then 24000 when 12 then 17000 else 15000 end;
        if v_half = 2 and extract(month from v_m) = 12 then v_price := 22000; end if;
        if v_kind = 'sombrilla' then v_price := round(v_price * 0.55 / 500) * 500; end if;
        perform public.set_rate(p_ws, v_kind, extract(year from v_m)::int, extract(month from v_m)::int, v_half::smallint, v_price);
      end loop;
    end loop;
  end loop;

  -- Convenios: en la demo solo los dos inventados (el de Parque Bonito que trae todo balneario nuevo se saca).
  update public.agreements set deleted_at = now(), active = false, version = version + 1 where workspace_id = p_ws and name = 'Parque Bonito';
  insert into public.agreements (workspace_id, name, percent) values (p_ws, 'Club Náutico Las Gaviotas', 10) returning id into v_ag10;
  insert into public.agreements (workspace_id, name, percent) values (p_ws, 'Mutual Docentes del Sur', 15) returning id into v_ag15;

  -- Extras
  insert into public.extras (workspace_id, name, price, per_day) values (p_ws, 'Reposera', 3000, true) returning id into v_exr;
  insert into public.extras (workspace_id, name, price, per_day) values (p_ws, 'Sombrilla adicional', 5000, true) returning id into v_exs;
  insert into public.extras (workspace_id, name, price, per_day) values (p_ws, 'Gazebo', 9000, true) returning id into v_exg;
  insert into public.extras (workspace_id, name, price, per_day) values (p_ws, 'Mesa y 4 sillas', 15000, false) returning id into v_exm;

  -- ── Clientes ─────────────────────────────────────────────────────
  for v_i in 1..v_n_cust loop
    v_j := 1 + floor(random() * array_length(v_first, 1))::int;
    v_kind := v_last[1 + floor(random() * array_length(v_last, 1))::int];
    insert into public.customers (workspace_id, first_name, last_name, phone, email, locality, notes)
    values (p_ws, v_first[v_j], v_kind,
            '+54 9 ' || (array['2257','11','351','341','264','2255','221'])[1 + floor(random() * 7)::int] || ' ' || (4000000 + floor(random() * 5999999)::int),
            case when random() < 0.45 then lower(translate(v_first[v_j] || '.' || v_kind, 'áéíóúÁÉÍÓÚñÑ ', 'aeiouAEIOUnN')) || (array['@gmail.com','@hotmail.com','@yahoo.com.ar','@outlook.com'])[1 + floor(random() * 4)::int] end,
            v_towns[1 + floor(random() * array_length(v_towns, 1))::int],
            case when random() < 0.12 then v_cnotes[1 + floor(random() * array_length(v_cnotes, 1))::int] end)
    returning id into v_cid;
    v_custs := v_custs || v_cid;
  end loop;
  -- Dos personas con el mismo nombre (el sistema lo permite y avisa).
  insert into public.customers (workspace_id, first_name, last_name, phone, locality)
  values (p_ws, 'Juan', 'Pérez', '+54 9 11 5550101', 'Buenos Aires'), (p_ws, 'Juan', 'Pérez', '+54 9 351 5550202', 'Córdoba');

  -- Mientras se cargan las reservas de ejemplo no se llena el historial de cambios (es todo inventado y
  -- lo hace más lento). La disponibilidad igual se controla: create_reservation revisa cada carpa.
  perform set_config('app.restore_ws', p_ws::text, true);

  -- ── Reservas: carpa por carpa, a lo largo del tiempo ─────────────
  -- Casi lleno, pero 5 carpas y 1 sombrilla quedan libres desde hoy por 10 días, para poder probar una reserva.
  for v_sp in select id, kind, (row_number() over (partition by kind order by random())) <= (case kind when 'carpa' then 5 else 1 end) as libre
                from public.spaces where workspace_id = p_ws and active order by random() loop
    v_d := v_today - v_hist + floor(random() * 4)::int;
    loop
      exit when v_d > v_today + v_far;
      if v_sp.libre and v_d between v_today and v_today + 10 then v_d := v_today + 11; continue; end if;
      -- Qué tan lleno: la historia bastante, hoy y la semana casi completo, más adelante cada vez menos.
      v_p := case when v_d < v_today - 12 then 0.75 when v_d <= v_today + 8 then 0.93 when v_d <= v_today + 25 then 0.5 else 0.14 end;
      if random() > v_p then
        v_d := v_d + 1 + floor(random() * (case when v_d > v_today + 25 then 8 else 3 end))::int;
        continue;
      end if;
      v_len := v_lens[1 + floor(random() * array_length(v_lens, 1))::int];
      v_end := v_d + v_len - 1;
      -- Algunas estadías terminan hoy (para ver las salidas del día).
      if v_d < v_today and v_end > v_today and random() < 0.15 then v_end := v_today; end if;
      if v_sp.libre and v_d < v_today and v_end >= v_today then v_end := v_today - 1; end if;

      -- Cliente: los primeros de la lista vuelven más seguido (clientes frecuentes).
      v_cid := v_custs[1 + floor(power(random(), 1.25) * v_n_cust)::int];

      -- Descuentos: convenios, efectivo, manual o cortesía.
      v_x := random();
      v_opts := case
        when v_x < 0.03 then jsonb_build_object('courtesy', true, 'courtesy_beneficiary', (array['Hermana del dueño','Sobrinos del dueño','Padres del encargado'])[1 + floor(random() * 3)::int])
        when v_x < 0.14 then jsonb_build_object('agreement_id', v_ag10)
        when v_x < 0.21 then jsonb_build_object('agreement_id', v_ag15)
        when v_x < 0.27 then jsonb_build_object('manual', jsonb_build_object('type', 'monto', 'value', 5000, 'reason', 'Cliente de muchos años'))
        when v_x < 0.50 then jsonb_build_object('cash', true)
        else '{}'::jsonb end;
      v_segs := jsonb_build_array(jsonb_build_object('space_id', v_sp.id, 'start_date', v_d, 'end_date', v_end));
      v_rid := null;
      begin
        v_res := public.create_reservation_v2(p_ws, gen_random_uuid(), v_cid, v_d, v_end, v_segs, v_opts,
          case when v_opts ? 'courtesy' then 'Familia del dueño' when random() < 0.08 then 'Llega a la tarde' end, null);
        v_rid := (v_res ->> 'reservation_id')::uuid;
      exception when others then
        v_rid := null;
      end;

      if v_rid is not null then
        -- Extras: reposeras sobre todo
        if not (v_opts ? 'courtesy') and random() < 0.22 then
          v_x := random();
          perform public.add_reservation_extra(v_rid, case when v_x < 0.6 then v_exr when v_x < 0.8 then v_exs when v_x < 0.9 then v_exg else v_exm end,
                                               case when v_x < 0.6 then 1 + floor(random() * 3)::int else 1 end, null);
        end if;

        -- Cuándo reservó (y pagó): antes de llegar, nunca antes de la historia ni después de hoy.
        v_book := greatest(v_today - v_hist, least(v_today, v_d - floor(random() * 12)::int));
        if v_d > v_today + 10 then v_book := greatest(v_today - v_hist, v_today - floor(random() * 25)::int); end if;
        update public.reservations set created_at = (v_book::timestamp + interval '10 hours' + floor(random() * 480) * interval '1 minute') at time zone v_tz,
               version = version + 1 where id = v_rid;

        select total_amount into v_total from public.reservations where id = v_rid;
        v_method := case when v_opts ? 'cash' then 'efectivo' else v_methods[1 + floor(random() * 5)::int] end;
        v_x := random();
        if v_total > 0 then
          if v_x < 0.55 then
            -- Pagada completa al reservar
            if v_book < v_today then
              v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_total, 'm', v_method, 'd', v_book, 't', (v_book::timestamp + interval '11 hours' + floor(random() * 420) * interval '1 minute') at time zone v_tz);
            else
              v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_total, 'm', v_method, 'd', v_today);
            end if;
          elsif v_x < 0.82 then
            -- Seña (30 a 50%) y el resto al llegar… o queda debiendo
            v_amt := floor(v_total * (0.3 + random() * 0.2) / 1000) * 1000;
            if v_amt > 0 then
              if v_book < v_today then
                v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_amt, 'm', case when random() < 0.6 then 'transferencia' else v_method end, 'd', v_book, 't', (v_book::timestamp + interval '10 hours' + floor(random() * 480) * interval '1 minute') at time zone v_tz);
              else
                v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_amt, 'm', 'transferencia', 'd', v_today, 'n', 'Seña');
              end if;
            end if;
            if v_d < v_today and v_d > v_book and random() < 0.9 then
              -- Saldo al llegar (a veces en dos medios distintos)
              v_amt2 := v_total - v_amt;
              if random() < 0.3 and v_amt2 > 4000 then
                v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', floor(v_amt2 / 2), 'm', 'efectivo', 'd', v_d, 't', (v_d::timestamp + interval '10 hours 15 minutes') at time zone v_tz);
                v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_amt2 - floor(v_amt2 / 2), 'm', 'tarjeta', 'd', v_d, 't', (v_d::timestamp + interval '10 hours 20 minutes') at time zone v_tz);
              else
                v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_amt2, 'm', v_methods[1 + floor(random() * 5)::int], 'd', v_d, 't', (v_d::timestamp + interval '10 hours 30 minutes') at time zone v_tz);
              end if;
            end if;
          elsif v_x < 0.93 then
            -- Cobrar después: paga cuando llega (o sigue debiendo)
            if v_d < v_today and random() < 0.88 then
              v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_total, 'm', v_methods[1 + floor(random() * 5)::int], 'd', v_d, 't', (v_d::timestamp + interval '12 hours') at time zone v_tz);
            end if;
          else
            -- Paga en cuotas: tres pagos con distintos medios
            v_amt := floor(v_total / 3);
            if v_book < v_today then
              v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_amt, 'm', 'transferencia', 'd', v_book, 't', (v_book::timestamp + interval '9 hours 50 minutes') at time zone v_tz);
            end if;
            if v_d < v_today and v_d > v_book then
              v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_amt, 'm', 'efectivo', 'd', v_d, 't', (v_d::timestamp + interval '11 hours') at time zone v_tz);
              if v_d + 2 < v_today and v_d + 2 <= v_end then
                v_plan := v_plan || jsonb_build_object('r', v_rid, 'a', v_total - 2 * v_amt, 'm', 'tarjeta', 'd', v_d + 2, 't', (v_d::timestamp + interval '2 days 17 hours') at time zone v_tz);
              end if;
            end if;
          end if;
        end if;

        -- La próxima: a veces pegada (sale uno y entra otro al día siguiente), a veces con días libres.
        v_x := random();
        v_gap := case when v_x < 0.35 or (v_end between v_today - 12 and v_today + 6 and v_x < 0.85) then 0 when v_x < 0.7 then 1 + floor(random() * 2)::int else 3 + floor(random() * 5)::int end;
        v_d := v_end + 1 + v_gap;
      else
        v_d := v_d + 1;
      end if;
    end loop;
  end loop;

  -- ── Temporada pasada (para «Comparar temporadas» y los informes de meses anteriores) ──
  for v_sp in select id, kind from public.spaces where workspace_id = p_ws and active order by random() loop
    v_d := v_ps + floor(random() * 10)::int;
    loop
      exit when v_d > v_pe;
      -- Enero y la primera quincena de febrero, casi llenos; diciembre y marzo, flojos.
      v_p := case when extract(month from v_d) = 1 or (extract(month from v_d) = 2 and extract(day from v_d) <= 15) then 0.8
                  when extract(month from v_d) = 2 then 0.45 when extract(month from v_d) in (10, 11) then 0.08 else 0.22 end;
      if random() > v_p then v_d := v_d + 1 + floor(random() * 6)::int; continue; end if;
      -- En plena temporada la mayoría alquila por quincena o por mes.
      v_len := (array[7,10,15,15,15,15,30,30])[1 + floor(random() * 8)::int];
      v_end := least(v_pe, v_d + v_len - 1);
      v_cid := v_custs[1 + floor(power(random(), 1.25) * v_n_cust)::int];
      v_x := random();
      v_opts := case when v_x < 0.1 then jsonb_build_object('agreement_id', v_ag10) when v_x < 0.15 then jsonb_build_object('agreement_id', v_ag15)
                     when v_x < 0.45 then jsonb_build_object('cash', true) else '{}'::jsonb end;
      v_rid := null;
      begin
        v_res := public.create_reservation_v2(p_ws, gen_random_uuid(), v_cid, v_d, v_end,
          jsonb_build_array(jsonb_build_object('space_id', v_sp.id, 'start_date', v_d, 'end_date', v_end)), v_opts, null, null);
        v_rid := (v_res ->> 'reservation_id')::uuid;
      exception when others then v_rid := null;
      end;
      if v_rid is not null then
        v_book := greatest(v_ps, v_d - floor(random() * 15)::int);
        update public.reservations set created_at = (v_book::timestamp + interval '10 hours' + floor(random() * 480) * interval '1 minute') at time zone v_tz,
               version = version + 1 where id = v_rid;
        select total_amount into v_total from public.reservations where id = v_rid;
        v_plan2 := v_plan2 || jsonb_build_object('r', v_rid, 'a', v_total, 'm', case when v_opts ? 'cash' then 'efectivo' else v_methods[1 + floor(random() * 5)::int] end,
          'd', v_book, 't', (v_book::timestamp + interval '11 hours' + floor(random() * 420) * interval '1 minute') at time zone v_tz);
        v_d := v_end + 1 + (case when random() < 0.5 then 0 else floor(random() * 4)::int end);
      else
        v_d := v_d + 1;
      end if;
    end loop;
  end loop;
  -- Cajas día por día: apertura, cobros, algún gasto y cierre (cuadra justo, salvo algún día).
  for v_d in select generate_series(v_ps, v_pe, interval '1 day')::date loop
    insert into public.cash_sessions (workspace_id, business_date, opening_cash, opened_at)
    values (p_ws, v_d, 40000, (v_d::timestamp + interval '8 hours 45 minutes') at time zone v_tz)
    returning id into v_sess;
    for v_r in select * from jsonb_to_recordset(v_plan2) as x(r uuid, a numeric, m text, d date, t timestamptz) where x.d = v_d order by x.t loop
      perform private.demo_pay(p_ws, v_r.r, v_r.a, v_r.m, v_d, v_r.t);
    end loop;
    if random() < 0.6 then
      perform private.demo_expense(p_ws, v_d, (v_d::timestamp + interval '12 hours') at time zone v_tz, e.a::numeric, e.c, e.k, e.m, e.s)
      from (select * from (values
        (round((8000 + random() * 9000) / 100) * 100, 'Hielo para el parador', 'Proveedores e insumos', 'efectivo', 'Hielos del Sur'),
        (round((30000 + random() * 30000) / 100) * 100, 'Bebidas para el parador', 'Proveedores e insumos', 'transferencia', 'Distribuidora Costa Atlántica'),
        (round((6000 + random() * 6000) / 100) * 100, 'Artículos de limpieza', 'Limpieza', 'efectivo', 'Limpieza Total'),
        (round((15000 + random() * 20000) / 100) * 100, 'Arreglo de carpa', 'Reparaciones', 'efectivo', 'Herrería Gómez'),
        (round((20000 + random() * 15000) / 100) * 100, 'Lona para carpa', 'Mantenimiento', 'transferencia', 'Lonas del Mar'),
        (round((5000 + random() * 8000) / 100) * 100, 'Herramientas varias', 'Materiales y herramientas', 'efectivo', 'Ferretería El Tornillo'),
        (round((12000 + random() * 10000) / 100) * 100, 'Combustible del cuatriciclo', 'Otros gastos', 'tarjeta', 'YPF Ruta 11')
      ) t(a, c, k, m, s) order by random() limit 1) e;
    end if;
    select 40000 + coalesce(sum(amount) filter (where direction = 'entrada' and method = 'efectivo'), 0)
                 - coalesce(sum(amount) filter (where direction = 'salida' and method = 'efectivo'), 0)
      into v_exp from public.cash_movements where cash_session_id = v_sess;
    v_diff := case when random() < 0.9 or v_exp < 1000 then 0 else -500 end;
    update public.cash_sessions
       set closed_at = (v_d::timestamp + interval '20 hours 10 minutes') at time zone v_tz,
           counted_cash = v_exp + v_diff, expected_cash = v_exp, difference = v_diff,
           close_notes = case when v_diff < 0 then 'Faltó cambio chico' end, version = version + 1
     where id = v_sess;
  end loop;

  -- Números de reserva en el orden en que se reservaron (como en un balneario real).
  update public.reservations set number = number + 1000000, version = version + 1 where workspace_id = p_ws;
  update public.reservations r set number = m.n, version = r.version + 1
    from (select id, row_number() over (order by created_at, id) as n from public.reservations where workspace_id = p_ws) m
   where m.id = r.id;
  perform set_config('app.restore_ws', '', true);

  -- ── Cambios de carpa ─────────────────────────────────────────────
  -- Por viento: el resto de la estadía en otra carpa libre.
  v_cnt := 0;
  for v_r in
    select r.id, r.version, r.end_date, g.space_id, sp.kind from public.reservations r
      join public.reservation_segments g on g.reservation_id = r.id and g.active
      join public.spaces sp on sp.id = g.space_id
     where r.workspace_id = p_ws and r.status = 'confirmada' and r.start_date < v_today and r.end_date > v_today + 2
     order by random() limit 12
  loop
    select s.id into v_target from public.spaces s where s.workspace_id = p_ws and s.active and s.kind = v_r.kind and s.id <> v_r.space_id
      and not exists (select 1 from public.reservation_segments g where g.space_id = s.id and g.active and g.start_date <= v_r.end_date and g.end_date >= v_today)
      order by random() limit 1;
    continue when v_target is null;
    begin
      perform public.relocate_reservation(v_r.id, v_target, v_today, v_r.end_date, v_r.version,
        (array['Mucho viento del sur: pidió una carpa más resguardada', 'Viento fuerte: se pasó cerca del parador', 'Prefiere estar más cerca del mar'])[1 + v_cnt % 3]);
      v_cnt := v_cnt + 1;
    exception when others then null;
    end;
    exit when v_cnt >= 4;
  end loop;
  -- Por un solo día (mañana), y vuelve a su carpa.
  v_cnt := 0;
  for v_r in
    select r.id, r.version, g.space_id, sp.kind from public.reservations r
      join public.reservation_segments g on g.reservation_id = r.id and g.active and g.start_date <= v_today + 1 and g.end_date >= v_today + 2
      join public.spaces sp on sp.id = g.space_id
     where r.workspace_id = p_ws and r.status = 'confirmada' and r.start_date <= v_today
     order by random() limit 12
  loop
    select s.id into v_target from public.spaces s where s.workspace_id = p_ws and s.active and s.kind = v_r.kind and s.id <> v_r.space_id
      and not exists (select 1 from public.reservation_segments g where g.space_id = s.id and g.active and g.start_date <= v_today + 1 and g.end_date >= v_today + 1)
      order by random() limit 1;
    continue when v_target is null;
    begin
      perform public.relocate_reservation(v_r.id, v_target, v_today + 1, v_today + 1, v_r.version,
        (array['Mañana viene con amigos: pidió una carpa más grande por el día', 'Por un día, al lado de la familia', 'Mañana quiere sol de mañana'])[1 + v_cnt % 3]);
      v_cnt := v_cnt + 1;
    exception when others then null;
    end;
    exit when v_cnt >= 3;
  end loop;

  -- ── Mantenimiento ────────────────────────────────────────────────
  v_cnt := 0;
  for v_sp in select s.id from public.spaces s where s.workspace_id = p_ws and s.active and s.kind = 'carpa'
                and not exists (select 1 from public.reservation_segments g where g.space_id = s.id and g.active and g.start_date <= v_today + 4 and g.end_date >= v_today + 2)
              order by random() limit 2 loop
    insert into public.maintenance_blocks (workspace_id, space_id, start_date, end_date, reason, notes)
    values (p_ws, v_sp.id, v_today + 2, v_today + 4, (array['Cambio de lona', 'Arreglo de la estructura'])[1 + v_cnt], 'Lo hace Herrería Gómez');
    v_cnt := v_cnt + 1;
  end loop;

  -- ── Días pasados: caja abierta, cobros, gastos y cierre (la mayoría sin diferencia) ──
  for v_i in reverse v_hist..1 loop
    v_d := v_today - v_i;
    insert into public.cash_sessions (workspace_id, business_date, opening_cash, opening_notes, opened_at)
    values (p_ws, v_d, 50000, case when v_i = v_hist then 'Primer día de la temporada' end,
            (v_d::timestamp + interval '8 hours 40 minutes') at time zone v_tz)
    returning id into v_sess;
    for v_r in select * from jsonb_to_recordset(v_plan) as x(r uuid, a numeric, m text, d date, t timestamptz, n text) where x.d = v_d order by x.t loop
      perform private.demo_pay(p_ws, v_r.r, v_r.a, v_r.m, v_d, v_r.t + floor(random() * 80) * interval '1 minute');
    end loop;
    for v_j in 1..(1 + floor(random() * 3.5)::int) loop
      v_x := random();
      perform private.demo_expense(p_ws, v_d, (v_d::timestamp + interval '9 hours' + floor(random() * 540) * interval '1 minute') at time zone v_tz,
        e.amount::numeric, e.concept, e.category, e.method, e.supplier)
      from (select * from (values
        (0.12, round((12000 + random() * 14000) / 100) * 100, 'Hielo para el parador', 'Proveedores e insumos', 'efectivo', 'Hielos del Sur'),
        (0.22, round((45000 + random() * 50000) / 100) * 100, 'Bebidas para el parador', 'Proveedores e insumos', 'transferencia', 'Distribuidora Costa Atlántica'),
        (0.30, round((6000 + random() * 6000) / 100) * 100, 'Bolsas de residuos', 'Proveedores e insumos', 'efectivo', null),
        (0.38, round((8000 + random() * 9000) / 100) * 100, 'Lavandina, detergente y trapos', 'Limpieza', 'efectivo', 'Limpieza Total'),
        (0.45, 25000, 'Limpieza de baños (turno tarde)', 'Limpieza', 'efectivo', null),
        (0.52, round((15000 + random() * 25000) / 100) * 100, 'Arreglo de estructura de carpa', 'Reparaciones', 'efectivo', 'Herrería Gómez'),
        (0.57, round((30000 + random() * 30000) / 100) * 100, 'Plomero: pérdida en duchas', 'Reparaciones', 'transferencia', 'Plomería Ruiz'),
        (0.64, round((38000 + random() * 20000) / 100) * 100, 'Lona nueva para carpa', 'Mantenimiento', 'transferencia', 'Lonas del Mar'),
        (0.70, round((12000 + random() * 8000) / 100) * 100, 'Pintura para sombrillas', 'Mantenimiento', 'tarjeta', 'Pinturería Centro'),
        (0.76, round((9000 + random() * 12000) / 100) * 100, 'Sogas, estacas y precintos', 'Materiales y herramientas', 'efectivo', 'Ferretería El Tornillo'),
        (0.81, round((18000 + random() * 15000) / 100) * 100, 'Rastrillo y palas', 'Materiales y herramientas', 'tarjeta', 'Ferretería El Tornillo'),
        (0.88, round((20000 + random() * 15000) / 100) * 100, 'Combustible del cuatriciclo', 'Otros gastos', 'tarjeta', 'YPF Ruta 11'),
        (0.93, 35000, 'Publicidad en radio local', 'Otros gastos', 'transferencia', 'FM Costa'),
        (0.97, 28000, 'Recarga de matafuegos', 'Otros gastos', 'efectivo', 'Seguridad Atlántica'),
        (1.01, round((5000 + random() * 5000) / 100) * 100, 'Viáticos del personal', 'Otros gastos', 'efectivo', null)
      ) t(upto, amount, concept, category, method, supplier) where upto >= v_x order by upto limit 1) e;
    end loop;
    select 50000 + coalesce(sum(amount) filter (where direction = 'entrada' and method = 'efectivo'), 0)
                 - coalesce(sum(amount) filter (where direction = 'salida' and method = 'efectivo'), 0)
      into v_exp from public.cash_movements where cash_session_id = v_sess;
    -- Si junta mucho efectivo, a la tarde se deposita en el banco (y la caja queda con el fondo).
    if v_exp > 400000 and random() < 0.8 then
      v_amt := floor((v_exp - 50000) / 10000) * 10000;
      insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, idempotency_key, created_at)
      values (p_ws, v_sess, 'salida', 'efectivo', v_amt, 'deposito', 'Depósito de efectivo · Banco Provincia', gen_random_uuid(),
              (v_d::timestamp + interval '19 hours 30 minutes') at time zone v_tz);
      v_exp := v_exp - v_amt;
    end if;
    v_x := random();
    v_diff := case when v_x < 0.75 then 0 when v_x < 0.85 then -500 when v_x < 0.92 then 200 when v_x < 0.97 then -1000 else -2500 end;
    if v_exp + v_diff < 0 then v_diff := 0; end if;
    update public.cash_sessions
       set closed_at = (v_d::timestamp + interval '20 hours' + floor(random() * 60) * interval '1 minute') at time zone v_tz,
           counted_cash = v_exp + v_diff, expected_cash = v_exp, difference = v_diff,
           close_notes = case when v_diff < -1500 then 'Faltante: se revisa con el encargado' when v_diff < 0 then 'Faltó cambio chico'
                              when v_diff > 0 then 'Sobró: un cliente no esperó el vuelto' end,
           version = version + 1
     where id = v_sess;
  end loop;

  -- ── Hoy ──────────────────────────────────────────────────────────
  perform public.open_cash_session(p_ws, 50000, 'Apertura de demostración');
  for v_r in select * from jsonb_to_recordset(v_plan) as x(r uuid, a numeric, m text, d date, t timestamptz, n text) where x.d = v_today loop
    perform private.record_payment(p_ws, v_r.r, 'cobro', v_r.a, v_r.m, gen_random_uuid(), v_r.n, null);
  end loop;
  -- Algunos deudores pagan hoy.
  for v_r in
    select r.id, r.total_amount - coalesce((select sum(signed_amount) from public.payments p where p.reservation_id = r.id), 0) as due
      from public.reservations r
     where r.workspace_id = p_ws and r.status = 'confirmada' and r.start_date <= v_today and r.end_date >= v_today and not r.is_courtesy
     order by random()
  loop
    continue when v_r.due <= 0;
    v_cnt := coalesce(v_cnt, 0);
    exit when random() < 0.12;
    perform private.record_payment(p_ws, v_r.id, 'cobro', v_r.due, v_methods[1 + floor(random() * 5)::int], gen_random_uuid(), null, null);
  end loop;

  -- Un cobro cargado mal y anulado (queda registrado), y después el correcto.
  select r.id, r.total_amount - coalesce((select sum(signed_amount) from public.payments p where p.reservation_id = r.id), 0)
    into v_rid, v_amt from public.reservations r
   where r.workspace_id = p_ws and r.status = 'confirmada' and r.start_date > v_today and not r.is_courtesy
     and r.total_amount - coalesce((select sum(signed_amount) from public.payments p where p.reservation_id = r.id), 0) > 10000
   order by random() limit 1;
  if v_rid is not null then
    v_pay := private.record_payment(p_ws, v_rid, 'cobro', 10000, 'tarjeta', gen_random_uuid(), null, null);
    perform public.void_payment(p_ws, v_pay, gen_random_uuid(), 'Se pasó la tarjeta equivocada');
    perform private.record_payment(p_ws, v_rid, 'cobro', 10000, 'transferencia', gen_random_uuid(), 'Seña', null);
  end if;

  -- Una cancelación con devolución de la seña.
  select r.id, r.version, coalesce((select sum(signed_amount) from public.payments p where p.reservation_id = r.id), 0)
    into v_rid, v_ver, v_amt from public.reservations r
   where r.workspace_id = p_ws and r.status = 'confirmada' and r.start_date > v_today + 5
     and coalesce((select sum(signed_amount) from public.payments p where p.reservation_id = r.id), 0) > 0
   order by random() limit 1;
  if v_rid is not null then
    begin
      perform public.refund_payment(p_ws, v_rid, v_amt, 'efectivo', gen_random_uuid(), 'Canceló por un problema familiar');
      select version into v_ver from public.reservations where id = v_rid;
      perform public.cancel_reservation(v_rid, v_ver, 'Canceló por un problema familiar: se devolvió la seña');
    exception when others then null;
    end;
  end if;

  -- Gastos y otros ingresos de hoy (uno anulado por error de carga).
  perform public.register_expense(p_ws, gen_random_uuid(), 18500, v_today, 'Hielo para el parador', (select id from public.expense_categories where workspace_id = p_ws and name = 'Proveedores e insumos'), 'efectivo', 'Hielos del Sur', null);
  perform public.register_expense(p_ws, gen_random_uuid(), 9200, v_today, 'Lavandina y trapos', (select id from public.expense_categories where workspace_id = p_ws and name = 'Limpieza'), 'efectivo', null, null);
  v_res := public.register_expense(p_ws, gen_random_uuid(), 92000, v_today, 'Lona nueva', (select id from public.expense_categories where workspace_id = p_ws and name = 'Mantenimiento'), 'efectivo', 'Lonas del Mar', null);
  begin
    perform public.void_expense(p_ws, (v_res ->> 'expense_id')::uuid, 'Se cargó dos veces');
  exception when others then null;
  end;
  perform public.register_other_income(p_ws, gen_random_uuid(), 8000, 'efectivo', 'Alquiler de tabla de surf por el día');

  insert into public.day_notes (workspace_id, day, text) values
    (p_ws, v_today, 'Esto es una demostración: probá agregar, tildar o quitar notas'),
    (p_ws, v_today, 'Hoy viene el proveedor de hielo'),
    (p_ws, v_today, 'Pronóstico: viento sur por la tarde. Ofrecer carpas cerca del parador'),
    (p_ws, v_today + 1, 'Llamar a la herrería por las carpas en mantenimiento');
end $$;
revoke all on function private.seed_demo(uuid) from public, anon, authenticated;

-- El borrado de una demo incluye lo nuevo (extras y su uso en reservas).
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
  delete from public.reservation_extras where workspace_id = p_ws;
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
  delete from public.extras where workspace_id = p_ws;
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

-- =====================================================================
-- 0038 · La demo tiene tiempo para armarse.
--   Supabase corta cualquier consulta de un usuario a los 8 segundos. Armar la
--   demo completa (más de mil reservas, dos temporadas, un mes de cajas) puede
--   tardar más en el servidor, y salía «canceling statement due to statement
--   timeout». Esta función —y solo esta— tiene hasta 60 segundos.
-- =====================================================================
alter function public.start_guest_session() set statement_timeout = '60s';

-- =====================================================================
-- 0039 · Cantidad de carpas y sombrillas contratada.
--   · Cada balneario tiene un máximo de carpas y de sombrillas (lo que contrató).
--     Puede desactivar las que quiera, pero no tener más activas que el máximo:
--     ni agregando, ni reactivando, ni copiando y pegando en el plano.
--   · Los balnearios que ya existen quedan con las que tienen activas hoy.
--   · El máximo lo cambia solo el dueño de la plataforma (panel /admin), y se
--     puede fijar al habilitar un correo. La demo no tiene límite.
-- =====================================================================

alter table public.workspaces add column if not exists max_tents integer check (max_tents >= 0);
alter table public.workspaces add column if not exists max_umbrellas integer check (max_umbrellas >= 0);
-- (las columnas no se habilitan para que los usuarios las editen: solo por las funciones de abajo)

update public.workspaces w set
  max_tents = (select count(*) from public.spaces s where s.workspace_id = w.id and s.active and s.kind = 'carpa'),
  max_umbrellas = (select count(*) from public.spaces s where s.workspace_id = w.id and s.active and s.kind = 'sombrilla'),
  version = w.version + 1
where not w.is_demo and w.max_tents is null and w.max_umbrellas is null;

alter table private.signup_allowlist add column if not exists max_tents integer check (max_tents between 0 and 600);
alter table private.signup_allowlist add column if not exists max_umbrellas integer check (max_umbrellas between 0 and 300);

-- Control: una carpa o sombrilla que pasa a estar activa no puede superar el máximo.
create or replace function private.enforce_space_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_max integer;
  v_n integer;
begin
  if not new.active then return new; end if;
  if tg_op = 'UPDATE' and old.active and old.kind = new.kind then return new; end if;
  if coalesce(private.restoring(new.workspace_id::text), false) or coalesce(private.purging(new.workspace_id::text), false) or private.is_platform_admin() then return new; end if;
  select case new.kind when 'carpa' then max_tents else max_umbrellas end into v_max
    from public.workspaces where id = new.workspace_id;
  if v_max is null then return new; end if;
  -- De a una por balneario, para que dos compus no se pasen juntas.
  perform pg_advisory_xact_lock(hashtextextended('espacios:' || new.workspace_id::text, 0));
  select count(*) into v_n from public.spaces
   where workspace_id = new.workspace_id and kind = new.kind and active and id <> new.id;
  if v_n + 1 > v_max then
    raise exception 'Tu plan incluye % %. Podés desactivar una y activar otra, pero para sumar más escribinos.',
      v_max, case new.kind when 'carpa' then case when v_max = 1 then 'carpa' else 'carpas' end else case when v_max = 1 then 'sombrilla' else 'sombrillas' end end
      using errcode = 'P0001', hint = 'LIMITE_ESPACIOS';
  end if;
  return new;
end $$;
revoke all on function private.enforce_space_limit() from public, anon, authenticated;
drop trigger if exists spaces_limit on public.spaces;
create trigger spaces_limit before insert or update of active, kind on public.spaces
  for each row execute function private.enforce_space_limit();

create or replace function public.create_workspace(p_name text, p_tents integer default 90, p_umbrellas integer default 10)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_user uuid := auth.uid();
  v_email text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email';
  v_cols constant integer := 15;
  v_rows integer;
  v_w integer;
  v_h integer;
  v_digits integer;
  i integer;
  v_max_t integer;
  v_max_u integer;
begin
  if v_user is null then
    raise exception 'Tenés que iniciar sesión.' using errcode = '28000';
  end if;
  if private.is_guest() then
    raise exception 'En el modo invitado no se puede crear un balneario. Registrate con Google o con un usuario.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'Ingresá el nombre del balneario.';
  end if;
  if p_tents is null or p_tents < 0 or p_tents > 600 or p_umbrellas is null or p_umbrellas < 0 or p_umbrellas > 300 or p_tents + p_umbrellas = 0 then
    raise exception 'Indicá cuántas carpas (hasta 600) y sombrillas (hasta 300) tenés.';
  end if;
  -- Una cuenta, un balneario (evita duplicados por doble clic o dos pestañas).
  perform pg_advisory_xact_lock(hashtextextended('alta-balneario:' || v_user::text, 0));
  if exists (select 1 from public.workspace_members where user_id = v_user) then
    raise exception 'Tu cuenta ya pertenece a un balneario.';
  end if;
  if not private.can_create_workspace(v_user) then
    raise exception 'Para crear un balneario hace falta un plan. Mirá los planes en la página principal o escribinos.'
      using errcode = '42501', hint = 'SIN_PLAN';
  end if;

  -- Si la habilitación dice cuántas carpas y sombrillas contrató, no se puede pasar de eso.
  select a.max_tents, a.max_umbrellas into v_max_t, v_max_u
    from private.signup_allowlist a join auth.users u on lower(u.email::text) = a.email
   where u.id = v_user and a.used_at is null;
  if (v_max_t is not null and p_tents > v_max_t) or (v_max_u is not null and p_umbrellas > v_max_u) then
    raise exception 'Tu plan incluye hasta % carpas y % sombrillas. Para sumar más, escribinos.',
      coalesce(v_max_t::text, 'las'), coalesce(v_max_u::text, 'las') using hint = 'LIMITE_ESPACIOS';
  end if;

  -- Plano genérico: filas de 15 carpas y, más cerca del mar, las sombrillas.
  v_rows := ceil(p_tents / v_cols::numeric)::integer + ceil(p_umbrellas / v_cols::numeric)::integer;
  v_w := 300 + v_cols * 180;
  v_h := greatest(1200, 700 + v_rows * 160);
  v_digits := greatest(2, length((p_tents + p_umbrellas)::text));

  -- Cantidad contratada: la de la habilitación o, si no dice, la que se carga ahora.
  insert into public.workspaces (name, created_by, map_width, map_height, sea_side, max_tents, max_umbrellas)
  values (btrim(p_name), v_user, v_w, v_h, 'bottom', coalesce(v_max_t, p_tents), coalesce(v_max_u, p_umbrellas))
  returning id into v_ws;
  insert into public.workspace_members (workspace_id, user_id, role, email) values (v_ws, v_user, 'propietario', v_email);

  for i in 1..p_tents loop
    insert into public.spaces (workspace_id, kind, code, x, y)
    values (v_ws, 'carpa', lpad(i::text, v_digits, '0'), 240 + ((i - 1) % v_cols) * 180, 420 + ((i - 1) / v_cols) * 160);
  end loop;
  for i in 1..p_umbrellas loop
    insert into public.spaces (workspace_id, kind, code, x, y)
    values (v_ws, 'sombrilla', lpad((p_tents + i)::text, v_digits, '0'), 240 + ((i - 1) % v_cols) * 180,
            420 + (ceil(p_tents / v_cols::numeric)::integer + (i - 1) / v_cols) * 160 + 40);
  end loop;

  insert into public.map_features (workspace_id, kind, label, x, y, width, height, color) values
    (v_ws, 'instalacion', 'Parador', v_w / 2 - 300, 60, 600, 180, '#a86a1f'),
    (v_ws, 'camino', null, 150, 300, v_w - 300, 30, '#9a6a34');

  insert into public.expense_categories (workspace_id, name) values
    (v_ws, 'Proveedores e insumos'), (v_ws, 'Mantenimiento'), (v_ws, 'Reparaciones'),
    (v_ws, 'Limpieza'), (v_ws, 'Materiales y herramientas'), (v_ws, 'Personal'),
    (v_ws, 'Servicios'), (v_ws, 'Otros gastos');
  insert into public.package_discounts (workspace_id, min_days, percent)
  values (v_ws, 5, 5), (v_ws, 7, 8), (v_ws, 15, 12), (v_ws, 30, 20);
  insert into public.user_preferences (user_id) values (v_user) on conflict (user_id) do nothing;
  update private.signup_allowlist set used_at = now(), workspace_id = v_ws
   where email = lower(coalesce((select u.email::text from auth.users u where u.id = v_user), '')) and used_at is null;
  return v_ws;
end $$;

-- Panel del dueño: cambiar el máximo de un balneario (null = sin límite).
create or replace function public.admin_set_space_limits(p_workspace_id uuid, p_tents integer, p_umbrellas integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  if (p_tents is not null and (p_tents < 0 or p_tents > 2000)) or (p_umbrellas is not null and (p_umbrellas < 0 or p_umbrellas > 2000)) then
    raise exception 'Cantidad inválida.';
  end if;
  update public.workspaces set max_tents = p_tents, max_umbrellas = p_umbrellas, version = version + 1
   where id = p_workspace_id and not is_demo;
  if not found then raise exception 'No se encontró el balneario.'; end if;
end $$;
revoke all on function public.admin_set_space_limits(uuid, integer, integer) from public, anon;
grant execute on function public.admin_set_space_limits(uuid, integer, integer) to authenticated;

-- Habilitar un correo, ahora también con la cantidad contratada.
drop function if exists public.admin_allow_signup(text, text, text, numeric);
create or replace function public.admin_allow_signup(p_email text, p_note text default null, p_plan text default null, p_price numeric default null,
                                                     p_tents integer default null, p_umbrellas integer default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v text := lower(btrim(coalesce(p_email, '')));
begin
  perform private.require_platform_admin();
  if v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Correo inválido.'; end if;
  if p_plan is not null and p_plan not in ('mensual','temporada') then raise exception 'Plan inválido.'; end if;
  if p_price is not null and p_price < 0 then raise exception 'Precio inválido.'; end if;
  if (p_tents is not null and (p_tents < 0 or p_tents > 600)) or (p_umbrellas is not null and (p_umbrellas < 0 or p_umbrellas > 300)) then
    raise exception 'Indicá hasta 600 carpas y 300 sombrillas.';
  end if;
  insert into private.signup_allowlist (email, note, plan, price, max_tents, max_umbrellas)
  values (v, nullif(btrim(coalesce(p_note, '')), ''), p_plan, p_price, p_tents, p_umbrellas)
  on conflict (email) do update set note = coalesce(excluded.note, private.signup_allowlist.note), plan = excluded.plan, price = excluded.price,
    max_tents = excluded.max_tents, max_umbrellas = excluded.max_umbrellas
  where private.signup_allowlist.used_at is null;
end $$;
revoke all on function public.admin_allow_signup(text, text, text, numeric, integer, integer) from public, anon;
grant execute on function public.admin_allow_signup(text, text, text, numeric, integer, integer) to authenticated;

-- Para la pantalla de alta: cuántas carpas y sombrillas trae la habilitación de esta cuenta.
create or replace function public.my_signup_limits() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('carpas', a.max_tents, 'sombrillas', a.max_umbrellas)
    from private.signup_allowlist a join auth.users u on lower(u.email::text) = a.email
   where u.id = auth.uid() and a.used_at is null
$$;
revoke all on function public.my_signup_limits() from public, anon;
grant execute on function public.my_signup_limits() to authenticated;

create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_grace int;
begin
  perform private.require_platform_admin();
  select dias_gracia into v_grace from private.plataforma where id = 1;
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
          'max_carpas', w.max_tents, 'max_sombrillas', w.max_umbrellas, 'version', w.version,
          'reservas', (select count(*) from public.reservations r where r.workspace_id = w.id and r.status = 'confirmada'),
          'reservas_30d', (select count(*) from public.reservations r where r.workspace_id = w.id and r.created_at > now() - interval '30 days'),
          'ultimo_uso', (select max(a.at) from public.audit_log a where a.workspace_id = w.id),
          'plan', (select jsonb_build_object('plan', s.plan, 'precio', s.price, 'estado', s.status, 'pago_hasta', s.paid_until,
                                             'vencido', private.plan_expired(w.id), 'debito', s.mp_preapproval_id is not null and s.status = 'activa',
                                             'proximo_debito', s.next_charge_on, 'ultimo_estado', s.last_payment_status, 'ultimo_pago', s.last_payment_at)
                   from public.subscriptions s where s.workspace_id = w.id)
        ) as x
        from public.workspaces w
        where not w.is_demo
      ) t), '[]'::jsonb),
    'habilitaciones', coalesce((
      select jsonb_agg(jsonb_build_object('correo', a.email, 'nota', a.note, 'creado', a.created_at, 'usado', a.used_at,
                                          'plan', a.plan, 'precio', a.price, 'carpas', a.max_tents, 'sombrillas', a.max_umbrellas,
                                          'balneario', (select name from public.workspaces where id = a.workspace_id))
                       order by a.created_at desc)
      from private.signup_allowlist a), '[]'::jsonb),
    'avisos', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'tipo', e.kind, 'balneario', w.name, 'workspace_id', e.workspace_id,
                                          'importe', e.amount, 'detalle', e.detail, 'fecha', e.created_at) order by e.created_at desc)
      from public.subscription_events e join public.workspaces w on w.id = e.workspace_id
      where e.kind in ('cancelada','pago_rechazado') and e.seen_at is null), '[]'::jsonb),
    'precios', (select jsonb_build_object('mensual', precio_mensual, 'temporada', precio_temporada, 'dias_gracia', dias_gracia) from private.plataforma where id = 1),
    'hoy', private.today_ar(),
    'demos_abiertas', (select count(*) from public.workspaces where is_demo)
  ) into v;
  return v;
end $$;

-- =====================================================================
-- 0040 · Contador de la demo: cuántas conexiones distintas la probaron.
--   · Se guarda solo un código (hash) de la dirección IP, nunca la IP.
--   · La registra el servidor (clave secreta); el número lo puede leer cualquiera.
-- =====================================================================
create table if not exists private.demo_visitors (
  ip_hash    text primary key check (length(ip_hash) between 16 and 128),
  first_at   timestamptz not null default now(),
  last_at    timestamptz not null default now(),
  visits     integer not null default 1
);
alter table private.demo_visitors enable row level security;
revoke all on private.demo_visitors from public, anon, authenticated;

create or replace function public.demo_register_visit(p_hash text) returns void
language sql security definer set search_path = '' as $$
  insert into private.demo_visitors (ip_hash) values (p_hash)
  on conflict (ip_hash) do update set last_at = now(), visits = private.demo_visitors.visits + 1
$$;
revoke all on function public.demo_register_visit(text) from public, anon, authenticated;
grant execute on function public.demo_register_visit(text) to service_role;

create or replace function public.demo_visitor_count() returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::int from private.demo_visitors
$$;
revoke all on function public.demo_visitor_count() from public;
grant execute on function public.demo_visitor_count() to anon, authenticated, service_role;

-- =====================================================================
-- 0041 · Reabrir la caja de hoy (si se cerró por error) y ubicación de la brújula en el plano.
--   · Reabrir: solo la caja del día, solo propietario o administrador y con motivo.
--     El cierre anterior no se pierde: queda guardado en reopen_history (y en el historial).
--     Los movimientos no se tocan.
--   · compass_layout: dónde va la brújula sobre el plano y de qué tamaño ({x, y, scale}).
-- =====================================================================
alter table public.cash_sessions add column if not exists reopen_history jsonb;
alter table public.workspaces add column if not exists compass_layout jsonb;

-- La caja cerrada sigue sin poder modificarse, salvo dentro de reopen_cash_session.
create or replace function private.cash_sessions_guard() returns trigger
language plpgsql as $$
begin
  if old.closed_at is not null and coalesce(current_setting('app.cash_reopen', true), '') <> old.id::text then
    raise exception 'Esta caja ya está cerrada y no se puede modificar.' using errcode = '42501';
  end if;
  if new.opening_cash <> old.opening_cash or new.business_date <> old.business_date then
    raise exception 'La apertura de caja no se puede modificar.' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.reopen_cash_session(p_session_id uuid, p_expected_version integer, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_s public.cash_sessions%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_s from public.cash_sessions where id = p_session_id for update;
  if not found then raise exception 'La caja no existe.'; end if;
  perform private.require_member(v_s.workspace_id, array['propietario','administrador']);
  if v_s.closed_at is null then raise exception 'Esta caja ya está abierta.'; end if;
  if v_s.business_date <> private.ws_today(v_s.workspace_id) then
    raise exception 'Solo se puede reabrir la caja de hoy.';
  end if;
  if v_s.version <> p_expected_version then
    raise exception 'Otra persona cambió esta caja recién. Volvé a intentar.' using errcode = '40001';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then raise exception 'Escribí el motivo para reabrir la caja.'; end if;
  if char_length(v_reason) > 300 then raise exception 'El motivo puede tener hasta 300 caracteres.'; end if;
  if exists (select 1 from public.cash_sessions where workspace_id = v_s.workspace_id and closed_at is null) then
    raise exception 'Ya hay otra caja abierta.';
  end if;

  perform set_config('app.cash_reopen', v_s.id::text, true);
  update public.cash_sessions set
    reopen_history = coalesce(reopen_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'cerrada', v_s.closed_at, 'cerrada_por', v_s.closed_by, 'contado', v_s.counted_cash, 'esperado', v_s.expected_cash,
      'diferencia', v_s.difference, 'notas', v_s.close_notes, 'reabierta', now(), 'reabierta_por', auth.uid(), 'motivo', v_reason)),
    closed_at = null, closed_by = null, counted_cash = null, expected_cash = null, difference = null, close_notes = null,
    version = p_expected_version + 1
  where id = v_s.id;
  perform set_config('app.cash_reopen', '', true);

  return public.cash_session_summary(v_s.id);
end $$;
revoke all on function public.reopen_cash_session(uuid, integer, text) from public, anon;
grant execute on function public.reopen_cash_session(uuid, integer, text) to authenticated;

-- =====================================================================
-- 0042 · Nueva reserva con extras: todo en una sola operación.
--   Se crea la reserva, se le suman los extras elegidos y recién después se registra
--   el cobro (así «Pagada» cubre la carpa y los extras). Si algo falla, no queda nada a medias.
-- =====================================================================
create or replace function public.create_reservation_v3(
  p_workspace_id uuid, p_request_id uuid, p_customer_id uuid, p_start_date date, p_end_date date,
  p_segments jsonb, p_options jsonb default '{}'::jsonb, p_notes text default null, p_payment jsonb default null,
  p_extras jsonb default '[]'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.reservations%rowtype;
  v_res jsonb;
  v_id uuid;
  v_x jsonb;
begin
  perform private.require_member(p_workspace_id);
  select * into v_existing from public.reservations where workspace_id = p_workspace_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('reservation_id', v_existing.id, 'number', v_existing.number, 'repetida', true);
  end if;
  if p_extras is not null and jsonb_typeof(p_extras) <> 'array' then raise exception 'Extras inválidos.'; end if;
  if jsonb_array_length(coalesce(p_extras, '[]'::jsonb)) > 30 then raise exception 'Demasiados extras en una reserva.'; end if;

  v_res := public.create_reservation_v2(p_workspace_id, p_request_id, p_customer_id, p_start_date, p_end_date,
                                        p_segments, p_options, p_notes, null);
  v_id := (v_res ->> 'reservation_id')::uuid;

  for v_x in select * from jsonb_array_elements(coalesce(p_extras, '[]'::jsonb)) loop
    perform public.add_reservation_extra(v_id, (v_x ->> 'extra_id')::uuid, (v_x ->> 'quantity')::integer, nullif(v_x ->> 'days', '')::integer);
  end loop;

  if p_payment is not null then
    if nullif(p_payment ->> 'usd_amount', '') is not null then
      perform public.register_payment_usd(p_workspace_id, v_id, (p_payment ->> 'usd_amount')::numeric, (p_payment ->> 'exchange_rate')::numeric,
                                          (p_payment ->> 'idempotency_key')::uuid, null);
    else
      perform public.register_payment(p_workspace_id, v_id, (p_payment ->> 'amount')::numeric, p_payment ->> 'method',
                                      (p_payment ->> 'idempotency_key')::uuid, null);
    end if;
  end if;

  return v_res || jsonb_build_object('total_amount', (select total_amount from public.reservations where id = v_id));
end $$;
revoke all on function public.create_reservation_v3(uuid, uuid, uuid, date, date, jsonb, jsonb, text, jsonb, jsonb) from public, anon;
grant execute on function public.create_reservation_v3(uuid, uuid, uuid, date, date, jsonb, jsonb, text, jsonb, jsonb) to authenticated;

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

-- =====================================================================
-- 0044 · Planes Anual y Temporada (entrada + 2 cuotas).
--   · Anual: un solo pago que cubre 12 meses.
--   · Temporada: una entrada al contratar y 2 cuotas iguales que vencen el 1/1 y el 1/2.
--     Entrada → pago hasta el 31/12 · cuota 1 → hasta el 31/1 · cuota 2 → hasta el 31/3.
--   · Los pagos los registra el dueño a mano (transferencia o efectivo).
--   · El plan "mensual" queda solo para lo que ya existía.
-- =====================================================================
alter table private.plataforma add column if not exists precio_anual      numeric(14,2) not null default 0 check (precio_anual >= 0);
alter table private.plataforma add column if not exists temporada_entrada numeric(14,2) not null default 0 check (temporada_entrada >= 0);
alter table private.plataforma add column if not exists temporada_cuota   numeric(14,2) not null default 0 check (temporada_cuota >= 0);

alter table private.signup_allowlist drop constraint if exists signup_allowlist_plan_check;
alter table private.signup_allowlist add constraint signup_allowlist_plan_check check (plan in ('mensual','anual','temporada'));
alter table private.signup_allowlist add column if not exists entry_amount numeric(14,2) check (entry_amount >= 0);
alter table private.signup_allowlist add column if not exists installment_amount numeric(14,2) check (installment_amount >= 0);

alter table public.subscriptions drop constraint if exists subscriptions_plan_check;
alter table public.subscriptions add constraint subscriptions_plan_check check (plan in ('mensual','anual','temporada'));
alter table public.subscriptions add column if not exists entry_amount numeric(14,2) check (entry_amount >= 0);
alter table public.subscriptions add column if not exists installment_amount numeric(14,2) check (installment_amount >= 0);
-- Cuántas partes de la temporada en curso se pagaron (0 a 3) y de qué temporada (su 31/3).
alter table public.subscriptions add column if not exists installments_paid integer not null default 0 check (installments_paid between 0 and 3);
alter table public.subscriptions add column if not exists season_end date;

-- Hasta qué día queda pago después de un cobro (anual: un año; temporada: lo resuelve el pago por cuotas).
create or replace function private.extend_until(p_plan text, p_current date, p_paid_on date) returns date
language sql immutable as $$
  select case p_plan
    when 'mensual' then (greatest(coalesce(p_current, p_paid_on), p_paid_on) + interval '1 month')::date
    when 'anual' then (greatest(coalesce(p_current, p_paid_on), p_paid_on) + interval '1 year')::date
    else case when private.season_end(p_paid_on) > coalesce(p_current, p_paid_on - 1)
              then private.season_end(p_paid_on)
              else private.season_end(p_current + 1) end
  end
$$;

-- Temporada: hasta cuándo cubre cada parte (1 = entrada, 2 = cuota de enero, 3 = cuota de febrero).
create or replace function private.season_part_until(p_season_end date, p_part integer) returns date
language sql immutable as $$
  select case p_part
    when 1 then make_date(extract(year from p_season_end)::int, 1, 1) - 1
    when 2 then make_date(extract(year from p_season_end)::int, 2, 1) - 1
    else p_season_end end
$$;

create or replace function private.allowlist_creates_subscription() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p private.plataforma%rowtype;
begin
  if new.workspace_id is not null and old.workspace_id is null and new.plan is not null then
    select * into p from private.plataforma where id = 1;
    insert into public.subscriptions (workspace_id, plan, price, entry_amount, installment_amount, paid_until, season_end)
    values (new.workspace_id, new.plan,
            coalesce(new.price, case new.plan when 'mensual' then p.precio_mensual when 'anual' then p.precio_anual
                                              else coalesce(new.entry_amount, p.temporada_entrada) + 2 * coalesce(new.installment_amount, p.temporada_cuota) end),
            case when new.plan = 'temporada' then coalesce(new.entry_amount, p.temporada_entrada) end,
            case when new.plan = 'temporada' then coalesce(new.installment_amount, p.temporada_cuota) end,
            private.today_ar(), private.season_end(private.today_ar()))
    on conflict (workspace_id) do nothing;
    insert into public.subscription_events (workspace_id, kind, detail) values (new.workspace_id, 'alta', 'Plan ' || new.plan);
  end if;
  return new;
end $$;

drop function if exists public.admin_set_prices(numeric, numeric);
create or replace function public.admin_set_prices(p_anual numeric, p_entrada numeric, p_cuota numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  if p_anual is null or p_anual < 0 or p_entrada is null or p_entrada < 0 or p_cuota is null or p_cuota < 0 then raise exception 'Precio inválido.'; end if;
  update private.plataforma set precio_anual = p_anual, temporada_entrada = p_entrada, temporada_cuota = p_cuota,
         precio_temporada = p_entrada + 2 * p_cuota where id = 1;
end $$;
revoke all on function public.admin_set_prices(numeric, numeric, numeric) from public, anon;
grant execute on function public.admin_set_prices(numeric, numeric, numeric) to authenticated;

drop function if exists public.admin_allow_signup(text, text, text, numeric, integer, integer);
create or replace function public.admin_allow_signup(p_email text, p_note text default null, p_plan text default null, p_price numeric default null,
                                                     p_tents integer default null, p_umbrellas integer default null,
                                                     p_entry numeric default null, p_installment numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v text := lower(btrim(coalesce(p_email, ''))); v_price numeric := p_price;
begin
  perform private.require_platform_admin();
  if v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Correo inválido.'; end if;
  if p_plan is not null and p_plan not in ('anual','temporada') then raise exception 'Plan inválido.'; end if;
  if p_plan = 'temporada' then
    if p_entry is null or p_entry < 0 or p_installment is null or p_installment < 0 then raise exception 'Poné la entrada y la cuota.'; end if;
    v_price := p_entry + 2 * p_installment;
  end if;
  if v_price is not null and v_price < 0 then raise exception 'Precio inválido.'; end if;
  if (p_tents is not null and (p_tents < 0 or p_tents > 600)) or (p_umbrellas is not null and (p_umbrellas < 0 or p_umbrellas > 300)) then
    raise exception 'Indicá hasta 600 carpas y 300 sombrillas.';
  end if;
  insert into private.signup_allowlist (email, note, plan, price, max_tents, max_umbrellas, entry_amount, installment_amount)
  values (v, nullif(btrim(coalesce(p_note, '')), ''), p_plan, v_price, p_tents, p_umbrellas,
          case when p_plan = 'temporada' then p_entry end, case when p_plan = 'temporada' then p_installment end)
  on conflict (email) do update set note = coalesce(excluded.note, private.signup_allowlist.note), plan = excluded.plan, price = excluded.price,
    max_tents = excluded.max_tents, max_umbrellas = excluded.max_umbrellas,
    entry_amount = excluded.entry_amount, installment_amount = excluded.installment_amount
  where private.signup_allowlist.used_at is null;
end $$;
revoke all on function public.admin_allow_signup(text, text, text, numeric, integer, integer, numeric, numeric) from public, anon;
grant execute on function public.admin_allow_signup(text, text, text, numeric, integer, integer, numeric, numeric) to authenticated;

drop function if exists public.admin_set_plan(uuid, text, numeric, boolean);
create or replace function public.admin_set_plan(p_workspace_id uuid, p_plan text, p_price numeric, p_exempt boolean default false,
                                                 p_entry numeric default null, p_installment numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_price numeric := p_price;
begin
  perform private.require_platform_admin();
  if p_plan not in ('anual','temporada') then raise exception 'Plan inválido.'; end if;
  if p_plan = 'temporada' then
    if p_entry is null or p_entry < 0 or p_installment is null or p_installment < 0 then raise exception 'Poné la entrada y la cuota.'; end if;
    v_price := p_entry + 2 * p_installment;
  end if;
  if v_price is null or v_price < 0 then raise exception 'Precio inválido.'; end if;
  if not exists (select 1 from public.workspaces where id = p_workspace_id and not is_demo) then raise exception 'El balneario no existe.'; end if;
  insert into public.subscriptions (workspace_id, plan, price, status, paid_until, entry_amount, installment_amount, season_end)
  values (p_workspace_id, p_plan, v_price, case when p_exempt then 'exenta' else 'pendiente' end, private.today_ar(),
          case when p_plan = 'temporada' then p_entry end, case when p_plan = 'temporada' then p_installment end,
          private.season_end(private.today_ar()))
  on conflict (workspace_id) do update
    set plan = excluded.plan, price = excluded.price, entry_amount = excluded.entry_amount, installment_amount = excluded.installment_amount,
        status = case when p_exempt then 'exenta'
                      when public.subscriptions.status = 'exenta' then 'pendiente'
                      else public.subscriptions.status end,
        updated_at = now();
  insert into public.subscription_events (workspace_id, kind, amount, detail, actor_id)
  values (p_workspace_id, 'cambio_plan', v_price,
          'Plan ' || p_plan || case when p_plan = 'temporada' then ' (entrada ' || p_entry || ' + 2 cuotas de ' || p_installment || ')' else '' end
          || case when p_exempt then ' (sin vencimiento)' else '' end, auth.uid());
end $$;
revoke all on function public.admin_set_plan(uuid, text, numeric, boolean, numeric, numeric) from public, anon;
grant execute on function public.admin_set_plan(uuid, text, numeric, boolean, numeric, numeric) to authenticated;

-- Pago registrado a mano. En Temporada cada pago es la parte que sigue (entrada, cuota 1, cuota 2).
create or replace function public.admin_register_payment(p_workspace_id uuid, p_amount numeric, p_until date default null, p_note text default null) returns date
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions%rowtype; v_until date; v_season date := private.season_end(private.today_ar()); v_part integer; v_label text;
begin
  perform private.require_platform_admin();
  select * into s from public.subscriptions where workspace_id = p_workspace_id for update;
  if not found then raise exception 'Ese balneario no tiene plan. Asignale uno primero.'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Importe inválido.'; end if;
  if s.plan = 'temporada' then
    -- Temporada nueva: vuelve a empezar por la entrada.
    v_part := case when s.season_end is distinct from v_season then 1 else least(s.installments_paid + 1, 3) end;
    v_label := case v_part when 1 then 'Entrada' when 2 then 'Cuota 1 de 2 (enero)' else 'Cuota 2 de 2 (febrero)' end;
    v_until := coalesce(p_until, greatest(private.season_part_until(v_season, v_part), private.today_ar()));
  else
    v_until := coalesce(p_until, private.extend_until(s.plan, s.paid_until, private.today_ar()));
  end if;
  if v_until < private.today_ar() then raise exception 'La fecha tiene que ser hoy o más adelante.'; end if;
  update public.subscriptions
     set paid_until = v_until, status = case when status in ('pendiente','cancelada') then 'manual' else status end,
         installments_paid = case when s.plan = 'temporada' then v_part else installments_paid end,
         season_end = case when s.plan = 'temporada' then v_season else season_end end,
         last_payment_at = now(), last_payment_status = 'aprobado', last_payment_amount = p_amount, updated_at = now()
   where workspace_id = p_workspace_id;
  insert into public.subscription_events (workspace_id, kind, amount, detail, actor_id)
  values (p_workspace_id, 'pago_manual', p_amount,
          coalesce(v_label || ' · ', '') || coalesce(nullif(btrim(p_note), ''), 'Pago registrado a mano') || ' · pago hasta el ' || to_char(v_until, 'DD/MM/YYYY'), auth.uid());
  return v_until;
end $$;

-- Para el balneario: su plan, con las partes de la temporada.
create or replace function public.my_plan(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions%rowtype; v_grace int; v_season date := private.season_end(private.today_ar()); v_paid int;
begin
  perform private.require_member(p_workspace_id);
  select * into s from public.subscriptions where workspace_id = p_workspace_id;
  if not found then return null; end if;
  select dias_gracia into v_grace from private.plataforma where id = 1;
  v_paid := case when s.season_end is distinct from v_season then 0 else s.installments_paid end;
  return jsonb_build_object(
    'plan', s.plan, 'precio', s.price, 'estado', s.status, 'pago_hasta', s.paid_until,
    'entrada', s.entry_amount, 'cuota', s.installment_amount, 'cuotas_pagas', v_paid,
    'partes', case when s.plan = 'temporada' then jsonb_build_array(
        jsonb_build_object('nombre', 'Entrada', 'importe', s.entry_amount, 'vence', null, 'pagada', v_paid >= 1),
        jsonb_build_object('nombre', 'Cuota 1', 'importe', s.installment_amount, 'vence', make_date(extract(year from v_season)::int, 1, 1), 'pagada', v_paid >= 2),
        jsonb_build_object('nombre', 'Cuota 2', 'importe', s.installment_amount, 'vence', make_date(extract(year from v_season)::int, 2, 1), 'pagada', v_paid >= 3)) end,
    'bloquea_desde', case when s.status = 'exenta' then null else coalesce(s.paid_until, s.created_at::date) + v_grace + 1 end,
    'vencido', private.plan_expired(p_workspace_id), 'dias_gracia', v_grace,
    'proximo_debito', s.next_charge_on, 'debito_automatico', s.mp_preapproval_id is not null and s.status = 'activa',
    'pagador', s.mp_payer_email, 'ultimo_pago', s.last_payment_at, 'ultimo_estado', s.last_payment_status,
    'temporada_hasta', v_season, 'hoy', private.today_ar(),
    'movimientos', coalesce((select jsonb_agg(jsonb_build_object('tipo', e.kind, 'importe', e.amount, 'detalle', e.detail, 'fecha', e.created_at) order by e.created_at desc)
                             from (select * from public.subscription_events where workspace_id = p_workspace_id order by created_at desc limit 12) e), '[]'::jsonb)
  );
end $$;

create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_grace int;
begin
  perform private.require_platform_admin();
  select dias_gracia into v_grace from private.plataforma where id = 1;
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
          'max_carpas', w.max_tents, 'max_sombrillas', w.max_umbrellas, 'version', w.version,
          'reservas', (select count(*) from public.reservations r where r.workspace_id = w.id and r.status = 'confirmada'),
          'reservas_30d', (select count(*) from public.reservations r where r.workspace_id = w.id and r.created_at > now() - interval '30 days'),
          'ultimo_uso', (select max(a.at) from public.audit_log a where a.workspace_id = w.id),
          'plan', (select jsonb_build_object('plan', s.plan, 'precio', s.price, 'estado', s.status, 'pago_hasta', s.paid_until,
                                             'entrada', s.entry_amount, 'cuota', s.installment_amount,
                                             'cuotas_pagas', case when s.season_end is distinct from private.season_end(private.today_ar()) then 0 else s.installments_paid end,
                                             'vencido', private.plan_expired(w.id), 'debito', s.mp_preapproval_id is not null and s.status = 'activa',
                                             'proximo_debito', s.next_charge_on, 'ultimo_estado', s.last_payment_status, 'ultimo_pago', s.last_payment_at)
                   from public.subscriptions s where s.workspace_id = w.id)
        ) as x
        from public.workspaces w
        where not w.is_demo
      ) t), '[]'::jsonb),
    'habilitaciones', coalesce((
      select jsonb_agg(jsonb_build_object('correo', a.email, 'nota', a.note, 'creado', a.created_at, 'usado', a.used_at,
                                          'plan', a.plan, 'precio', a.price, 'entrada', a.entry_amount, 'cuota', a.installment_amount, 'carpas', a.max_tents, 'sombrillas', a.max_umbrellas,
                                          'balneario', (select name from public.workspaces where id = a.workspace_id))
                       order by a.created_at desc)
      from private.signup_allowlist a), '[]'::jsonb),
    'avisos', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'tipo', e.kind, 'balneario', w.name, 'workspace_id', e.workspace_id,
                                          'importe', e.amount, 'detalle', e.detail, 'fecha', e.created_at) order by e.created_at desc)
      from public.subscription_events e join public.workspaces w on w.id = e.workspace_id
      where e.kind in ('cancelada','pago_rechazado') and e.seen_at is null), '[]'::jsonb),
    'precios', (select jsonb_build_object('mensual', precio_mensual, 'temporada', precio_temporada, 'anual', precio_anual,
                                          'entrada', temporada_entrada, 'cuota', temporada_cuota, 'dias_gracia', dias_gracia) from private.plataforma where id = 1),
    'hoy', private.today_ar(),
    'demos_abiertas', (select count(*) from public.workspaces where is_demo)
  ) into v;
  return v;
end $$;

-- =====================================================================
-- 0045 · La demo con su propio plano, prolijo, ubicada en Mar del Plata.
--   · Ya no copia el plano del primer balneario real: usa el plano modelo
--     (89 espacios con parador), sin el cartel de normas, con la pasarela que
--     pisaba la carpa 47 corrida al pasillo y los caminos por debajo del parador.
--   · Ubicación: Mar del Plata, para que se vea el clima, el viento y el sol en el mapa.
-- =====================================================================
create or replace function public.start_guest_session() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_ws uuid;
begin
  if v_user is null or not private.is_guest() then
    raise exception 'Esta opción es solo para entrar como invitado.' using errcode = '42501';
  end if;
  select m.workspace_id into v_ws from public.workspace_members m where m.user_id = v_user;
  if found then return v_ws; end if;

  perform private.purge_stale_guests();
  -- Evita que se creen demasiadas demostraciones al mismo tiempo.
  if (select count(*) from public.workspaces where is_demo) >= 50 then
    raise exception 'Hay muchos invitados en este momento. Probá de nuevo en un rato.';
  end if;

  -- La brújula arriba a la izquierda, sobre la arena libre (abajo a la derecha tapaba las carpas 01 a 04).
  insert into public.workspaces (name, subtitle, created_by, map_width, map_height, sea_side, sea_bearing, latitude, longitude, timezone, is_demo, compass_layout)
  values ('Balneario de demostración', 'Mar del Plata · Modo invitado', v_user, 3050, 2300, 'bottom', 110,
          -38.0055, -57.5426, 'America/Argentina/Buenos_Aires', true, '{"x": 13, "y": 15, "scale": 0.85}'::jsonb)
  returning id into v_ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (v_ws, v_user, 'propietario');

  insert into public.spaces (workspace_id, kind, code, x, y)
    select v_ws, p.kind, p.code, p.x, p.y from private.parador_spaces() p order by p.code;
  -- Caminos con capa -1: pasan por debajo del parador y las instalaciones.
  insert into public.map_features (workspace_id, kind, label, x, y, width, height, color, layer)
    select v_ws, f.kind, f.label,
           case when f.kind = 'camino' and f.x = 1910 and f.y = 857 then 1944 else f.x end,  -- no pisa la carpa 47
           f.y, f.width, f.height, f.color,
           case when f.kind = 'camino' then -1 else 0 end
      from private.parador_features() f
     where coalesce(f.label, '') not ilike 'Normas%';

  insert into public.expense_categories (workspace_id, name) values
    (v_ws, 'Proveedores e insumos'), (v_ws, 'Mantenimiento'), (v_ws, 'Reparaciones'), (v_ws, 'Limpieza'),
    (v_ws, 'Materiales y herramientas'), (v_ws, 'Otros gastos');
  insert into public.agreements (workspace_id, name, percent) values (v_ws, 'Parque Bonito', 30);
  insert into public.package_discounts (workspace_id, min_days, percent) values (v_ws, 5, 5), (v_ws, 7, 8), (v_ws, 15, 12), (v_ws, 30, 20);
  perform private.seed_demo(v_ws);
  return v_ws;
end $$;
alter function public.start_guest_session() set statement_timeout = '60s';
revoke all on function public.start_guest_session() from public, anon;
grant execute on function public.start_guest_session() to authenticated;

-- 0046 · Personas por reserva, máximo por carpa/sombrilla y reservas de grupo (varias carpas juntas).
--
-- · reservations.people: cuántas personas ocupan ese espacio (opcional, sin separar adultos y menores).
-- · reservations.group_id: une las reservas que se hicieron juntas para un mismo grupo. Cada carpa sigue
--   siendo su propia reserva (disponibilidad, cambios de carpa, historial y deshacer funcionan igual).
-- · workspaces.tent_capacity / umbrella_capacity: máximo de personas que define el balneario (vacío = sin máximo).
-- · create_reservation_group: crea la reserva principal y las carpas extra en una sola transacción
--   (o se guardan todas o ninguna) y reparte el cobro entre ellas.

alter table public.reservations add column if not exists people integer check (people is null or people between 1 and 500);
alter table public.reservations add column if not exists group_id uuid;
create index if not exists reservations_group_idx on public.reservations(workspace_id, group_id) where group_id is not null;

alter table public.workspaces add column if not exists tent_capacity integer check (tent_capacity is null or tent_capacity between 1 and 100);
alter table public.workspaces add column if not exists umbrella_capacity integer check (umbrella_capacity is null or umbrella_capacity between 1 and 100);
grant update (tent_capacity, umbrella_capacity) on public.workspaces to authenticated;

create or replace function public.create_reservation_group(
  p_workspace_id uuid, p_request_id uuid, p_customer_id uuid, p_start_date date, p_end_date date,
  p_segments jsonb, p_extra_spaces uuid[] default '{}', p_options jsonb default '{}'::jsonb, p_notes text default null,
  p_payment jsonb default null, p_extras jsonb default '[]'::jsonb, p_people integer default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.reservations%rowtype;
  v_extra uuid[] := coalesce(p_extra_spaces, '{}');
  v_n integer;
  v_group uuid;
  v_main jsonb;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_opts jsonb;
  v_i integer;
  v_left numeric;
  v_pay numeric;
  v_due numeric;
  v_people integer;
begin
  perform private.require_member(p_workspace_id);
  -- Reintento (doble clic, recarga): devuelve lo que ya se guardó.
  select * into v_existing from public.reservations where workspace_id = p_workspace_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('reservation_id', v_existing.id, 'number', v_existing.number, 'group_id', v_existing.group_id, 'repetida', true);
  end if;
  if p_people is not null and (p_people < 1 or p_people > 500) then raise exception 'La cantidad de personas tiene que ser entre 1 y 500.'; end if;
  if array_length(v_extra, 1) > 9 then raise exception 'Un grupo puede tener hasta 10 espacios.'; end if;
  if (select count(distinct e.sid) from unnest(v_extra) as e(sid)) <> coalesce(array_length(v_extra, 1), 0) then
    raise exception 'Hay espacios repetidos en el grupo.';
  end if;
  if exists (select 1 from unnest(v_extra) as e(sid), jsonb_array_elements(p_segments) s where (s ->> 'space_id')::uuid = e.sid) then
    raise exception 'Un espacio del grupo es el mismo que el principal.';
  end if;
  if exists (select 1 from unnest(v_extra) as e(sid) where not exists (select 1 from public.spaces sp where sp.id = e.sid and sp.workspace_id = p_workspace_id and sp.active)) then
    raise exception 'Uno de los espacios del grupo no existe o está desactivado.';
  end if;
  if coalesce(array_length(v_extra, 1), 0) > 0 and p_payment is not null and nullif(p_payment ->> 'usd_amount', '') is not null then
    raise exception 'En una reserva de grupo cobrá en pesos; los dólares se registran después desde cada reserva.';
  end if;

  v_n := 1 + coalesce(array_length(v_extra, 1), 0);
  v_group := case when v_n > 1 then gen_random_uuid() end;

  -- Principal (con sus tramos, extras y opciones de precio tal cual)
  v_main := public.create_reservation_v3(p_workspace_id, p_request_id, p_customer_id, p_start_date, p_end_date,
                                          p_segments, p_options, p_notes, null, p_extras);
  v_ids := array_append(v_ids, (v_main ->> 'reservation_id')::uuid);

  -- Las demás carpas del grupo: toda la estadía, mismo precio y descuentos.
  -- Un descuento manual en pesos se aplica una sola vez (en la principal), no en cada carpa.
  v_opts := case when p_options -> 'manual' ->> 'type' = 'monto' then p_options - 'manual' else p_options end;
  for v_i in 1 .. v_n - 1 loop
    v_id := (public.create_reservation_v3(
      p_workspace_id, md5(p_request_id::text || ':grupo:' || v_i)::uuid, p_customer_id, p_start_date, p_end_date,
      jsonb_build_array(jsonb_build_object('space_id', v_extra[v_i], 'start_date', p_start_date, 'end_date', p_end_date)),
      v_opts, p_notes, null, '[]'::jsonb) ->> 'reservation_id')::uuid;
    v_ids := array_append(v_ids, v_id);
  end loop;

  -- Personas repartidas entre las carpas (la principal se lleva el resto) y el grupo.
  for v_i in 1 .. v_n loop
    v_people := case when p_people is null then null
                     else (p_people / v_n) + case when v_i <= p_people % v_n then 1 else 0 end end;
    if v_people = 0 then v_people := null; end if;
    update public.reservations set people = v_people, group_id = v_group, version = version + 1
     where id = v_ids[v_i] and (people is distinct from v_people or group_id is distinct from v_group);
  end loop;

  -- Cobro: se reparte en orden, completando cada carpa antes de pasar a la siguiente.
  if p_payment is not null then
    if v_n = 1 then
      if nullif(p_payment ->> 'usd_amount', '') is not null then
        perform public.register_payment_usd(p_workspace_id, v_ids[1], (p_payment ->> 'usd_amount')::numeric, (p_payment ->> 'exchange_rate')::numeric,
                                            (p_payment ->> 'idempotency_key')::uuid, null);
      else
        perform public.register_payment(p_workspace_id, v_ids[1], (p_payment ->> 'amount')::numeric, p_payment ->> 'method',
                                        (p_payment ->> 'idempotency_key')::uuid, null);
      end if;
    else
      v_left := (p_payment ->> 'amount')::numeric;
      if v_left is null or v_left <= 0 then raise exception 'Importe del cobro inválido.'; end if;
      for v_i in 1 .. v_n loop
        exit when v_left <= 0;
        select total_amount into v_due from public.reservations where id = v_ids[v_i];
        v_pay := least(v_left, v_due);
        if v_pay > 0 then
          perform public.register_payment(p_workspace_id, v_ids[v_i], v_pay, p_payment ->> 'method',
                                          case when v_i = 1 then (p_payment ->> 'idempotency_key')::uuid
                                               else md5((p_payment ->> 'idempotency_key') || ':grupo:' || v_i)::uuid end, null);
          v_left := v_left - v_pay;
        end if;
      end loop;
      if v_left > 0.009 then raise exception 'El cobro supera el total del grupo.'; end if;
    end if;
  end if;

  return v_main || jsonb_build_object(
    'group_id', v_group,
    'reservations', (select jsonb_agg(jsonb_build_object('id', r.id, 'number', r.number) order by r.number)
                       from public.reservations r where r.id = any(v_ids)),
    'total_amount', (select sum(total_amount) from public.reservations where id = any(v_ids)));
end $$;
revoke all on function public.create_reservation_group(uuid, uuid, uuid, date, date, jsonb, uuid[], jsonb, text, jsonb, jsonb, integer) from public, anon;
grant execute on function public.create_reservation_group(uuid, uuid, uuid, date, date, jsonb, uuid[], jsonb, text, jsonb, jsonb, integer) to authenticated;

-- Cambiar la cantidad de personas de una reserva ya hecha.
create or replace function public.set_reservation_people(p_reservation_id uuid, p_expected_version integer, p_people integer)
returns void language plpgsql security definer set search_path = '' as $$
declare v_r public.reservations%rowtype;
begin
  select * into v_r from public.reservations where id = p_reservation_id for update;
  if not found then raise exception 'La reserva no existe.'; end if;
  perform private.require_member(v_r.workspace_id);
  if v_r.version <> p_expected_version then
    raise exception 'Este dato fue modificado desde otro dispositivo. Recargá la pantalla e intentá de nuevo.' using errcode = '40001', hint = 'CONFLICTO_VERSION';
  end if;
  if p_people is not null and (p_people < 1 or p_people > 500) then raise exception 'La cantidad de personas tiene que ser entre 1 y 500.'; end if;
  update public.reservations set people = p_people, version = version + 1 where id = p_reservation_id;
end $$;
revoke all on function public.set_reservation_people(uuid, integer, integer) from public, anon;
grant execute on function public.set_reservation_people(uuid, integer, integer) to authenticated;

-- 0047 · Paquetes con precio fijo por cantidad de días (Descuentos y convenios).
--
-- El dueño puede fijar, por tipo de espacio, el precio de un paquete (ej. carpa 5 días = $90.000)
-- y el precio de cada día extra (ej. $20.000: 6 días = $110.000) hasta el próximo paquete.
-- Opcionalmente con vigencia (desde/hasta): sin fechas vale siempre. Se toma el paquete más largo
-- que entra en la estadía, vigente el día de entrada. Con paquete fijo no se usa el tarifario por día
-- ni el paquete en %, pero sí se suman convenio, efectivo y descuento manual según la regla del balneario.
-- Las reservas ya hechas no cambian: guardan su precio y el paquete usado.

create table if not exists public.package_prices (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  space_kind      text not null check (space_kind in ('carpa','sombrilla')),
  days            integer not null check (days between 1 and 366),
  price           numeric(14,2) not null check (price >= 0),
  extra_day_price numeric(14,2) not null check (extra_day_price >= 0),
  valid_from      date,
  valid_to        date,
  active          boolean not null default true,
  version         integer not null default 1,
  created_at      timestamptz not null default now(),
  unique (workspace_id, id),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);
create index if not exists package_prices_ws_idx on public.package_prices(workspace_id, space_kind, days) where active;

drop trigger if exists package_prices_version on public.package_prices;
create trigger package_prices_version before update on public.package_prices
  for each row execute function private.check_version();
drop trigger if exists package_prices_audit on public.package_prices;
create trigger package_prices_audit after insert or update on public.package_prices
  for each row execute function private.audit();
-- No se borran: se desactivan (sin permiso de borrado). En pausa no se pueden cambiar.
drop trigger if exists package_prices_pausa on public.package_prices;
create trigger package_prices_pausa before insert or update or delete on public.package_prices
  for each row execute function private.block_if_paused();

alter table public.package_prices enable row level security;
drop policy if exists "miembros leen paquetes fijos" on public.package_prices;
create policy "miembros leen paquetes fijos" on public.package_prices for select to authenticated
  using (private.is_member(workspace_id));
drop policy if exists "administradores crean paquetes fijos" on public.package_prices;
create policy "administradores crean paquetes fijos" on public.package_prices for insert to authenticated
  with check (private.has_role(workspace_id, array['propietario','administrador']));
drop policy if exists "administradores cambian paquetes fijos" on public.package_prices;
create policy "administradores cambian paquetes fijos" on public.package_prices for update to authenticated
  using (private.has_role(workspace_id, array['propietario','administrador']))
  with check (private.has_role(workspace_id, array['propietario','administrador']));
revoke all on public.package_prices from anon, authenticated;
grant select on public.package_prices to authenticated;
grant insert (workspace_id, space_kind, days, price, extra_day_price, valid_from, valid_to) on public.package_prices to authenticated;
grant update (price, extra_day_price, valid_from, valid_to, active, version) on public.package_prices to authenticated;

create or replace function private.compute_quote(
  p_workspace_id uuid, p_start date, p_end date, p_segments jsonb, p_options jsonb
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_opts jsonb := coalesce(p_options, '{}'::jsonb);
  v_seg jsonb;
  v_space public.spaces%rowtype;
  v_d date;
  v_period_end date;
  v_half smallint;
  v_price numeric(14,2);
  v_rate public.rates%rowtype;
  v_days integer;
  v_charges jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_discounts jsonb := '[]'::jsonb;
  v_base numeric(14,2) := 0;
  v_cur numeric(14,2);
  v_amt numeric(14,2);
  v_pct numeric(5,2);
  v_total_days integer := p_end - p_start + 1;
  v_agreement public.agreements%rowtype;
  v_ws public.workspaces%rowtype;
  v_manual jsonb := v_opts -> 'manual';
  v_courtesy boolean := coalesce((v_opts ->> 'courtesy')::boolean, false);
  v_mode text;
  v_cap numeric(14,2);
  v_excess numeric(14,2);
  v_new jsonb;
  v_i integer;
  v_capped boolean := false;
  v_cands jsonb := '[]'::jsonb;
  v_best jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_c jsonb;
  v_month_names text[] := array['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  v_kind text;
  v_pack public.package_prices%rowtype;
  v_fixed boolean := false;
  v_extra integer;
begin
  select * into v_ws from public.workspaces where id = p_workspace_id;
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'Revisá las fechas: la salida no puede ser anterior a la entrada.';
  end if;

  if v_opts ? 'manual_base' and (v_opts ->> 'manual_base') is not null then
    -- Precio manual acordado (solo administradores)
    if not private.has_role(p_workspace_id, array['propietario','administrador']) then
      raise exception 'Solo un administrador puede fijar un precio manual.' using errcode = '42501';
    end if;
    v_base := floor((v_opts ->> 'manual_base')::numeric);
    if v_base < 0 then
      raise exception 'El precio manual no puede ser negativo.';
    end if;
    v_charges := jsonb_build_array(jsonb_build_object(
      'description', 'Precio manual acordado', 'start_date', p_start, 'end_date', p_end,
      'days', v_total_days, 'amount', v_base, 'is_manual', true));
  else
    -- Paquete con precio fijo (Descuentos y convenios): el mayor paquete que entra en la estadía,
    -- vigente en la fecha de entrada, para el tipo de espacio. Los días que pasan se cobran al precio de día extra.
    select sp.kind into v_kind from public.spaces sp
     where sp.workspace_id = p_workspace_id
       and sp.id = (select (e ->> 'space_id')::uuid from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) e
                    order by (e ->> 'start_date') limit 1);
    if v_kind is not null and not exists (
         select 1 from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) e
         join public.spaces sp on sp.id = (e ->> 'space_id')::uuid where sp.kind <> v_kind) then
      select * into v_pack from public.package_prices
       where workspace_id = p_workspace_id and active and space_kind = v_kind and days <= v_total_days
         and (valid_from is null or p_start >= valid_from) and (valid_to is null or p_start <= valid_to)
       order by days desc, valid_from desc nulls last limit 1;
      v_fixed := found;
    end if;
  end if;
  if v_fixed then
    v_extra := v_total_days - v_pack.days;
    v_charges := jsonb_build_array(jsonb_build_object(
      'description', format('Paquete %s %s · %s', v_pack.days, case when v_pack.days = 1 then 'día' else 'días' end,
                            case v_kind when 'carpa' then 'carpa' else 'sombrilla' end),
      'space_kind', v_kind, 'start_date', p_start, 'end_date', p_start + v_pack.days - 1,
      'days', v_pack.days, 'unit_price', v_pack.price, 'amount', v_pack.price, 'is_manual', false,
      'rate_snapshot', jsonb_build_object('package_price_id', v_pack.id, 'days', v_pack.days, 'price', v_pack.price,
                                          'extra_day_price', v_pack.extra_day_price,
                                          'valid_from', v_pack.valid_from, 'valid_to', v_pack.valid_to)));
    v_base := v_pack.price;
    if v_extra > 0 then
      v_charges := v_charges || jsonb_build_object(
        'description', format('%s %s extra × %s', v_extra, case when v_extra = 1 then 'día' else 'días' end, private.ars(v_pack.extra_day_price)),
        'space_kind', v_kind, 'start_date', p_start + v_pack.days, 'end_date', p_end,
        'days', v_extra, 'unit_price', v_pack.extra_day_price, 'amount', v_pack.extra_day_price * v_extra, 'is_manual', false,
        'rate_snapshot', jsonb_build_object('package_price_id', v_pack.id, 'extra_day_price', v_pack.extra_day_price));
      v_base := v_base + v_pack.extra_day_price * v_extra;
    end if;
  elsif not (v_opts ? 'manual_base' and (v_opts ->> 'manual_base') is not null) then
    for v_seg in select * from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) order by (value ->> 'start_date') loop
      select * into v_space from public.spaces where id = (v_seg ->> 'space_id')::uuid and workspace_id = p_workspace_id;
      if not found then
        raise exception 'Uno de los espacios elegidos no existe.';
      end if;
      v_d := (v_seg ->> 'start_date')::date;
      while v_d <= (v_seg ->> 'end_date')::date loop
        v_half := case when extract(day from v_d) <= 15 then 1 else 2 end;
        v_period_end := least((v_seg ->> 'end_date')::date,
          case when v_half = 1 then make_date(extract(year from v_d)::int, extract(month from v_d)::int, 15)
               else (date_trunc('month', v_d) + interval '1 month - 1 day')::date end);
        v_days := v_period_end - v_d + 1;
        select * into v_rate from public.rates
        where workspace_id = p_workspace_id and space_kind = v_space.kind
          and year = extract(year from v_d)::int and month = extract(month from v_d)::int and half = v_half;
        if not found then
          v_missing := v_missing || jsonb_build_object('space_kind', v_space.kind, 'year', extract(year from v_d)::int,
                         'month', extract(month from v_d)::int, 'half', v_half);
        else
          v_charges := v_charges || jsonb_build_object(
            'description', format('%s · %s al %s · %s %s × %s', private.space_label(v_space.kind, v_space.code),
                                  to_char(v_d, 'DD/MM'), to_char(v_period_end, 'DD/MM'), v_days,
                                  case when v_days = 1 then 'día' else 'días' end,
                                  private.ars(v_rate.daily_price)),
            'space_id', v_space.id, 'space_kind', v_space.kind, 'start_date', v_d, 'end_date', v_period_end,
            'days', v_days, 'unit_price', v_rate.daily_price, 'amount', v_rate.daily_price * v_days, 'is_manual', false,
            'rate_snapshot', jsonb_build_object('rate_id', v_rate.id, 'season', v_rate.season, 'year', v_rate.year,
                             'month', v_rate.month, 'half', v_rate.half, 'daily_price', v_rate.daily_price,
                             'periodo', (case v_half when 1 then '1ª' else '2ª' end) || ' quincena de '
                                        || v_month_names[v_rate.month] || ' ' || v_rate.year));
          v_base := v_base + v_rate.daily_price * v_days;
        end if;
        v_d := v_period_end + 1;
      end loop;
    end loop;
  end if;

  v_cur := v_base;
  v_mode := coalesce(v_ws.discount_mode, 'cascada');
  if not v_courtesy then
    -- Descuentos automáticos que corresponden (paquete, convenio, efectivo), en este orden.
    -- 2. Paquete por cantidad de días
    -- (con un paquete de precio fijo no se suma además el paquete en %)
    select percent into v_pct from public.package_discounts
    where workspace_id = p_workspace_id and active and min_days <= v_total_days and not v_fixed
    order by min_days desc limit 1;
    if found and v_base > 0 then
      v_cands := v_cands || jsonb_build_object('kind', 'paquete', 'percent', v_pct,
                   'label', format('Paquete %s días (%s%%)', v_total_days, to_char(v_pct, 'FM990D##')));
    end if;

    -- 3. Convenio
    if (v_opts ->> 'agreement_id') is not null then
      select * into v_agreement from public.agreements
      where id = (v_opts ->> 'agreement_id')::uuid and workspace_id = p_workspace_id;
      if not found or not v_agreement.active or v_agreement.deleted_at is not null
         or (v_agreement.valid_from is not null and p_start < v_agreement.valid_from)
         or (v_agreement.valid_to is not null and p_start > v_agreement.valid_to) then
        raise exception 'El convenio elegido no está vigente para esas fechas.';
      end if;
      v_cands := v_cands || jsonb_build_object('kind', 'convenio', 'agreement_id', v_agreement.id, 'percent', v_agreement.percent,
                   'label', 'Convenio ' || v_agreement.name);
    end if;

    -- 4. Pago en efectivo
    if coalesce((v_opts ->> 'cash')::boolean, false) and v_ws.cash_discount_percent > 0 then
      v_cands := v_cands || jsonb_build_object('kind', 'efectivo', 'percent', v_ws.cash_discount_percent, 'label', 'Pago en efectivo');
    end if;

    -- Cómo se combinan (lo decide cada balneario en Convenios y descuentos):
    --   cascada: cada uno sobre lo que queda · sumados: cada uno sobre el precio base ·
    --   mayor: no acumulables, se aplica solo el de mayor porcentaje.
    if v_mode = 'mayor' and jsonb_array_length(v_cands) > 1 then
      select c into v_best from jsonb_array_elements(v_cands) with ordinality as t(c, n)
      order by (c ->> 'percent')::numeric desc, n limit 1;
      select coalesce(jsonb_agg(c), '[]'::jsonb) into v_skipped from jsonb_array_elements(v_cands) with ordinality as t(c, n)
      where c is distinct from v_best;
      v_cands := jsonb_build_array(v_best);
    end if;
    for v_c in select * from jsonb_array_elements(v_cands) loop
      v_pct := (v_c ->> 'percent')::numeric;
      v_amt := least(floor((case when v_mode = 'sumados' then v_base else v_cur end) * v_pct / 100), v_cur);
      v_discounts := v_discounts || (v_c - 'label' || jsonb_build_object('amount', v_amt)
                     || case when v_c ->> 'kind' = 'paquete' then jsonb_build_object('label', v_c ->> 'label') else '{}'::jsonb end);
      v_cur := v_cur - v_amt;
    end loop;

    -- 5. Descuento manual (decisión del administrador: se aplica siempre, al final)
    if v_manual is not null and coalesce((v_manual ->> 'value')::numeric, 0) > 0 then
      if char_length(btrim(coalesce(v_manual ->> 'reason', ''))) < 3 then
        raise exception 'Los descuentos manuales necesitan un motivo.';
      end if;
      if v_manual ->> 'type' = 'porcentaje' then
        v_pct := (v_manual ->> 'value')::numeric;
        if v_pct > 100 then
          raise exception 'El porcentaje no puede superar 100.';
        end if;
        v_amt := least(floor((case when v_mode = 'sumados' then v_base else v_cur end) * v_pct / 100), v_cur);
      else
        v_pct := null;
        v_amt := least(floor((v_manual ->> 'value')::numeric), v_cur);
      end if;
      v_discounts := v_discounts || jsonb_build_object('kind', 'manual', 'percent', v_pct, 'amount', v_amt,
                       'reason', btrim(v_manual ->> 'reason'));
      v_cur := v_cur - v_amt;
    end if;
  end if;

  -- Tope de descuento del balneario: el total de descuentos no pasa de ese % del precio base.
  -- Si se pasa, se recorta desde el último descuento hacia atrás (primero el manual).
  if not v_courtesy and v_ws.discount_cap_percent is not null and v_base > 0 then
    v_cap := floor(v_base * v_ws.discount_cap_percent / 100);
    v_excess := (v_base - v_cur) - v_cap;
    if v_excess > 0 then
      v_new := '[]'::jsonb;
      for v_i in reverse jsonb_array_length(v_discounts) - 1 .. 0 loop
        v_c := v_discounts -> v_i;
        v_amt := least((v_c ->> 'amount')::numeric, v_excess);
        v_excess := v_excess - v_amt;
        v_c := jsonb_set(v_c, '{amount}', to_jsonb((v_c ->> 'amount')::numeric - v_amt));
        if (v_c ->> 'amount')::numeric > 0 then
          v_new := jsonb_build_array(v_c) || v_new;
        end if;
      end loop;
      v_discounts := v_new;
      v_cur := v_base - v_cap;
      v_capped := true;
    end if;
  end if;

  return jsonb_build_object(
    'ok', jsonb_array_length(v_missing) = 0,
    'faltan_tarifas', v_missing,
    'charges', v_charges,
    'dias', v_total_days,
    'precio_base', v_base,
    'discounts', v_discounts,
    'cortesia', v_courtesy,
    'total', case when v_courtesy then 0 else v_cur end,
    'modo_descuentos', v_mode,
    'no_aplicados', v_skipped,
    'tope', v_ws.discount_cap_percent,
    'tope_aplicado', v_capped,
    'paquete_fijo', v_fixed
  );
end $$;

-- Las copias de seguridad incluyen los paquetes con precio fijo.
create or replace function private.snapshot(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb := '{}'::jsonb;
  t text;
  v_rows jsonb;
begin
  foreach t in array array[
    'spaces','map_features','customers','agreements','expense_categories','package_discounts','package_prices','rates','extras',
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
  select array['spaces','map_features','customers','agreements','expense_categories','package_discounts','package_prices','rates','extras',
               'reservations','reservation_changes','reservation_segments','reservation_charges','reservation_discounts','reservation_extras',
               'maintenance_blocks','cash_sessions','payments','expenses','cash_movements','restaurant_vouchers','day_notes',
               'renewal_marks']
$$;

-- 0048 · Cobro en dólares en reservas de grupo y "todo el saldo" en dólares.
--
-- · Una reserva de grupo (varias carpas) ahora acepta seña o pago completo en dólares:
--   se reparte entre las carpas al centavo de dólar.
-- · Corrección: al pagar "todo el saldo" en dólares, si por el redondeo la cuenta daba unos centavos
--   de más (menos de un centavo de dólar), se rechazaba; ahora se toma justo el saldo, como estaba previsto.

create or replace function private.record_payment(
  p_workspace_id uuid, p_reservation_id uuid, p_kind text, p_amount numeric, p_method text,
  p_idempotency_key uuid, p_note text, p_reason text, p_voids_payment_id uuid default null,
  p_usd numeric default null, p_rate numeric default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.payments%rowtype;
  v_res public.reservations%rowtype;
  v_orig public.payments%rowtype;
  v_session uuid;
  v_paid numeric(14,2);
  v_signed numeric(14,2);
  v_amount numeric(14,2) := round(p_amount, 2);
  v_id uuid;
  v_category text;
  v_concept text;
  v_usd numeric(14,2);
  v_rate numeric(14,4);
  v_code text;
begin
  -- Dólares: monto en dólares y cotización. Desde Nueva reserva llegan por la sesión (ver create_reservation_v2).
  if p_method = 'dolares' then
    v_usd := round(coalesce(p_usd, nullif(current_setting('app.pay_usd', true), '')::numeric), 2);
    v_rate := round(coalesce(p_rate, nullif(current_setting('app.pay_rate', true), '')::numeric), 4);
    if v_usd is null or v_usd <= 0 or v_rate is null or v_rate <= 0 then
      raise exception 'Para cobrar en dólares indicá el monto en dólares y la cotización.';
    end if;
    v_amount := round(v_usd * v_rate, 2);
  end if;

  if p_idempotency_key is null then
    raise exception 'Falta la clave de operación.';
  end if;

  select * into v_existing from public.payments
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.reservation_id <> p_reservation_id or v_existing.kind <> p_kind
       or (p_kind <> 'anulacion' and (v_existing.amount <> v_amount or v_existing.method <> p_method)) then
      raise exception 'Esta operación ya fue registrada con otros datos.';
    end if;
    return v_existing.id;
  end if;

  v_session := private.today_session(p_workspace_id);

  -- Bloquea la reserva: dos pagos simultáneos se procesan de a uno.
  select * into v_res from public.reservations
  where id = p_reservation_id and workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'La reserva no existe.';
  end if;

  -- Reintento simultáneo con la misma clave: el otro ya terminó.
  select * into v_existing from public.payments
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return v_existing.id;
  end if;

  select coalesce(sum(signed_amount), 0) into v_paid from public.payments where reservation_id = p_reservation_id;

  if p_kind = 'cobro' then
    if v_res.status = 'cancelada' then
      raise exception 'No se pueden registrar cobros en una reserva cancelada.';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'El importe debe ser mayor a cero.';
    end if;
    if p_method = 'dolares' and v_amount > v_res.total_amount - v_paid and v_amount - (v_res.total_amount - v_paid) < greatest(1, v_rate * 0.01) then
      v_amount := v_res.total_amount - v_paid;  -- "todo el saldo": diferencia menor a un centavo de dólar
    end if;
    if v_amount > v_res.total_amount - v_paid then
      raise exception 'El cobro (%) supera el saldo pendiente (%).',
        private.ars(v_amount), private.ars(greatest(v_res.total_amount - v_paid, 0));
    end if;
    if p_method = 'voucher' then
      raise exception 'El voucher del restaurante solo se usa para devoluciones.';
    end if;
    v_signed := v_amount;
    v_category := 'cobro';
    v_concept := format('Cobro reserva #%s', v_res.number);

  elsif p_kind = 'devolucion' then
    if p_method not in ('efectivo', 'voucher') then
      raise exception 'Las devoluciones se hacen en efectivo o con un voucher para el restaurante.';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'El importe debe ser mayor a cero.';
    end if;
    if v_amount > v_paid then
      raise exception 'La devolución supera lo cobrado en la reserva.';
    end if;
    v_signed := -v_amount;
    v_category := 'devolucion';
    v_concept := format('Devolución reserva #%s', v_res.number);

  elsif p_kind = 'anulacion' then
    select * into v_orig from public.payments
    where id = p_voids_payment_id and reservation_id = p_reservation_id;
    if not found then
      raise exception 'El pago a anular no existe en esta reserva.';
    end if;
    if v_orig.kind = 'anulacion' then
      raise exception 'Una anulación no se puede anular.';
    end if;
    if exists (select 1 from public.payments where voids_payment_id = v_orig.id) then
      raise exception 'Ese pago ya fue anulado.';
    end if;
    if v_orig.method = 'voucher' and exists (select 1 from public.restaurant_vouchers
                                              where payment_id = v_orig.id and status = 'usado') then
      raise exception 'Ese voucher ya se usó en el restaurante; no se puede anular.';
    end if;
    v_amount := v_orig.amount;
    p_method := v_orig.method;
    v_usd := v_orig.usd_amount;
    v_rate := v_orig.exchange_rate;
    v_signed := -v_orig.signed_amount;
    v_category := case v_orig.kind when 'cobro' then 'anulacion_cobro' else 'anulacion_devolucion' end;
    v_concept := format('Anulación de %s · reserva #%s', v_orig.kind, v_res.number);
  else
    raise exception 'Tipo de pago inválido.';
  end if;

  if p_method is null or not private.valid_payment_method(p_method) then
    raise exception 'Medio de pago inválido.';
  end if;

  insert into public.payments (workspace_id, reservation_id, kind, amount, signed_amount, method,
                               voids_payment_id, cash_session_id, idempotency_key, note, reason, usd_amount, exchange_rate)
  values (p_workspace_id, p_reservation_id, p_kind, v_amount, v_signed, p_method,
          p_voids_payment_id, v_session, p_idempotency_key, nullif(btrim(p_note), ''), nullif(btrim(p_reason), ''),
          case when p_method = 'dolares' then v_usd end, case when p_method = 'dolares' then v_rate end)
  returning id into v_id;

  if p_method = 'voucher' then
    -- El voucher no es dinero de la caja: no genera movimiento de caja.
    if p_kind = 'devolucion' then
      loop
        v_code := 'V-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
        exit when not exists (select 1 from public.restaurant_vouchers where workspace_id = p_workspace_id and code = v_code);
      end loop;
      insert into public.restaurant_vouchers (workspace_id, code, payment_id, reservation_id, customer_id, amount)
      values (p_workspace_id, v_code, v_id, p_reservation_id, v_res.customer_id, v_amount);
    else
      update public.restaurant_vouchers set status = 'anulado', version = version + 1 where payment_id = p_voids_payment_id;
    end if;
  else
    insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, payment_id, usd_amount)
    values (p_workspace_id, v_session, case when v_signed > 0 then 'entrada' else 'salida' end,
            p_method, v_amount, v_category,
            v_concept || case when p_method = 'dolares' then format(' · US$ %s a $ %s', v_usd, v_rate) else '' end,
            v_id, case when p_method = 'dolares' then v_usd end);
  end if;

  return v_id;
end $$;

create or replace function public.create_reservation_group(
  p_workspace_id uuid, p_request_id uuid, p_customer_id uuid, p_start_date date, p_end_date date,
  p_segments jsonb, p_extra_spaces uuid[] default '{}', p_options jsonb default '{}'::jsonb, p_notes text default null,
  p_payment jsonb default null, p_extras jsonb default '[]'::jsonb, p_people integer default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.reservations%rowtype;
  v_extra uuid[] := coalesce(p_extra_spaces, '{}');
  v_n integer;
  v_group uuid;
  v_main jsonb;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_opts jsonb;
  v_i integer;
  v_left numeric;
  v_pay numeric;
  v_due numeric;
  v_people integer;
  v_usd_left numeric;
  v_rate numeric;
  v_usd numeric;
  v_paid_now numeric;
begin
  perform private.require_member(p_workspace_id);
  -- Reintento (doble clic, recarga): devuelve lo que ya se guardó.
  select * into v_existing from public.reservations where workspace_id = p_workspace_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('reservation_id', v_existing.id, 'number', v_existing.number, 'group_id', v_existing.group_id, 'repetida', true);
  end if;
  if p_people is not null and (p_people < 1 or p_people > 500) then raise exception 'La cantidad de personas tiene que ser entre 1 y 500.'; end if;
  if array_length(v_extra, 1) > 9 then raise exception 'Un grupo puede tener hasta 10 espacios.'; end if;
  if (select count(distinct e.sid) from unnest(v_extra) as e(sid)) <> coalesce(array_length(v_extra, 1), 0) then
    raise exception 'Hay espacios repetidos en el grupo.';
  end if;
  if exists (select 1 from unnest(v_extra) as e(sid), jsonb_array_elements(p_segments) s where (s ->> 'space_id')::uuid = e.sid) then
    raise exception 'Un espacio del grupo es el mismo que el principal.';
  end if;
  if exists (select 1 from unnest(v_extra) as e(sid) where not exists (select 1 from public.spaces sp where sp.id = e.sid and sp.workspace_id = p_workspace_id and sp.active)) then
    raise exception 'Uno de los espacios del grupo no existe o está desactivado.';
  end if;

  v_n := 1 + coalesce(array_length(v_extra, 1), 0);
  v_group := case when v_n > 1 then gen_random_uuid() end;

  -- Principal (con sus tramos, extras y opciones de precio tal cual)
  v_main := public.create_reservation_v3(p_workspace_id, p_request_id, p_customer_id, p_start_date, p_end_date,
                                          p_segments, p_options, p_notes, null, p_extras);
  v_ids := array_append(v_ids, (v_main ->> 'reservation_id')::uuid);

  -- Las demás carpas del grupo: toda la estadía, mismo precio y descuentos.
  -- Un descuento manual en pesos se aplica una sola vez (en la principal), no en cada carpa.
  v_opts := case when p_options -> 'manual' ->> 'type' = 'monto' then p_options - 'manual' else p_options end;
  for v_i in 1 .. v_n - 1 loop
    v_id := (public.create_reservation_v3(
      p_workspace_id, md5(p_request_id::text || ':grupo:' || v_i)::uuid, p_customer_id, p_start_date, p_end_date,
      jsonb_build_array(jsonb_build_object('space_id', v_extra[v_i], 'start_date', p_start_date, 'end_date', p_end_date)),
      v_opts, p_notes, null, '[]'::jsonb) ->> 'reservation_id')::uuid;
    v_ids := array_append(v_ids, v_id);
  end loop;

  -- Personas repartidas entre las carpas (la principal se lleva el resto) y el grupo.
  for v_i in 1 .. v_n loop
    v_people := case when p_people is null then null
                     else (p_people / v_n) + case when v_i <= p_people % v_n then 1 else 0 end end;
    if v_people = 0 then v_people := null; end if;
    update public.reservations set people = v_people, group_id = v_group, version = version + 1
     where id = v_ids[v_i] and (people is distinct from v_people or group_id is distinct from v_group);
  end loop;

  -- Cobro: se reparte en orden, completando cada carpa antes de pasar a la siguiente.
  if p_payment is not null then
    if v_n = 1 then
      if nullif(p_payment ->> 'usd_amount', '') is not null then
        perform public.register_payment_usd(p_workspace_id, v_ids[1], (p_payment ->> 'usd_amount')::numeric, (p_payment ->> 'exchange_rate')::numeric,
                                            (p_payment ->> 'idempotency_key')::uuid, null);
      else
        perform public.register_payment(p_workspace_id, v_ids[1], (p_payment ->> 'amount')::numeric, p_payment ->> 'method',
                                        (p_payment ->> 'idempotency_key')::uuid, null);
      end if;
    elsif nullif(p_payment ->> 'usd_amount', '') is not null then
      -- Dólares en un grupo: se reparten en orden, cada carpa recibe los dólares que cubren su saldo
      -- (redondeado al centavo de dólar) y la última se lleva lo que queda.
      v_usd_left := round((p_payment ->> 'usd_amount')::numeric, 2);
      v_rate := (p_payment ->> 'exchange_rate')::numeric;
      if v_usd_left is null or v_usd_left <= 0 or v_rate is null or v_rate <= 0 then raise exception 'Ingresá los dólares y la cotización.'; end if;
      for v_i in 1 .. v_n loop
        exit when v_usd_left <= 0;
        select r.total_amount - coalesce((select sum(signed_amount) from public.payments p where p.reservation_id = r.id), 0)
          into v_due from public.reservations r where r.id = v_ids[v_i];
        continue when v_due <= 0;
        v_usd := case when v_i = v_n then v_usd_left else least(v_usd_left, ceil(v_due / v_rate * 100) / 100) end;
        perform public.register_payment_usd(p_workspace_id, v_ids[v_i], v_usd, v_rate,
                                            case when v_i = 1 then (p_payment ->> 'idempotency_key')::uuid
                                                 else md5((p_payment ->> 'idempotency_key') || ':grupo:' || v_i)::uuid end, null);
        v_usd_left := v_usd_left - v_usd;
      end loop;
      if v_usd_left > 0.009 then raise exception 'Los dólares superan el total del grupo.'; end if;
    else
      v_left := (p_payment ->> 'amount')::numeric;
      if v_left is null or v_left <= 0 then raise exception 'Importe del cobro inválido.'; end if;
      for v_i in 1 .. v_n loop
        exit when v_left <= 0;
        select total_amount into v_due from public.reservations where id = v_ids[v_i];
        v_pay := least(v_left, v_due);
        if v_pay > 0 then
          perform public.register_payment(p_workspace_id, v_ids[v_i], v_pay, p_payment ->> 'method',
                                          case when v_i = 1 then (p_payment ->> 'idempotency_key')::uuid
                                               else md5((p_payment ->> 'idempotency_key') || ':grupo:' || v_i)::uuid end, null);
          v_left := v_left - v_pay;
        end if;
      end loop;
      if v_left > 0.009 then raise exception 'El cobro supera el total del grupo.'; end if;
    end if;
  end if;

  return v_main || jsonb_build_object(
    'group_id', v_group,
    'reservations', (select jsonb_agg(jsonb_build_object('id', r.id, 'number', r.number) order by r.number)
                       from public.reservations r where r.id = any(v_ids)),
    'total_amount', (select sum(total_amount) from public.reservations where id = any(v_ids)));
end $$;

-- 0049 · Redondeo del total en Nueva reserva (a $500 hacia abajo: $400.040 → $400.000, $23.730 → $23.500).
-- Es opcional en cada reserva y queda guardado como un descuento más ("Redondeo"), así los informes cuadran.

alter table public.reservation_discounts drop constraint if exists reservation_discounts_kind_check;
alter table public.reservation_discounts add constraint reservation_discounts_kind_check
  check (kind in ('paquete','efectivo','convenio','manual','cortesia','redondeo'));

-- Alta de la reserva: acepta el descuento "Redondeo".
create or replace function private.create_reservation(
  p_workspace_id uuid,
  p_request_id uuid,
  p_customer_id uuid,
  p_start_date date,
  p_end_date date,
  p_segments jsonb,
  p_charges jsonb,
  p_discounts jsonb default '[]'::jsonb,
  p_is_courtesy boolean default false,
  p_notes text default null,
  p_payment jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.reservations%rowtype;
  v_res_id uuid := gen_random_uuid();
  v_change_id uuid := gen_random_uuid();
  v_number bigint;
  v_list numeric(14,2) := 0;
  v_discount numeric(14,2) := 0;
  v_total numeric(14,2);
  v_seg jsonb;
  v_item jsonb;
  v_pos integer := 0;
  v_conflict text;
  v_space_ids uuid[];
  v_agreement public.agreements%rowtype;
  v_payment_id uuid;
  v_kind text;
  v_amount numeric(14,2);
  v_label text;
  v_percent numeric(5,2);
begin
  perform private.require_member(p_workspace_id);

  -- Reintento (doble clic, recarga, red lenta): devuelve la misma reserva.
  select * into v_existing from public.reservations
  where workspace_id = p_workspace_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('reservation_id', v_existing.id, 'number', v_existing.number, 'repetida', true);
  end if;

  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'Revisá las fechas: la salida no puede ser anterior a la entrada.';
  end if;
  if not exists (select 1 from public.customers c where c.id = p_customer_id and c.workspace_id = p_workspace_id) then
    raise exception 'Elegí un cliente válido.';
  end if;
  if p_segments is null or jsonb_typeof(p_segments) <> 'array' or jsonb_array_length(p_segments) = 0 then
    raise exception 'Asigná al menos una carpa o sombrilla.';
  end if;
  if p_charges is null or jsonb_typeof(p_charges) <> 'array' then
    raise exception 'Falta el detalle de precio.';
  end if;
  p_discounts := coalesce(p_discounts, '[]'::jsonb);

  -- Cada tramo dentro de la estadía y sin días repetidos entre tramos.
  if exists (select 1 from jsonb_array_elements(p_segments) s
             where (s ->> 'start_date') is null or (s ->> 'end_date') is null or (s ->> 'space_id') is null
                or (s ->> 'end_date')::date < (s ->> 'start_date')::date
                or (s ->> 'start_date')::date < p_start_date or (s ->> 'end_date')::date > p_end_date) then
    raise exception 'Cada tramo de carpa tiene que estar dentro de las fechas de la estadía.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_segments) with ordinality a(s, i)
             join jsonb_array_elements(p_segments) with ordinality b(s, j) on a.i < b.j
             where daterange((a.s ->> 'start_date')::date, (a.s ->> 'end_date')::date, '[]')
                && daterange((b.s ->> 'start_date')::date, (b.s ->> 'end_date')::date, '[]')) then
    raise exception 'Los tramos de carpa se superponen: un cliente no puede tener dos carpas el mismo día.';
  end if;

  -- Bloquea todos los espacios involucrados (en orden, para evitar bloqueos cruzados)
  select array_agg((s ->> 'space_id')::uuid) into v_space_ids from jsonb_array_elements(p_segments) s;
  perform private.lock_spaces(v_space_ids);

  -- Revalida la disponibilidad al guardar, con el detalle de cada conflicto.
  for v_seg in select * from jsonb_array_elements(p_segments) loop
    if not exists (select 1 from public.spaces sp where sp.id = (v_seg ->> 'space_id')::uuid
                   and sp.workspace_id = p_workspace_id) then
      raise exception 'Uno de los espacios elegidos no existe.';
    end if;
    v_conflict := private.space_conflict((v_seg ->> 'space_id')::uuid,
                                         (v_seg ->> 'start_date')::date, (v_seg ->> 'end_date')::date);
    if v_conflict is not null then
      raise exception 'Ya no está disponible: %', v_conflict using errcode = '23P01', hint = 'CONFLICTO_DISPONIBILIDAD';
    end if;
  end loop;

  -- Precio de lista
  for v_item in select * from jsonb_array_elements(p_charges) loop
    v_amount := round((v_item ->> 'amount')::numeric, 2);
    if v_amount is null or v_amount < 0 then
      raise exception 'Hay un importe inválido en el detalle de precio.';
    end if;
    v_list := v_list + v_amount;
  end loop;

  -- Descuentos (cada uno queda registrado con su importe, motivo y responsable)
  for v_item in select * from jsonb_array_elements(p_discounts) loop
    v_kind := v_item ->> 'kind';
    v_amount := round((v_item ->> 'amount')::numeric, 2);
    if v_amount is null or v_amount < 0 then
      raise exception 'Hay un descuento con importe inválido.';
    end if;
    if v_kind = 'cortesia' then
      raise exception 'La cortesía se indica marcando la reserva como cortesía, no como descuento.';
    elsif v_kind = 'convenio' then
      select * into v_agreement from public.agreements
      where id = (v_item ->> 'agreement_id')::uuid and workspace_id = p_workspace_id;
      if not found or not v_agreement.active then
        raise exception 'El convenio elegido no está vigente.';
      end if;
    elsif v_kind = 'manual' then
      if not private.has_role(p_workspace_id, array['propietario','administrador']) then
        raise exception 'Solo un administrador puede aplicar descuentos manuales.' using errcode = '42501';
      end if;
      if char_length(btrim(coalesce(v_item ->> 'reason', ''))) < 3 then
        raise exception 'Los descuentos manuales necesitan un motivo.';
      end if;
    elsif v_kind not in ('efectivo','paquete','redondeo') then
      raise exception 'Tipo de descuento inválido.';
    end if;
    v_discount := v_discount + v_amount;
  end loop;

  if p_is_courtesy then
    if jsonb_array_length(p_discounts) > 0 then
      raise exception 'Una cortesía no lleva otros descuentos.';
    end if;
    if p_payment is not null then
      raise exception 'Una cortesía no genera cobros.';
    end if;
    v_discount := v_list;
  end if;

  if v_discount > v_list then
    raise exception 'Los descuentos superan el precio.';
  end if;
  v_total := v_list - v_discount;

  insert into public.reservations (id, workspace_id, customer_id, start_date, end_date, is_courtesy,
                                   list_amount, discount_amount, total_amount, notes, request_id, created_by)
  values (v_res_id, p_workspace_id, p_customer_id, p_start_date, p_end_date, coalesce(p_is_courtesy, false),
          v_list, v_discount, v_total, nullif(btrim(p_notes), ''), p_request_id, auth.uid())
  returning number into v_number;

  insert into public.reservation_changes (id, workspace_id, reservation_id, kind, description)
  values (v_change_id, p_workspace_id, v_res_id, 'creacion', format('Reserva #%s creada', v_number));

  for v_seg in select * from jsonb_array_elements(p_segments) loop
    insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
    values (p_workspace_id, v_res_id, (v_seg ->> 'space_id')::uuid,
            (v_seg ->> 'start_date')::date, (v_seg ->> 'end_date')::date, v_change_id);
  end loop;
  perform private.assert_coverage(v_res_id);

  v_pos := 0;
  for v_item in select * from jsonb_array_elements(p_charges) loop
    v_pos := v_pos + 1;
    insert into public.reservation_charges (workspace_id, reservation_id, position, description, space_kind,
                                            start_date, end_date, days, unit_price, amount, is_manual, rate_snapshot)
    values (p_workspace_id, v_res_id, v_pos,
            coalesce(nullif(btrim(v_item ->> 'description'), ''), 'Alquiler'),
            v_item ->> 'space_kind',
            (v_item ->> 'start_date')::date, (v_item ->> 'end_date')::date,
            (v_item ->> 'days')::integer,
            round((v_item ->> 'unit_price')::numeric, 2),
            round((v_item ->> 'amount')::numeric, 2),
            coalesce((v_item ->> 'is_manual')::boolean, false),
            v_item -> 'rate_snapshot');
  end loop;

  v_pos := 0;
  if p_is_courtesy then
    insert into public.reservation_discounts (workspace_id, reservation_id, position, kind, label, percent, amount, reason)
    values (p_workspace_id, v_res_id, 1, 'cortesia', 'Cortesía familiar', 100, v_list, 'Cortesía familiar');
  else
    for v_item in select * from jsonb_array_elements(p_discounts) loop
      v_pos := v_pos + 1;
      v_kind := v_item ->> 'kind';
      v_percent := (v_item ->> 'percent')::numeric;
      v_label := case v_kind when 'efectivo' then 'Pago en efectivo' when 'manual' then 'Descuento manual'
                     when 'paquete' then coalesce(nullif(v_item ->> 'label', ''), 'Descuento por paquete') when 'redondeo' then 'Redondeo' else null end;
      if v_kind = 'convenio' then
        select * into v_agreement from public.agreements where id = (v_item ->> 'agreement_id')::uuid;
        v_label := 'Convenio ' || v_agreement.name;
        v_percent := v_agreement.percent;
      end if;
      insert into public.reservation_discounts (workspace_id, reservation_id, position, kind, agreement_id,
                                                label, percent, amount, reason)
      values (p_workspace_id, v_res_id, v_pos, v_kind,
              case when v_kind = 'convenio' then v_agreement.id end,
              v_label, v_percent, round((v_item ->> 'amount')::numeric, 2),
              nullif(btrim(v_item ->> 'reason'), ''));
    end loop;
  end if;

  if p_payment is not null then
    if coalesce((p_payment ->> 'amount')::numeric, 0) <= 0 then
      raise exception 'Ingresá el importe cobrado (o elegí "Cobrar después").';
    end if;
    v_payment_id := private.record_payment(p_workspace_id, v_res_id, 'cobro', (p_payment ->> 'amount')::numeric,
                                           p_payment ->> 'method', (p_payment ->> 'idempotency_key')::uuid,
                                           'Pago al reservar', null);
  end if;

  update public.reservation_changes set after_state = jsonb_build_object(
    'segments', private.segments_snapshot(v_res_id), 'total_amount', v_total)
  where id = v_change_id;

  return jsonb_build_object('reservation_id', v_res_id, 'number', v_number, 'total_amount', v_total,
                            'payment_id', v_payment_id, 'repetida', false);
end $$;

create or replace function private.discount_default_label() returns trigger
language plpgsql as $$
begin
  if new.kind = 'redondeo' and new.label is null then new.label := 'Redondeo'; end if;
  return new;
end $$;
drop trigger if exists reservation_discounts_label on public.reservation_discounts;
create trigger reservation_discounts_label before insert on public.reservation_discounts
  for each row execute function private.discount_default_label();

create or replace function private.compute_quote(
  p_workspace_id uuid, p_start date, p_end date, p_segments jsonb, p_options jsonb
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_opts jsonb := coalesce(p_options, '{}'::jsonb);
  v_seg jsonb;
  v_space public.spaces%rowtype;
  v_d date;
  v_period_end date;
  v_half smallint;
  v_price numeric(14,2);
  v_rate public.rates%rowtype;
  v_days integer;
  v_charges jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_discounts jsonb := '[]'::jsonb;
  v_base numeric(14,2) := 0;
  v_cur numeric(14,2);
  v_amt numeric(14,2);
  v_pct numeric(5,2);
  v_total_days integer := p_end - p_start + 1;
  v_agreement public.agreements%rowtype;
  v_ws public.workspaces%rowtype;
  v_manual jsonb := v_opts -> 'manual';
  v_courtesy boolean := coalesce((v_opts ->> 'courtesy')::boolean, false);
  v_mode text;
  v_cap numeric(14,2);
  v_excess numeric(14,2);
  v_new jsonb;
  v_i integer;
  v_capped boolean := false;
  v_cands jsonb := '[]'::jsonb;
  v_best jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_c jsonb;
  v_month_names text[] := array['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  v_kind text;
  v_pack public.package_prices%rowtype;
  v_fixed boolean := false;
  v_extra integer;
begin
  select * into v_ws from public.workspaces where id = p_workspace_id;
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'Revisá las fechas: la salida no puede ser anterior a la entrada.';
  end if;

  if v_opts ? 'manual_base' and (v_opts ->> 'manual_base') is not null then
    -- Precio manual acordado (solo administradores)
    if not private.has_role(p_workspace_id, array['propietario','administrador']) then
      raise exception 'Solo un administrador puede fijar un precio manual.' using errcode = '42501';
    end if;
    v_base := floor((v_opts ->> 'manual_base')::numeric);
    if v_base < 0 then
      raise exception 'El precio manual no puede ser negativo.';
    end if;
    v_charges := jsonb_build_array(jsonb_build_object(
      'description', 'Precio manual acordado', 'start_date', p_start, 'end_date', p_end,
      'days', v_total_days, 'amount', v_base, 'is_manual', true));
  else
    -- Paquete con precio fijo (Descuentos y convenios): el mayor paquete que entra en la estadía,
    -- vigente en la fecha de entrada, para el tipo de espacio. Los días que pasan se cobran al precio de día extra.
    select sp.kind into v_kind from public.spaces sp
     where sp.workspace_id = p_workspace_id
       and sp.id = (select (e ->> 'space_id')::uuid from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) e
                    order by (e ->> 'start_date') limit 1);
    if v_kind is not null and not exists (
         select 1 from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) e
         join public.spaces sp on sp.id = (e ->> 'space_id')::uuid where sp.kind <> v_kind) then
      select * into v_pack from public.package_prices
       where workspace_id = p_workspace_id and active and space_kind = v_kind and days <= v_total_days
         and (valid_from is null or p_start >= valid_from) and (valid_to is null or p_start <= valid_to)
       order by days desc, valid_from desc nulls last limit 1;
      v_fixed := found;
    end if;
  end if;
  if v_fixed then
    v_extra := v_total_days - v_pack.days;
    v_charges := jsonb_build_array(jsonb_build_object(
      'description', format('Paquete %s %s · %s', v_pack.days, case when v_pack.days = 1 then 'día' else 'días' end,
                            case v_kind when 'carpa' then 'carpa' else 'sombrilla' end),
      'space_kind', v_kind, 'start_date', p_start, 'end_date', p_start + v_pack.days - 1,
      'days', v_pack.days, 'unit_price', v_pack.price, 'amount', v_pack.price, 'is_manual', false,
      'rate_snapshot', jsonb_build_object('package_price_id', v_pack.id, 'days', v_pack.days, 'price', v_pack.price,
                                          'extra_day_price', v_pack.extra_day_price,
                                          'valid_from', v_pack.valid_from, 'valid_to', v_pack.valid_to)));
    v_base := v_pack.price;
    if v_extra > 0 then
      v_charges := v_charges || jsonb_build_object(
        'description', format('%s %s extra × %s', v_extra, case when v_extra = 1 then 'día' else 'días' end, private.ars(v_pack.extra_day_price)),
        'space_kind', v_kind, 'start_date', p_start + v_pack.days, 'end_date', p_end,
        'days', v_extra, 'unit_price', v_pack.extra_day_price, 'amount', v_pack.extra_day_price * v_extra, 'is_manual', false,
        'rate_snapshot', jsonb_build_object('package_price_id', v_pack.id, 'extra_day_price', v_pack.extra_day_price));
      v_base := v_base + v_pack.extra_day_price * v_extra;
    end if;
  elsif not (v_opts ? 'manual_base' and (v_opts ->> 'manual_base') is not null) then
    for v_seg in select * from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) order by (value ->> 'start_date') loop
      select * into v_space from public.spaces where id = (v_seg ->> 'space_id')::uuid and workspace_id = p_workspace_id;
      if not found then
        raise exception 'Uno de los espacios elegidos no existe.';
      end if;
      v_d := (v_seg ->> 'start_date')::date;
      while v_d <= (v_seg ->> 'end_date')::date loop
        v_half := case when extract(day from v_d) <= 15 then 1 else 2 end;
        v_period_end := least((v_seg ->> 'end_date')::date,
          case when v_half = 1 then make_date(extract(year from v_d)::int, extract(month from v_d)::int, 15)
               else (date_trunc('month', v_d) + interval '1 month - 1 day')::date end);
        v_days := v_period_end - v_d + 1;
        select * into v_rate from public.rates
        where workspace_id = p_workspace_id and space_kind = v_space.kind
          and year = extract(year from v_d)::int and month = extract(month from v_d)::int and half = v_half;
        if not found then
          v_missing := v_missing || jsonb_build_object('space_kind', v_space.kind, 'year', extract(year from v_d)::int,
                         'month', extract(month from v_d)::int, 'half', v_half);
        else
          v_charges := v_charges || jsonb_build_object(
            'description', format('%s · %s al %s · %s %s × %s', private.space_label(v_space.kind, v_space.code),
                                  to_char(v_d, 'DD/MM'), to_char(v_period_end, 'DD/MM'), v_days,
                                  case when v_days = 1 then 'día' else 'días' end,
                                  private.ars(v_rate.daily_price)),
            'space_id', v_space.id, 'space_kind', v_space.kind, 'start_date', v_d, 'end_date', v_period_end,
            'days', v_days, 'unit_price', v_rate.daily_price, 'amount', v_rate.daily_price * v_days, 'is_manual', false,
            'rate_snapshot', jsonb_build_object('rate_id', v_rate.id, 'season', v_rate.season, 'year', v_rate.year,
                             'month', v_rate.month, 'half', v_rate.half, 'daily_price', v_rate.daily_price,
                             'periodo', (case v_half when 1 then '1ª' else '2ª' end) || ' quincena de '
                                        || v_month_names[v_rate.month] || ' ' || v_rate.year));
          v_base := v_base + v_rate.daily_price * v_days;
        end if;
        v_d := v_period_end + 1;
      end loop;
    end loop;
  end if;

  v_cur := v_base;
  v_mode := coalesce(v_ws.discount_mode, 'cascada');
  if not v_courtesy then
    -- Descuentos automáticos que corresponden (paquete, convenio, efectivo), en este orden.
    -- 2. Paquete por cantidad de días
    -- (con un paquete de precio fijo no se suma además el paquete en %)
    select percent into v_pct from public.package_discounts
    where workspace_id = p_workspace_id and active and min_days <= v_total_days and not v_fixed
    order by min_days desc limit 1;
    if found and v_base > 0 then
      v_cands := v_cands || jsonb_build_object('kind', 'paquete', 'percent', v_pct,
                   'label', format('Paquete %s días (%s%%)', v_total_days, to_char(v_pct, 'FM990D##')));
    end if;

    -- 3. Convenio
    if (v_opts ->> 'agreement_id') is not null then
      select * into v_agreement from public.agreements
      where id = (v_opts ->> 'agreement_id')::uuid and workspace_id = p_workspace_id;
      if not found or not v_agreement.active or v_agreement.deleted_at is not null
         or (v_agreement.valid_from is not null and p_start < v_agreement.valid_from)
         or (v_agreement.valid_to is not null and p_start > v_agreement.valid_to) then
        raise exception 'El convenio elegido no está vigente para esas fechas.';
      end if;
      v_cands := v_cands || jsonb_build_object('kind', 'convenio', 'agreement_id', v_agreement.id, 'percent', v_agreement.percent,
                   'label', 'Convenio ' || v_agreement.name);
    end if;

    -- 4. Pago en efectivo
    if coalesce((v_opts ->> 'cash')::boolean, false) and v_ws.cash_discount_percent > 0 then
      v_cands := v_cands || jsonb_build_object('kind', 'efectivo', 'percent', v_ws.cash_discount_percent, 'label', 'Pago en efectivo');
    end if;

    -- Cómo se combinan (lo decide cada balneario en Convenios y descuentos):
    --   cascada: cada uno sobre lo que queda · sumados: cada uno sobre el precio base ·
    --   mayor: no acumulables, se aplica solo el de mayor porcentaje.
    if v_mode = 'mayor' and jsonb_array_length(v_cands) > 1 then
      select c into v_best from jsonb_array_elements(v_cands) with ordinality as t(c, n)
      order by (c ->> 'percent')::numeric desc, n limit 1;
      select coalesce(jsonb_agg(c), '[]'::jsonb) into v_skipped from jsonb_array_elements(v_cands) with ordinality as t(c, n)
      where c is distinct from v_best;
      v_cands := jsonb_build_array(v_best);
    end if;
    for v_c in select * from jsonb_array_elements(v_cands) loop
      v_pct := (v_c ->> 'percent')::numeric;
      v_amt := least(floor((case when v_mode = 'sumados' then v_base else v_cur end) * v_pct / 100), v_cur);
      v_discounts := v_discounts || (v_c - 'label' || jsonb_build_object('amount', v_amt)
                     || case when v_c ->> 'kind' = 'paquete' then jsonb_build_object('label', v_c ->> 'label') else '{}'::jsonb end);
      v_cur := v_cur - v_amt;
    end loop;

    -- 5. Descuento manual (decisión del administrador: se aplica siempre, al final)
    if v_manual is not null and coalesce((v_manual ->> 'value')::numeric, 0) > 0 then
      if char_length(btrim(coalesce(v_manual ->> 'reason', ''))) < 3 then
        raise exception 'Los descuentos manuales necesitan un motivo.';
      end if;
      if v_manual ->> 'type' = 'porcentaje' then
        v_pct := (v_manual ->> 'value')::numeric;
        if v_pct > 100 then
          raise exception 'El porcentaje no puede superar 100.';
        end if;
        v_amt := least(floor((case when v_mode = 'sumados' then v_base else v_cur end) * v_pct / 100), v_cur);
      else
        v_pct := null;
        v_amt := least(floor((v_manual ->> 'value')::numeric), v_cur);
      end if;
      v_discounts := v_discounts || jsonb_build_object('kind', 'manual', 'percent', v_pct, 'amount', v_amt,
                       'reason', btrim(v_manual ->> 'reason'));
      v_cur := v_cur - v_amt;
    end if;
  end if;

  -- Tope de descuento del balneario: el total de descuentos no pasa de ese % del precio base.
  -- Si se pasa, se recorta desde el último descuento hacia atrás (primero el manual).
  if not v_courtesy and v_ws.discount_cap_percent is not null and v_base > 0 then
    v_cap := floor(v_base * v_ws.discount_cap_percent / 100);
    v_excess := (v_base - v_cur) - v_cap;
    if v_excess > 0 then
      v_new := '[]'::jsonb;
      for v_i in reverse jsonb_array_length(v_discounts) - 1 .. 0 loop
        v_c := v_discounts -> v_i;
        v_amt := least((v_c ->> 'amount')::numeric, v_excess);
        v_excess := v_excess - v_amt;
        v_c := jsonb_set(v_c, '{amount}', to_jsonb((v_c ->> 'amount')::numeric - v_amt));
        if (v_c ->> 'amount')::numeric > 0 then
          v_new := jsonb_build_array(v_c) || v_new;
        end if;
      end loop;
      v_discounts := v_new;
      v_cur := v_base - v_cap;
      v_capped := true;
    end if;
  end if;

  -- Redondeo (opcional, lo elige quien carga la reserva): el total baja al múltiplo de $500 de abajo.
  -- Ej.: $400.040 → $400.000 · $23.730 → $23.500. Queda registrado como un descuento "Redondeo".
  if not v_courtesy and coalesce((v_opts ->> 'round')::boolean, false) and v_cur > 0 then
    v_amt := v_cur - floor(v_cur / 500) * 500;
    if v_amt > 0 then
      v_discounts := v_discounts || jsonb_build_object('kind', 'redondeo', 'percent', null, 'amount', v_amt, 'label', 'Redondeo');
      v_cur := v_cur - v_amt;
    end if;
  end if;

  return jsonb_build_object(
    'ok', jsonb_array_length(v_missing) = 0,
    'faltan_tarifas', v_missing,
    'charges', v_charges,
    'dias', v_total_days,
    'precio_base', v_base,
    'discounts', v_discounts,
    'cortesia', v_courtesy,
    'total', case when v_courtesy then 0 else v_cur end,
    'modo_descuentos', v_mode,
    'no_aplicados', v_skipped,
    'tope', v_ws.discount_cap_percent,
    'tope_aplicado', v_capped,
    'paquete_fijo', v_fixed
  );
end $$;

-- 0050 · Atajos de teclado propios de cada usuario (Configuración → Atajos de teclado).
-- Se guardan como {"nueva": "F2", "mapa": "Alt+M", ...}; "" = sin atajo. Sin dato = los de fábrica.

alter table public.user_preferences add column if not exists hotkeys jsonb
  check (hotkeys is null or (jsonb_typeof(hotkeys) = 'object' and octet_length(hotkeys::text) <= 2000));
grant insert (hotkeys), update (hotkeys) on public.user_preferences to authenticated;

-- 0051 · Fuera de temporada: el balneario puede apagar los avisos de la caja diaria
-- (no se pide abrirla al entrar ni avisa «Caja sin abrir»). La caja sigue funcionando si se la abre a mano.

alter table public.workspaces add column if not exists cash_prompts boolean not null default true;
grant update (cash_prompts) on public.workspaces to authenticated;

-- 0052 · Planes: Temporada habilita todo el año y sus cuotas vencen a principio de febrero y de marzo.
--
-- · Temporada: la entrada (al contratar) habilita 12 meses, como el Anual. La cuota 1 (enero) vence el
--   1 de febrero y la cuota 2 (febrero) el 1 de marzo; pagarlas no cambia el vencimiento, queda registrado.
-- · El Panel del dueño avisa las cuotas vencidas sin pagar (no se bloquea al balneario por eso).

create or replace function public.admin_register_payment(p_workspace_id uuid, p_amount numeric, p_until date default null, p_note text default null) returns date
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions%rowtype; v_until date; v_season date := private.season_end(private.today_ar()); v_part integer; v_label text;
begin
  perform private.require_platform_admin();
  select * into s from public.subscriptions where workspace_id = p_workspace_id for update;
  if not found then raise exception 'Ese balneario no tiene plan. Asignale uno primero.'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Importe inválido.'; end if;
  if s.plan = 'temporada' then
    -- Temporada nueva: vuelve a empezar por la entrada.
    v_part := case when s.season_end is distinct from v_season then 1 else least(s.installments_paid + 1, 3) end;
    v_label := case v_part when 1 then 'Entrada' when 2 then 'Cuota 1 de 2 (enero, vence a principio de febrero)' else 'Cuota 2 de 2 (febrero, vence a principio de marzo)' end;
    -- La entrada habilita todo el año (12 meses); las cuotas no cambian el vencimiento.
    v_until := coalesce(p_until, case when v_part = 1 then private.extend_until('anual', s.paid_until, private.today_ar())
                                      else greatest(s.paid_until, private.today_ar()) end);
  else
    v_until := coalesce(p_until, private.extend_until(s.plan, s.paid_until, private.today_ar()));
  end if;
  if v_until < private.today_ar() then raise exception 'La fecha tiene que ser hoy o más adelante.'; end if;
  update public.subscriptions
     set paid_until = v_until, status = case when status in ('pendiente','cancelada') then 'manual' else status end,
         installments_paid = case when s.plan = 'temporada' then v_part else installments_paid end,
         season_end = case when s.plan = 'temporada' then v_season else season_end end,
         last_payment_at = now(), last_payment_status = 'aprobado', last_payment_amount = p_amount, updated_at = now()
   where workspace_id = p_workspace_id;
  insert into public.subscription_events (workspace_id, kind, amount, detail, actor_id)
  values (p_workspace_id, 'pago_manual', p_amount,
          coalesce(v_label || ' · ', '') || coalesce(nullif(btrim(p_note), ''), 'Pago registrado a mano') || ' · pago hasta el ' || to_char(v_until, 'DD/MM/YYYY'), auth.uid());
  return v_until;
end $$;

create or replace function public.my_plan(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions%rowtype; v_grace int; v_season date := private.season_end(private.today_ar()); v_paid int;
begin
  perform private.require_member(p_workspace_id);
  select * into s from public.subscriptions where workspace_id = p_workspace_id;
  if not found then return null; end if;
  select dias_gracia into v_grace from private.plataforma where id = 1;
  v_paid := case when s.season_end is distinct from v_season then 0 else s.installments_paid end;
  return jsonb_build_object(
    'plan', s.plan, 'precio', s.price, 'estado', s.status, 'pago_hasta', s.paid_until,
    'entrada', s.entry_amount, 'cuota', s.installment_amount, 'cuotas_pagas', v_paid,
    'partes', case when s.plan = 'temporada' then jsonb_build_array(
        jsonb_build_object('nombre', 'Entrada', 'importe', s.entry_amount, 'vence', null, 'pagada', v_paid >= 1),
        jsonb_build_object('nombre', 'Cuota 1 (enero)', 'importe', s.installment_amount, 'vence', make_date(extract(year from v_season)::int, 2, 1), 'pagada', v_paid >= 2),
        jsonb_build_object('nombre', 'Cuota 2 (febrero)', 'importe', s.installment_amount, 'vence', make_date(extract(year from v_season)::int, 3, 1), 'pagada', v_paid >= 3)) end,
    'bloquea_desde', case when s.status = 'exenta' then null else coalesce(s.paid_until, s.created_at::date) + v_grace + 1 end,
    'vencido', private.plan_expired(p_workspace_id), 'dias_gracia', v_grace,
    'proximo_debito', s.next_charge_on, 'debito_automatico', s.mp_preapproval_id is not null and s.status = 'activa',
    'pagador', s.mp_payer_email, 'ultimo_pago', s.last_payment_at, 'ultimo_estado', s.last_payment_status,
    'temporada_hasta', v_season, 'hoy', private.today_ar(),
    'movimientos', coalesce((select jsonb_agg(jsonb_build_object('tipo', e.kind, 'importe', e.amount, 'detalle', e.detail, 'fecha', e.created_at) order by e.created_at desc)
                             from (select * from public.subscription_events where workspace_id = p_workspace_id order by created_at desc limit 12) e), '[]'::jsonb)
  );
end $$;

-- 0053 · Volver a habilitar un correo cuyo balneario se eliminó.
-- Antes: al eliminar un balneario, su correo quedaba marcado como "ya usado" y volver a habilitarlo
-- no hacía nada (la persona creaba su usuario y terminaba en la página de presupuestos).
-- Ahora la habilitación se renueva; y si el correo ya tiene un balneario activo, se avisa.

create or replace function public.admin_allow_signup(p_email text, p_note text default null, p_plan text default null, p_price numeric default null,
                                                     p_tents integer default null, p_umbrellas integer default null,
                                                     p_entry numeric default null, p_installment numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v text := lower(btrim(coalesce(p_email, ''))); v_price numeric := p_price;
begin
  perform private.require_platform_admin();
  if v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Correo inválido.'; end if;
  if p_plan is not null and p_plan not in ('anual','temporada') then raise exception 'Plan inválido.'; end if;
  if p_plan = 'temporada' then
    if p_entry is null or p_entry < 0 or p_installment is null or p_installment < 0 then raise exception 'Poné la entrada y la cuota.'; end if;
    v_price := p_entry + 2 * p_installment;
  end if;
  if v_price is not null and v_price < 0 then raise exception 'Precio inválido.'; end if;
  if (p_tents is not null and (p_tents < 0 or p_tents > 600)) or (p_umbrellas is not null and (p_umbrellas < 0 or p_umbrellas > 300)) then
    raise exception 'Indicá hasta 600 carpas y 300 sombrillas.';
  end if;
  -- Si ese correo ya usó su habilitación: si su balneario sigue existiendo se avisa (antes no hacía nada);
  -- si el balneario se eliminó, la habilitación vuelve a quedar disponible para crear uno nuevo.
  if exists (select 1 from private.signup_allowlist a where a.email = v and a.used_at is not null
               and a.workspace_id is not null and exists (select 1 from public.workspaces w where w.id = a.workspace_id)) then
    raise exception 'Ese correo ya tiene su balneario creado (%). Para cambiarle el plan o las carpas usá su tarjeta.',
      (select w.name from private.signup_allowlist a join public.workspaces w on w.id = a.workspace_id where a.email = v);
  end if;
  update private.signup_allowlist set used_at = null, workspace_id = null where email = v and used_at is not null;
  insert into private.signup_allowlist (email, note, plan, price, max_tents, max_umbrellas, entry_amount, installment_amount)
  values (v, nullif(btrim(coalesce(p_note, '')), ''), p_plan, v_price, p_tents, p_umbrellas,
          case when p_plan = 'temporada' then p_entry end, case when p_plan = 'temporada' then p_installment end)
  on conflict (email) do update set note = coalesce(excluded.note, private.signup_allowlist.note), plan = excluded.plan, price = excluded.price,
    max_tents = excluded.max_tents, max_umbrellas = excluded.max_umbrellas,
    entry_amount = excluded.entry_amount, installment_amount = excluded.installment_amount
  where private.signup_allowlist.used_at is null;
end $$;

-- 0054 · Panel propio del dueño de Mi Balneario (/dueno): métricas y soporte en solo lectura.
--
-- · admin_metrics(): ingresos por mes, altas por mes, visitas a la demo por semana y totales.
-- · Soporte: el dueño puede ver el balneario de un cliente en SOLO LECTURA (admin_support_view).
--   Cada vez queda registrado y el balneario lo ve en sus avisos («El soporte de Mi Balneario miró tus datos»).

create table if not exists private.support_access (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  admin_id     uuid not null,
  reason       text check (char_length(reason) <= 300),
  at           timestamptz not null default now()
);
create index if not exists support_access_ws_idx on private.support_access(workspace_id, at desc);
alter table private.support_access enable row level security;
revoke all on private.support_access from public, anon, authenticated;

create or replace function public.admin_metrics() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := private.today_ar();
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'hoy', v_today,
    'ingresos_por_mes', (
      select jsonb_agg(jsonb_build_object('mes', to_char(m, 'YYYY-MM'),
               'importe', coalesce((select sum(e.amount) from public.subscription_events e
                                     where e.kind in ('pago_manual','pago_aprobado')
                                       and (e.created_at at time zone 'America/Argentina/Buenos_Aires')::date >= m
                                       and (e.created_at at time zone 'America/Argentina/Buenos_Aires')::date < (m + interval '1 month')::date), 0)) order by m)
        from generate_series(date_trunc('month', v_today) - interval '11 months', date_trunc('month', v_today), interval '1 month') m),
    'altas_por_mes', (
      select jsonb_agg(jsonb_build_object('mes', to_char(m, 'YYYY-MM'),
               'cantidad', (select count(*) from public.workspaces w where not w.is_demo
                              and w.created_at >= m and w.created_at < m + interval '1 month')) order by m)
        from generate_series(date_trunc('month', v_today) - interval '11 months', date_trunc('month', v_today), interval '1 month') m),
    'demo_por_semana', (
      select jsonb_agg(jsonb_build_object('semana', to_char(s, 'YYYY-MM-DD'),
               'cantidad', (select count(*) from private.demo_visitors d where d.first_at >= s and d.first_at < s + interval '1 week')) order by s)
        from generate_series(date_trunc('week', v_today) - interval '11 weeks', date_trunc('week', v_today), interval '1 week') s),
    'totales', jsonb_build_object(
      'carpas', (select count(*) from public.spaces s join public.workspaces w on w.id = s.workspace_id where not w.is_demo and s.active and s.kind = 'carpa'),
      'sombrillas', (select count(*) from public.spaces s join public.workspaces w on w.id = s.workspace_id where not w.is_demo and s.active and s.kind = 'sombrilla'),
      'reservas', (select count(*) from public.reservations r join public.workspaces w on w.id = r.workspace_id where not w.is_demo and r.status = 'confirmada'),
      'reservas_30d', (select count(*) from public.reservations r join public.workspaces w on w.id = r.workspace_id where not w.is_demo and r.status = 'confirmada' and r.created_at >= now() - interval '30 days'),
      'clientes', (select count(*) from public.customers c join public.workspaces w on w.id = c.workspace_id where not w.is_demo),
      'demo_total', (select count(*) from private.demo_visitors),
      'cobrado_anio', (select coalesce(sum(e.amount), 0) from public.subscription_events e
                        where e.kind in ('pago_manual','pago_aprobado') and e.created_at >= date_trunc('year', v_today)))
  );
end $$;
revoke all on function public.admin_metrics() from public, anon;
grant execute on function public.admin_metrics() to authenticated;

-- Soporte: ver el balneario de un cliente en solo lectura. Queda registrado.
create or replace function public.admin_support_view(p_workspace_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_today date := private.today_ar(); w public.workspaces%rowtype;
begin
  perform private.require_platform_admin();
  select * into w from public.workspaces where id = p_workspace_id and not is_demo;
  if not found then raise exception 'Ese balneario no existe.'; end if;
  -- Una entrada por hora como máximo (recargar la página no llena el registro).
  if not exists (select 1 from private.support_access where workspace_id = p_workspace_id and admin_id = auth.uid() and at > now() - interval '1 hour') then
    insert into private.support_access (workspace_id, admin_id, reason) values (p_workspace_id, auth.uid(), nullif(btrim(coalesce(p_reason, '')), ''));
  end if;
  return jsonb_build_object(
    'hoy', v_today,
    'balneario', jsonb_build_object('id', w.id, 'nombre', w.name, 'subtitulo', w.subtitle, 'telefono', w.phone, 'direccion', w.address,
                                    'lat', w.latitude, 'lon', w.longitude, 'ancho', w.map_width, 'alto', w.map_height, 'mar', w.sea_side,
                                    'pausado', w.paused_at is not null, 'creado', w.created_at),
    'espacios', coalesce((select jsonb_agg(jsonb_build_object('codigo', s.code, 'tipo', s.kind, 'x', s.x, 'y', s.y, 'activo', s.active,
        'ocupado', exists (select 1 from public.reservation_segments g join public.reservations r on r.id = g.reservation_id
                            where g.space_id = s.id and g.active and r.status = 'confirmada' and v_today between g.start_date and g.end_date)) order by s.code)
      from public.spaces s where s.workspace_id = w.id), '[]'::jsonb),
    'elementos', coalesce((select jsonb_agg(jsonb_build_object('tipo', f.kind, 'nombre', f.label, 'x', f.x, 'y', f.y, 'ancho', f.width, 'alto', f.height, 'color', f.color) order by f.layer)
      from public.map_features f where f.workspace_id = w.id and f.active), '[]'::jsonb),
    'reservas', coalesce((select jsonb_agg(x order by x ->> 'desde' desc) from (
        select jsonb_build_object('numero', r.number, 'cliente', trim(c.first_name || ' ' || c.last_name), 'desde', r.start_date, 'hasta', r.end_date,
                                  'estado', r.status, 'total', r.total_amount, 'debe', coalesce(b.due_amount, 0),
                                  'espacios', (select string_agg(distinct sp.code, ', ') from public.reservation_segments g join public.spaces sp on sp.id = g.space_id
                                                where g.reservation_id = r.id and g.active)) x
          from public.reservations r join public.customers c on c.id = r.customer_id
          left join public.reservation_balances b on b.reservation_id = r.id
         where r.workspace_id = w.id order by r.created_at desc limit 30) t), '[]'::jsonb),
    'caja', (select jsonb_build_object('fecha', cs.business_date, 'abierta', cs.closed_at is null, 'apertura', cs.opening_cash,
                                       'esperado', cs.expected_cash, 'contado', cs.counted_cash, 'diferencia', cs.difference)
               from public.cash_sessions cs where cs.workspace_id = w.id order by cs.business_date desc, cs.opened_at desc limit 1),
    'usuarios', coalesce((select jsonb_agg(jsonb_build_object('usuario', l.username, 'correo', u.email, 'rol', m.role) order by m.role)
      from public.workspace_members m join auth.users u on u.id = m.user_id left join public.user_logins l on l.user_id = m.user_id
      where m.workspace_id = w.id), '[]'::jsonb),
    'conteos', jsonb_build_object(
      'clientes', (select count(*) from public.customers where workspace_id = w.id),
      'reservas', (select count(*) from public.reservations where workspace_id = w.id and status = 'confirmada'),
      'deuda', (select coalesce(sum(b.due_amount), 0) from public.reservation_balances b join public.reservations r on r.id = b.reservation_id
                 where r.workspace_id = w.id and r.status = 'confirmada')),
    'accesos', coalesce((select jsonb_agg(jsonb_build_object('fecha', a.at, 'motivo', a.reason) order by a.at desc)
      from (select * from private.support_access where workspace_id = w.id order by at desc limit 10) a), '[]'::jsonb)
  );
end $$;
revoke all on function public.admin_support_view(uuid, text) from public, anon;
grant execute on function public.admin_support_view(uuid, text) to authenticated;

-- Para el balneario: cuándo lo miró el soporte (últimos 30 días), para mostrárselo en los avisos.
create or replace function public.support_accesses(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id);
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'fecha', a.at, 'motivo', a.reason) order by a.at desc)
                     from private.support_access a where a.workspace_id = p_workspace_id and a.at > now() - interval '30 days'), '[]'::jsonb);
end $$;
revoke all on function public.support_accesses(uuid) from public, anon;
grant execute on function public.support_accesses(uuid) to authenticated;

-- 0055 · Gastos del dueño de Mi Balneario (servidores, dominio, publicidad, etc.), por año.
-- Los carga el dueño desde /dueno/gastos. No se borran: se anulan (queda el registro).

create table if not exists private.owner_expenses (
  id         uuid primary key default gen_random_uuid(),
  spent_on   date not null,
  concept    text not null check (char_length(btrim(concept)) between 2 and 120),
  category   text not null check (category in ('servidores','dominio_correo','publicidad','herramientas','viajes','impuestos','otros')),
  amount     numeric(14,2) not null check (amount > 0),
  notes      text check (char_length(notes) <= 500),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  voided_at  timestamptz,
  voided_by  uuid,
  void_reason text
);
create index if not exists owner_expenses_date_idx on private.owner_expenses(spent_on);
alter table private.owner_expenses enable row level security;
revoke all on private.owner_expenses from public, anon, authenticated;

create or replace function public.admin_add_expense(p_date date, p_concept text, p_category text, p_amount numeric, p_notes text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_platform_admin();
  if p_date is null or p_date > private.today_ar() + 366 then raise exception 'Fecha inválida.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'El importe tiene que ser mayor a cero.'; end if;
  if char_length(btrim(coalesce(p_concept, ''))) < 2 then raise exception 'Poné el concepto del gasto.'; end if;
  insert into private.owner_expenses (spent_on, concept, category, amount, notes, created_by)
  values (p_date, btrim(p_concept), p_category, round(p_amount, 2), nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.admin_add_expense(date, text, text, numeric, text) from public, anon;
grant execute on function public.admin_add_expense(date, text, text, numeric, text) to authenticated;

create or replace function public.admin_void_expense(p_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  update private.owner_expenses set voided_at = now(), voided_by = auth.uid(), void_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_id and voided_at is null;
  if not found then raise exception 'Ese gasto no existe o ya estaba anulado.'; end if;
end $$;
revoke all on function public.admin_void_expense(uuid, text) from public, anon;
grant execute on function public.admin_void_expense(uuid, text) to authenticated;

-- Gastos de un año: la lista, el total por mes y por categoría, y lo cobrado ese año (para ver qué queda).
create or replace function public.admin_expenses(p_year integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_from date := make_date(p_year, 1, 1); v_to date := make_date(p_year + 1, 1, 1);
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'anio', p_year,
    'gastos', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'fecha', e.spent_on, 'concepto', e.concept, 'categoria', e.category,
                         'importe', e.amount, 'notas', e.notes, 'anulado', e.voided_at, 'motivo_anulacion', e.void_reason) order by e.spent_on desc, e.created_at desc)
                        from private.owner_expenses e where e.spent_on >= v_from and e.spent_on < v_to), '[]'::jsonb),
    'por_mes', (select jsonb_agg(jsonb_build_object('mes', m,
                  'gastos', coalesce((select sum(e.amount) from private.owner_expenses e where e.voided_at is null and extract(month from e.spent_on) = m and e.spent_on >= v_from and e.spent_on < v_to), 0),
                  'cobrado', coalesce((select sum(s.amount) from public.subscription_events s where s.kind in ('pago_manual','pago_aprobado')
                                        and (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date >= v_from
                                        and (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date < v_to
                                        and extract(month from (s.created_at at time zone 'America/Argentina/Buenos_Aires')) = m), 0)) order by m)
                 from generate_series(1, 12) m),
    'por_categoria', coalesce((select jsonb_object_agg(category, total) from (
                       select category, sum(amount) total from private.owner_expenses
                        where voided_at is null and spent_on >= v_from and spent_on < v_to group by category) c), '{}'::jsonb),
    'anios', coalesce((select jsonb_agg(distinct extract(year from spent_on)::int) from private.owner_expenses), '[]'::jsonb)
  );
end $$;
revoke all on function public.admin_expenses(integer) from public, anon;
grant execute on function public.admin_expenses(integer) to authenticated;

commit;
