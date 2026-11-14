begin;

-- 0059 · Métricas del dueño sin contar sus propios balnearios de prueba; suma «clientes que pagan» y «consultas».

create or replace function public.admin_metrics() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := private.today_ar();
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'hoy', v_today,
    'ingresos_por_mes', (
      select jsonb_agg(jsonb_build_object('mes', to_char(m, 'YYYY-MM'),
               'importe', coalesce((select sum(e.amount) from public.subscription_events e
                                     where e.kind in ('pago_manual','pago_aprobado')
                                       and (e.created_at at time zone 'America/Argentina/Buenos_Aires')::date >= m
                                       and (e.created_at at time zone 'America/Argentina/Buenos_Aires')::date < (m + interval '1 month')::date), 0)) order by m)
        from generate_series(date_trunc('month', v_today) - interval '11 months', date_trunc('month', v_today), interval '1 month') m),
    'altas_por_mes', (
      select jsonb_agg(jsonb_build_object('mes', to_char(m, 'YYYY-MM'),
               'cantidad', (select count(*) from public.workspaces w where not w.is_demo and not exists (select 1 from public.workspace_members pm join private.platform_admins pa on pa.user_id = pm.user_id where pm.workspace_id = w.id)
                              and w.created_at >= m and w.created_at < m + interval '1 month')) order by m)
        from generate_series(date_trunc('month', v_today) - interval '11 months', date_trunc('month', v_today), interval '1 month') m),
    'demo_por_semana', (
      select jsonb_agg(jsonb_build_object('semana', to_char(s, 'YYYY-MM-DD'),
               'cantidad', (select count(*) from private.demo_visitors d where d.first_at >= s and d.first_at < s + interval '1 week')) order by s)
        from generate_series(date_trunc('week', v_today) - interval '11 weeks', date_trunc('week', v_today), interval '1 week') s),
    'totales', jsonb_build_object(
      'carpas', (select count(*) from public.spaces s join public.workspaces w on w.id = s.workspace_id where not w.is_demo and not exists (select 1 from public.workspace_members pm join private.platform_admins pa on pa.user_id = pm.user_id where pm.workspace_id = w.id) and s.active and s.kind = 'carpa'),
      'sombrillas', (select count(*) from public.spaces s join public.workspaces w on w.id = s.workspace_id where not w.is_demo and not exists (select 1 from public.workspace_members pm join private.platform_admins pa on pa.user_id = pm.user_id where pm.workspace_id = w.id) and s.active and s.kind = 'sombrilla'),
      'reservas', (select count(*) from public.reservations r join public.workspaces w on w.id = r.workspace_id where not w.is_demo and not exists (select 1 from public.workspace_members pm join private.platform_admins pa on pa.user_id = pm.user_id where pm.workspace_id = w.id) and r.status = 'confirmada'),
      'reservas_30d', (select count(*) from public.reservations r join public.workspaces w on w.id = r.workspace_id where not w.is_demo and not exists (select 1 from public.workspace_members pm join private.platform_admins pa on pa.user_id = pm.user_id where pm.workspace_id = w.id) and r.status = 'confirmada' and r.created_at >= now() - interval '30 days'),
      'clientes', (select count(*) from public.customers c join public.workspaces w on w.id = c.workspace_id where not w.is_demo and not exists (select 1 from public.workspace_members pm join private.platform_admins pa on pa.user_id = pm.user_id where pm.workspace_id = w.id)),
      'demo_total', (select count(*) from private.demo_visitors),
      'clientes_pagos', (select count(distinct e.workspace_id) from public.subscription_events e join public.workspaces w on w.id = e.workspace_id
                          where e.kind in ('pago_manual','pago_aprobado') and not w.is_demo and not exists (select 1 from public.workspace_members pm join private.platform_admins pa on pa.user_id = pm.user_id where pm.workspace_id = w.id)),
      'consultas', case when to_regclass('private.owner_leads') is null then 0 else (select count(*) from private.owner_leads) end,
      'cobrado_anio', (select coalesce(sum(e.amount), 0) from public.subscription_events e
                        where e.kind in ('pago_manual','pago_aprobado') and e.created_at >= date_trunc('year', v_today)))
  );
end $$;
revoke all on function public.admin_metrics() from public, anon;
grant execute on function public.admin_metrics() to authenticated;
commit;
