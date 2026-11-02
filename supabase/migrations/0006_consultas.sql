-- =====================================================================
-- 0006 · Consultas centrales de disponibilidad.
-- Mapa, línea de tiempo, Nueva reserva y panel usan esta misma lógica.
-- =====================================================================

-- Estado de cada espacio en un día dado (para el mapa).
create or replace function public.map_day_status(p_workspace_id uuid, p_day date)
returns table (
  space_id uuid, code text, kind text, x numeric, y numeric, rotation numeric, active boolean,
  state text,                 -- disponible | ocupada | cortesia | reservada_futura | mantenimiento | desactivada
  reservation_id uuid, reservation_number bigint, customer_id uuid, customer_name text,
  reservation_start date, reservation_end date, days_remaining integer,
  due_amount numeric, maintenance_reason text, maintenance_end date, next_start date,
  version integer
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id);
  return query
  select sp.id, sp.code, sp.kind, sp.x, sp.y, sp.rotation, sp.active,
         case
           when not sp.active then 'desactivada'
           when m.id is not null then 'mantenimiento'
           when occ.reservation_id is not null and occ.is_courtesy then 'cortesia'
           when occ.reservation_id is not null then 'ocupada'
           when nxt.next_start is not null then 'reservada_futura'
           else 'disponible'
         end,
         occ.reservation_id, occ.number, occ.customer_id, occ.customer_name,
         occ.start_date, occ.end_date,
         case when occ.reservation_id is not null then (occ.end_date - p_day) end,
         occ.due_amount, m.reason, m.end_date, nxt.next_start, sp.version
  from public.spaces sp
  left join lateral (
    select mb.id, mb.reason, mb.end_date from public.maintenance_blocks mb
    where mb.space_id = sp.id and mb.active and p_day between mb.start_date and mb.end_date
    limit 1
  ) m on true
  left join lateral (
    select r.id as reservation_id, r.number, r.customer_id, r.is_courtesy, r.start_date, r.end_date,
           btrim(c.first_name || ' ' || c.last_name) as customer_name, b.due_amount
    from public.reservation_segments s
    join public.reservations r on r.id = s.reservation_id
    join public.customers c on c.id = r.customer_id
    join public.reservation_balances b on b.reservation_id = r.id
    where s.space_id = sp.id and s.active and p_day between s.start_date and s.end_date
    limit 1
  ) occ on true
  left join lateral (
    select min(s.start_date) as next_start from public.reservation_segments s
    where s.space_id = sp.id and s.active and s.start_date > p_day
  ) nxt on true
  where sp.workspace_id = p_workspace_id
  order by sp.kind, sp.code;
end $$;

-- Disponibilidad día por día (para Nueva reserva y alternativas).
-- Máximo 120 días por consulta.
create or replace function public.availability_grid(
  p_workspace_id uuid, p_from date, p_to date, p_kind text default null
) returns table (space_id uuid, code text, kind text, day date, free boolean, reason text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id);
  if p_to < p_from or p_to - p_from > 120 then
    raise exception 'El rango de fechas debe ser de hasta 120 días.';
  end if;
  return query
  select sp.id, sp.code, sp.kind, d::date,
         (sp.active and m.id is null and s.id is null),
         case when not sp.active then 'desactivada'
              when m.id is not null then 'mantenimiento'
              when s.id is not null then 'ocupada'
         end
  from public.spaces sp
  cross join generate_series(p_from, p_to, interval '1 day') d
  left join public.maintenance_blocks m
    on m.space_id = sp.id and m.active and d::date between m.start_date and m.end_date
  left join public.reservation_segments s
    on s.space_id = sp.id and s.active and d::date between s.start_date and s.end_date
  where sp.workspace_id = p_workspace_id
    and (p_kind is null or sp.kind = p_kind)
  order by sp.kind, sp.code, d;
end $$;

-- Elementos de la línea de tiempo: tramos y bloqueos dentro de un rango.
create or replace function public.timeline_items(p_workspace_id uuid, p_from date, p_to date)
returns table (
  item_type text, space_id uuid, start_date date, end_date date,
  reservation_id uuid, reservation_number bigint, customer_name text, is_courtesy boolean,
  reservation_start date, reservation_end date, is_relocation boolean, label text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id);
  if p_to < p_from or p_to - p_from > 400 then
    raise exception 'El rango de fechas debe ser de hasta 400 días.';
  end if;
  return query
  select 'tramo', s.space_id, s.start_date, s.end_date, r.id, r.number,
         btrim(c.first_name || ' ' || c.last_name), r.is_courtesy, r.start_date, r.end_date,
         (select count(*) from public.reservation_segments s2 where s2.reservation_id = r.id and s2.active) > 1,
         null::text
  from public.reservation_segments s
  join public.reservations r on r.id = s.reservation_id
  join public.customers c on c.id = r.customer_id
  where s.workspace_id = p_workspace_id and s.active
    and daterange(s.start_date, s.end_date, '[]') && daterange(p_from, p_to, '[]')
  union all
  select 'mantenimiento', m.space_id, m.start_date, m.end_date, null, null, null, false, null, null, false, m.reason
  from public.maintenance_blocks m
  where m.workspace_id = p_workspace_id and m.active
    and daterange(m.start_date, m.end_date, '[]') && daterange(p_from, p_to, '[]');
