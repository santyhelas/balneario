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
