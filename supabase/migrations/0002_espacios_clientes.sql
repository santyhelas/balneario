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
