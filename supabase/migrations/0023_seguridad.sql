-- =====================================================================
-- 0023 · Seguridad
--   1. Límite de intentos de inicio de sesión: después de 10 contraseñas
--      incorrectas para un mismo usuario (o 30 desde una misma conexión)
--      en 15 minutos, se bloquea por 15 minutos.
--   2. Se quitan permisos de más que habían quedado en algunas tablas
--      (no eran aprovechables desde la página, pero lo correcto es no tenerlos).
-- =====================================================================

-- 1. Intentos de inicio de sesión (solo los ve y usa el servidor).
create table private.login_attempts (
  id   bigint generated always as identity primary key,
  key  text not null,
  ok   boolean not null,
  at   timestamptz not null default now()
);
create index login_attempts_key_at_idx on private.login_attempts(key, at);
revoke all on private.login_attempts from public, anon, authenticated;

-- ¿Se puede intentar? (límite de fallas en los últimos 15 minutos)
create or replace function public.login_allowed(p_user_key text, p_ip_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select count(*) from private.login_attempts
          where key = p_user_key and not ok and at > now() - interval '15 minutes') < 10
     and (p_ip_key is null or (select count(*) from private.login_attempts
          where key = p_ip_key and not ok and at > now() - interval '15 minutes') < 30)
$$;

-- Anota el resultado. Si entró bien, se limpian sus fallas.
create or replace function public.login_record(p_user_key text, p_ip_key text, p_ok boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_ok then
    delete from private.login_attempts where key = p_user_key;
  else
    insert into private.login_attempts (key, ok) values (p_user_key, false);
    if p_ip_key is not null then
      insert into private.login_attempts (key, ok) values (p_ip_key, false);
    end if;
  end if;
  -- Limpieza: no hace falta guardar intentos de más de un día.
  delete from private.login_attempts where at < now() - interval '1 day';
end $$;

revoke all on function public.login_allowed(text, text), public.login_record(text, text, boolean) from public, anon, authenticated;
grant execute on function public.login_allowed(text, text), public.login_record(text, text, boolean) to service_role;

-- 2. Permisos de más.
revoke insert, update, delete, truncate, references, trigger on public.restaurant_vouchers from anon, authenticated;
revoke select on public.restaurant_vouchers from anon;
revoke insert, update, delete, truncate, references, trigger on public.reservation_balances from anon, authenticated;
revoke select on public.reservation_balances from anon;
revoke truncate, references, trigger on public.audit_log, public.workspace_members, public.workspaces from anon, authenticated;
