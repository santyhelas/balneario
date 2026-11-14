begin;

-- 0050 · Atajos de teclado propios de cada usuario (Configuración → Atajos de teclado).
-- Se guardan como {"nueva": "F2", "mapa": "Alt+M", ...}; "" = sin atajo. Sin dato = los de fábrica.

alter table public.user_preferences add column if not exists hotkeys jsonb
  check (hotkeys is null or (jsonb_typeof(hotkeys) = 'object' and octet_length(hotkeys::text) <= 2000));
grant insert (hotkeys), update (hotkeys) on public.user_preferences to authenticated;

commit;
