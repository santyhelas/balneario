-- ACTUALIZACIÓN 0014 · Capas del plano (qué elemento queda encima).
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0013).
begin;
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
commit;
