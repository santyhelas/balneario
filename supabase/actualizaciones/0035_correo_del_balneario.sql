-- ACTUALIZACIÓN 0035 · Con qué correo trabaja el balneario (botón «Enviar correo»).
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0034).
begin;
-- =====================================================================
-- 0035 · Con qué correo trabaja el balneario (para el botón «Enviar correo»).
--   gmail · outlook (Hotmail/Outlook.com) · office365 (Outlook de empresa) · yahoo ·
--   app (el programa de correo instalado en la compu)
-- =====================================================================
alter table public.workspaces add column if not exists mail_provider text not null default 'gmail'
  check (mail_provider in ('gmail','outlook','office365','yahoo','app'));
grant update (mail_provider) on public.workspaces to authenticated;

commit;
