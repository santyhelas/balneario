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

commit;
