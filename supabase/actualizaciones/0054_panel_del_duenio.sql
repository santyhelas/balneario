begin;

-- 0054 · Panel propio del dueño de Mi Balneario (/dueno): métricas y soporte en solo lectura.
--
-- · admin_metrics(): ingresos por mes, altas por mes, visitas a la demo por semana y totales.
-- · Soporte: el dueño puede ver el balneario de un cliente en SOLO LECTURA (admin_support_view).
--   Cada vez queda registrado y el balneario lo ve en sus avisos («El soporte de Mi Balneario miró tus datos»).

create table if not exists private.support_access (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  admin_id     uuid not null,
  reason       text check (char_length(reason) <= 300),
  at           timestamptz not null default now()
);
create index if not exists support_access_ws_idx on private.support_access(workspace_id, at desc);
alter table private.support_access enable row level security;
revoke all on private.support_access from public, anon, authenticated;

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
               'cantidad', (select count(*) from public.workspaces w where not w.is_demo
                              and w.created_at >= m and w.created_at < m + interval '1 month')) order by m)
        from generate_series(date_trunc('month', v_today) - interval '11 months', date_trunc('month', v_today), interval '1 month') m),
    'demo_por_semana', (
      select jsonb_agg(jsonb_build_object('semana', to_char(s, 'YYYY-MM-DD'),
               'cantidad', (select count(*) from private.demo_visitors d where d.first_at >= s and d.first_at < s + interval '1 week')) order by s)
        from generate_series(date_trunc('week', v_today) - interval '11 weeks', date_trunc('week', v_today), interval '1 week') s),
    'totales', jsonb_build_object(
      'carpas', (select count(*) from public.spaces s join public.workspaces w on w.id = s.workspace_id where not w.is_demo and s.active and s.kind = 'carpa'),
      'sombrillas', (select count(*) from public.spaces s join public.workspaces w on w.id = s.workspace_id where not w.is_demo and s.active and s.kind = 'sombrilla'),
      'reservas', (select count(*) from public.reservations r join public.workspaces w on w.id = r.workspace_id where not w.is_demo and r.status = 'confirmada'),
      'reservas_30d', (select count(*) from public.reservations r join public.workspaces w on w.id = r.workspace_id where not w.is_demo and r.status = 'confirmada' and r.created_at >= now() - interval '30 days'),
      'clientes', (select count(*) from public.customers c join public.workspaces w on w.id = c.workspace_id where not w.is_demo),
      'demo_total', (select count(*) from private.demo_visitors),
      'cobrado_anio', (select coalesce(sum(e.amount), 0) from public.subscription_events e
                        where e.kind in ('pago_manual','pago_aprobado') and e.created_at >= date_trunc('year', v_today)))
  );
end $$;
revoke all on function public.admin_metrics() from public, anon;
grant execute on function public.admin_metrics() to authenticated;

