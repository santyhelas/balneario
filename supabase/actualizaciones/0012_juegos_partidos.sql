-- ACTUALIZACIÓN 0012 · Juegos infantiles partidos en dos.
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0011).
begin;
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
commit;
