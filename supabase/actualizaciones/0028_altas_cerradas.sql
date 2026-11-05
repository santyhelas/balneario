-- ACTUALIZACIÓN 0028 · Altas cerradas: solo crean balneario las cuentas habilitadas.
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0027).
begin;
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

commit;
