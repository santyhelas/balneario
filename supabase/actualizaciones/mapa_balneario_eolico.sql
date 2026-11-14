-- Mapa del Balneario Eólico (sihelas@live.com): 79 carpas (01–79) y 10 sombrillas (80–89),
-- parador con bar, oficina, duchas y baños, cancha de vóley, juegos infantiles, pasarelas y el mar abajo.
-- Correr en Supabase → SQL Editor DESPUÉS de que el cliente haya creado su cuenta.
-- Seguro: si el balneario ya tiene reservas no cambia nada; no borra nada (lo anterior del plano queda desactivado).
begin;

do $$
declare
  v_ws uuid;
  v_missing text;
begin
  select m.workspace_id into v_ws
    from public.workspace_members m join auth.users u on u.id = m.user_id
   where lower(u.email) = 'sihelas@live.com' and m.role = 'propietario'
   limit 1;
  if v_ws is null then
    raise exception 'Todavía no existe la cuenta de sihelas@live.com: esperá a que el cliente cree su usuario y volvé a correr esto.';
  end if;
  if exists (select 1 from public.reservations where workspace_id = v_ws) then
    raise exception 'El Balneario Eólico ya tiene reservas cargadas: no se cambia el plano para no mover a nadie. Avisame y lo vemos.';
  end if;
  if exists (select 1 from public.workspaces where id = v_ws and paused_at is not null) then
    raise exception 'El balneario está en pausa: reactivalo desde el Panel del dueño y volvé a correr esto.';
  end if;

  -- Tamaño del plano y el mar abajo; la brújula arriba a la izquierda, sobre arena libre.
  update public.workspaces
     set map_width = 3050, map_height = 2300, sea_side = 'bottom',
         compass_layout = '{"x": 13, "y": 15, "scale": 0.85}'::jsonb, version = version + 1
   where id = v_ws;

  -- Cada carpa y sombrilla a su lugar (mismos números que el plano del balneario).
  select string_agg(p.code, ', ' order by p.code) into v_missing
    from private.parador_spaces() p
   where not exists (select 1 from public.spaces s where s.workspace_id = v_ws and s.code = p.code and s.kind = p.kind);
  if v_missing is not null then
    raise exception 'Faltan estos espacios en la cuenta (revisá que se haya habilitado con 79 carpas y 10 sombrillas): %', v_missing;
  end if;
  update public.spaces s
     set x = p.x, y = p.y, rotation = 0, active = true, version = s.version + 1
    from private.parador_spaces() p
   where s.workspace_id = v_ws and s.code = p.code and s.kind = p.kind;

  -- Instalaciones y caminos: lo que hubiera queda desactivado y se dibuja el plano nuevo
  -- (sin el cartel de normas; las pasarelas pasan por debajo del parador).
  update public.map_features set active = false, version = version + 1 where workspace_id = v_ws and active;
  insert into public.map_features (workspace_id, kind, label, x, y, width, height, color, layer)
    select v_ws, f.kind, f.label,
           case when f.kind = 'camino' and f.x = 1910 and f.y = 857 then 1944 else f.x end,
           f.y, f.width, f.height, f.color,
           case when f.kind = 'camino' then -1 else 0 end
      from private.parador_features() f
     where coalesce(f.label, '') not ilike 'Normas%';

  raise notice 'Listo: plano del Balneario Eólico armado (79 carpas, 10 sombrillas).';
end $$;

commit;
