-- =====================================================================
-- 0038 · La demo tiene tiempo para armarse.
--   Supabase corta cualquier consulta de un usuario a los 8 segundos. Armar la
--   demo completa (más de mil reservas, dos temporadas, un mes de cajas) puede
--   tardar más en el servidor, y salía «canceling statement due to statement
--   timeout». Esta función —y solo esta— tiene hasta 60 segundos.
-- =====================================================================
alter function public.start_guest_session() set statement_timeout = '60s';
