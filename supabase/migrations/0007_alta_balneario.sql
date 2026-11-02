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
