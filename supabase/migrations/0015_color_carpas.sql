-- =====================================================================
-- 0015 · Color de las carpas y sombrillas en el plano.
--   null = a rayas según el estado (como siempre); un color "#rrggbb" = lona de ese color
--   (el estado se sigue viendo por el borde y por el número).
-- =====================================================================
alter table public.workspaces add column tent_color text
  check (tent_color is null or tent_color ~ '^#[0-9a-fA-F]{6}$');
grant update (tent_color) on public.workspaces to authenticated;
