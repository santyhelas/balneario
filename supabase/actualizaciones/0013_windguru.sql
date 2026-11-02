-- ACTUALIZACIÓN 0013 · Pronóstico de Windguru.
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0012).
begin;
-- =====================================================================
-- 0013 · Pronóstico de Windguru (widget oficial) para el balneario.
-- Se guardan solo los parámetros del widget (spot, modelo, unidades…).
-- =====================================================================
alter table public.workspaces
  add column windguru_params text check (
    windguru_params is null or (char_length(windguru_params) <= 1000 and windguru_params ~ '^[A-Za-z0-9=&,._%-]+$' and windguru_params ~ '(^|&)s=[0-9]+')
  );
grant update (windguru_params) on public.workspaces to authenticated;
commit;
