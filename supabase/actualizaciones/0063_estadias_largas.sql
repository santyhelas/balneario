begin;
-- =====================================================================
-- 0063 · Estadías largas: la disponibilidad se consulta hasta 400 días (antes 120),
--        para poder cargar alquileres de toda la temporada o del año.
--        El orden incluye el id para que la app pueda pedir los resultados de a partes.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.availability_grid(p_workspace_id uuid, p_from date, p_to date, p_kind text DEFAULT NULL::text)
 RETURNS TABLE(space_id uuid, code text, kind text, day date, free boolean, reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_member(p_workspace_id);
  if p_to < p_from or p_to - p_from > 400 then
    raise exception 'El rango de fechas debe ser de hasta 400 días.';
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
  order by sp.kind, sp.code, sp.id, d;
end $function$;

commit;
