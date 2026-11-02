-- ACTUALIZACIÓN 0017 · Avisos leídos.
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0016).
begin;
-- =====================================================================
-- 0017 · Avisos leídos: cada usuario oculta los avisos que ya abrió.
--   Se guarda solo la lista del día ({"day": "AAAA-MM-DD", "ids": [...]});
--   al día siguiente los avisos que sigan vigentes vuelven a aparecer.
--   Marcar un aviso como leído no cambia deudas, pagos ni reservas.
-- =====================================================================
alter table public.user_preferences
  add column notices_read jsonb not null default '{}'::jsonb
  check (jsonb_typeof(notices_read) = 'object' and pg_column_size(notices_read) < 20000);

commit;
