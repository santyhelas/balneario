begin;

-- 0060 · Funciones opcionales por balneario: cobro en dólares, redondeo a $500 y paquetes de precio fijo.
-- Apagadas para los balnearios nuevos (el sistema se ve más simple); el administrador las prende en Configuración.
-- A los balnearios que ya las usaron se les dejan prendidas.

alter table public.workspaces add column if not exists features jsonb not null default '{}'::jsonb
  check (jsonb_typeof(features) = 'object');
grant update (features) on public.workspaces to authenticated;

update public.workspaces w set features = jsonb_build_object(
    'dolares', exists (select 1 from public.payments p where p.workspace_id = w.id and p.method = 'dolares'),
    'redondeo', exists (select 1 from public.reservation_discounts d where d.workspace_id = w.id and d.kind = 'redondeo'),
    'paquetes', exists (select 1 from public.package_prices pp where pp.workspace_id = w.id)),
  version = w.version + 1
 where w.features = '{}'::jsonb;

commit;
