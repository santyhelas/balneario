begin;

-- 0061 · Índices para que las consultas más usadas sigan rápidas con muchas reservas
-- (mapa del día, disponibilidad, mantenimiento y caja).
create index if not exists reservation_segments_ws_dates_idx on public.reservation_segments(workspace_id, start_date, end_date) where active;
create index if not exists maintenance_blocks_space_idx on public.maintenance_blocks(space_id, start_date, end_date) where active;
create index if not exists maintenance_blocks_ws_idx on public.maintenance_blocks(workspace_id, start_date, end_date) where active;
create index if not exists cash_sessions_ws_date_idx on public.cash_sessions(workspace_id, business_date desc);

commit;
