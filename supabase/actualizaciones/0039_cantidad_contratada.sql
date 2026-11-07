-- ACTUALIZACIÓN 0039 · Cantidad de carpas y sombrillas contratada (no se pueden agregar más, solo quitar).
-- Pegar en Supabase → SQL Editor → Run (después de la 0038).
begin;
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

commit;
