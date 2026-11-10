begin;
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

  insert into public.workspaces (name, subtitle, created_by, map_width, map_height, sea_side, sea_bearing, latitude, longitude, timezone, is_demo)
  values ('Balneario de demostración', 'Mar del Plata · Modo invitado', v_user, 3050, 2300, 'bottom', 110,
          -38.0055, -57.5426, 'America/Argentina/Buenos_Aires', true)
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

commit;