end $$;

-- Panel principal: todo lo del día en una sola consulta.
create or replace function public.dashboard_summary(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date;
  v_counts jsonb;
  v_starting jsonb;
  v_ending jsonb;
  v_debtors integer;
  v_session public.cash_sessions%rowtype;
  v_old_open public.cash_sessions%rowtype;
  v_income jsonb;
  v_expenses numeric(14,2);
begin
  perform private.require_member(p_workspace_id);
  v_today := private.ws_today(p_workspace_id);

  select jsonb_object_agg(kind, x) into v_counts from (
    select kind, jsonb_build_object(
      'total_activos', count(*) filter (where state <> 'desactivada'),
      'ocupados', count(*) filter (where state in ('ocupada','cortesia')),
      'cortesias', count(*) filter (where state = 'cortesia'),
      'disponibles', count(*) filter (where state in ('disponible','reservada_futura')),
      'mantenimiento', count(*) filter (where state = 'mantenimiento'),
      'desactivados', count(*) filter (where state = 'desactivada')
    ) as x
    from public.map_day_status(p_workspace_id, v_today) group by kind
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object(
           'reservation_id', r.id, 'number', r.number,
           'customer', btrim(c.first_name || ' ' || c.last_name), 'phone', c.phone,
           'start_date', r.start_date, 'end_date', r.end_date,
           'spaces', (select string_agg(sp.code, ', ' order by s.start_date) from public.reservation_segments s
                      join public.spaces sp on sp.id = s.space_id where s.reservation_id = r.id and s.active),
           'due_amount', b.due_amount, 'is_courtesy', r.is_courtesy) order by r.number), '[]'::jsonb)
    into v_starting
  from public.reservations r
  join public.customers c on c.id = r.customer_id
  join public.reservation_balances b on b.reservation_id = r.id
  where r.workspace_id = p_workspace_id and r.status = 'confirmada' and r.start_date = v_today;

  select coalesce(jsonb_agg(jsonb_build_object(
           'reservation_id', r.id, 'number', r.number,
           'customer', btrim(c.first_name || ' ' || c.last_name), 'phone', c.phone,
           'start_date', r.start_date, 'end_date', r.end_date,
           'spaces', (select string_agg(sp.code, ', ' order by s.start_date) from public.reservation_segments s
                      join public.spaces sp on sp.id = s.space_id where s.reservation_id = r.id and s.active),
           'due_amount', b.due_amount, 'is_courtesy', r.is_courtesy) order by b.due_amount desc, r.number), '[]'::jsonb)
    into v_ending
  from public.reservations r
  join public.customers c on c.id = r.customer_id
  join public.reservation_balances b on b.reservation_id = r.id
  where r.workspace_id = p_workspace_id and r.status = 'confirmada' and r.end_date = v_today;

  select count(distinct r.customer_id) into v_debtors
  from public.reservations r join public.reservation_balances b on b.reservation_id = r.id
  where r.workspace_id = p_workspace_id and b.due_amount > 0;

  select * into v_session from public.cash_sessions
  where workspace_id = p_workspace_id and business_date = v_today;
  select * into v_old_open from public.cash_sessions
  where workspace_id = p_workspace_id and closed_at is null and business_date < v_today;

  select jsonb_build_object(
           'efectivo', coalesce(sum(amount) filter (where method = 'efectivo'), 0),
           'transferencia', coalesce(sum(amount) filter (where method = 'transferencia'), 0),
           'tarjeta', coalesce(sum(amount) filter (where method = 'tarjeta'), 0),
           'total', coalesce(sum(amount), 0))
    into v_income
  from public.cash_movements
  where cash_session_id = v_session.id and direction = 'entrada';

  select coalesce(sum(e.amount), 0) into v_expenses
  from public.expenses e where e.workspace_id = p_workspace_id and e.spent_on = v_today and e.voided_at is null;

  return jsonb_build_object(
    'fecha', v_today,
    'espacios', coalesce(v_counts, '{}'::jsonb),
    'ingresan_hoy', v_starting,
    'finalizan_hoy', v_ending,
    'clientes_con_deuda', v_debtors,
    'ingresos_hoy', coalesce(v_income, jsonb_build_object('efectivo', 0, 'transferencia', 0, 'tarjeta', 0, 'total', 0)),
    'gastos_hoy', v_expenses,
    'caja', case
              when v_session.id is null then jsonb_build_object('estado', 'sin_abrir')
              when v_session.closed_at is null then jsonb_build_object('estado', 'abierta', 'session_id', v_session.id)
              else jsonb_build_object('estado', 'cerrada', 'session_id', v_session.id)
            end,
    'caja_anterior_sin_cerrar', case when v_old_open.id is not null
              then jsonb_build_object('session_id', v_old_open.id, 'fecha', v_old_open.business_date) end
  );
end $$;

revoke all on function
  public.map_day_status(uuid, date),
  public.availability_grid(uuid, date, date, text),
  public.timeline_items(uuid, date, date),
  public.dashboard_summary(uuid)
  from public, anon;
grant execute on function
  public.map_day_status(uuid, date),
  public.availability_grid(uuid, date, date, text),
  public.timeline_items(uuid, date, date),
  public.dashboard_summary(uuid)
  to authenticated;