-- Soporte: ver el balneario de un cliente en solo lectura. Queda registrado.
create or replace function public.admin_support_view(p_workspace_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_today date := private.today_ar(); w public.workspaces%rowtype;
begin
  perform private.require_platform_admin();
  select * into w from public.workspaces where id = p_workspace_id and not is_demo;
  if not found then raise exception 'Ese balneario no existe.'; end if;
  -- Una entrada por hora como máximo (recargar la página no llena el registro).
  if not exists (select 1 from private.support_access where workspace_id = p_workspace_id and admin_id = auth.uid() and at > now() - interval '1 hour') then
    insert into private.support_access (workspace_id, admin_id, reason) values (p_workspace_id, auth.uid(), nullif(btrim(coalesce(p_reason, '')), ''));
  end if;
  return jsonb_build_object(
    'hoy', v_today,
    'balneario', jsonb_build_object('id', w.id, 'nombre', w.name, 'subtitulo', w.subtitle, 'telefono', w.phone, 'direccion', w.address,
                                    'lat', w.latitude, 'lon', w.longitude, 'ancho', w.map_width, 'alto', w.map_height, 'mar', w.sea_side,
                                    'pausado', w.paused_at is not null, 'creado', w.created_at),
    'espacios', coalesce((select jsonb_agg(jsonb_build_object('codigo', s.code, 'tipo', s.kind, 'x', s.x, 'y', s.y, 'activo', s.active,
        'ocupado', exists (select 1 from public.reservation_segments g join public.reservations r on r.id = g.reservation_id
                            where g.space_id = s.id and g.active and r.status = 'confirmada' and v_today between g.start_date and g.end_date)) order by s.code)
      from public.spaces s where s.workspace_id = w.id), '[]'::jsonb),
    'elementos', coalesce((select jsonb_agg(jsonb_build_object('tipo', f.kind, 'nombre', f.label, 'x', f.x, 'y', f.y, 'ancho', f.width, 'alto', f.height, 'color', f.color) order by f.layer)
      from public.map_features f where f.workspace_id = w.id and f.active), '[]'::jsonb),
    'reservas', coalesce((select jsonb_agg(x order by x ->> 'desde' desc) from (
        select jsonb_build_object('numero', r.number, 'cliente', trim(c.first_name || ' ' || c.last_name), 'desde', r.start_date, 'hasta', r.end_date,
                                  'estado', r.status, 'total', r.total_amount, 'debe', coalesce(b.due_amount, 0),
                                  'espacios', (select string_agg(distinct sp.code, ', ') from public.reservation_segments g join public.spaces sp on sp.id = g.space_id
                                                where g.reservation_id = r.id and g.active)) x
          from public.reservations r join public.customers c on c.id = r.customer_id
          left join public.reservation_balances b on b.reservation_id = r.id
         where r.workspace_id = w.id order by r.created_at desc limit 30) t), '[]'::jsonb),
    'caja', (select jsonb_build_object('fecha', cs.business_date, 'abierta', cs.closed_at is null, 'apertura', cs.opening_cash,
                                       'esperado', cs.expected_cash, 'contado', cs.counted_cash, 'diferencia', cs.difference)
               from public.cash_sessions cs where cs.workspace_id = w.id order by cs.business_date desc, cs.opened_at desc limit 1),
    'usuarios', coalesce((select jsonb_agg(jsonb_build_object('usuario', l.username, 'correo', u.email, 'rol', m.role) order by m.role)
      from public.workspace_members m join auth.users u on u.id = m.user_id left join public.user_logins l on l.user_id = m.user_id
      where m.workspace_id = w.id), '[]'::jsonb),
    'conteos', jsonb_build_object(
      'clientes', (select count(*) from public.customers where workspace_id = w.id),
      'reservas', (select count(*) from public.reservations where workspace_id = w.id and status = 'confirmada'),
      'deuda', (select coalesce(sum(b.due_amount), 0) from public.reservation_balances b join public.reservations r on r.id = b.reservation_id
                 where r.workspace_id = w.id and r.status = 'confirmada')),
    'accesos', coalesce((select jsonb_agg(jsonb_build_object('fecha', a.at, 'motivo', a.reason) order by a.at desc)
      from (select * from private.support_access where workspace_id = w.id order by at desc limit 10) a), '[]'::jsonb)
  );
end $$;
revoke all on function public.admin_support_view(uuid, text) from public, anon;
grant execute on function public.admin_support_view(uuid, text) to authenticated;

-- Para el balneario: cuándo lo miró el soporte (últimos 30 días), para mostrárselo en los avisos.
create or replace function public.support_accesses(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id);
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'fecha', a.at, 'motivo', a.reason) order by a.at desc)
                     from private.support_access a where a.workspace_id = p_workspace_id and a.at > now() - interval '30 days'), '[]'::jsonb);
end $$;
revoke all on function public.support_accesses(uuid) from public, anon;
grant execute on function public.support_accesses(uuid) to authenticated;

commit;
