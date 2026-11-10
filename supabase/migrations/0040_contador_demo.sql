-- =====================================================================
-- 0040 · Contador de la demo: cuántas conexiones distintas la probaron.
--   · Se guarda solo un código (hash) de la dirección IP, nunca la IP.
--   · La registra el servidor (clave secreta); el número lo puede leer cualquiera.
-- =====================================================================
create table if not exists private.demo_visitors (
  ip_hash    text primary key check (length(ip_hash) between 16 and 128),
  first_at   timestamptz not null default now(),
  last_at    timestamptz not null default now(),
  visits     integer not null default 1
);
alter table private.demo_visitors enable row level security;
revoke all on private.demo_visitors from public, anon, authenticated;

create or replace function public.demo_register_visit(p_hash text) returns void
language sql security definer set search_path = '' as $$
  insert into private.demo_visitors (ip_hash) values (p_hash)
  on conflict (ip_hash) do update set last_at = now(), visits = private.demo_visitors.visits + 1
$$;
revoke all on function public.demo_register_visit(text) from public, anon, authenticated;
grant execute on function public.demo_register_visit(text) to service_role;

create or replace function public.demo_visitor_count() returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::int from private.demo_visitors
$$;
revoke all on function public.demo_visitor_count() from public;
grant execute on function public.demo_visitor_count() to anon, authenticated, service_role;
