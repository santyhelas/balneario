-- =====================================================================
-- 0010 · Identidad del balneario (logo, subtítulo), perfil del usuario,
--        copias de seguridad (manuales y automáticas) e informes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Logo y subtítulo del balneario. La imagen se guarda en la base
-- (achicada en el navegador, máx. ~300 KB), no en la computadora.
-- ---------------------------------------------------------------------
alter table public.workspaces
  add column logo_data text check (logo_data is null or (logo_data like 'data:image/%' and char_length(logo_data) <= 400000)),
  add column subtitle text check (char_length(subtitle) <= 80);
grant update (logo_data, subtitle) on public.workspaces to authenticated;

-- Foto y nombre visible de cada usuario (se sincroniza entre dispositivos).
alter table public.user_preferences
  add column avatar_data text check (avatar_data is null or (avatar_data like 'data:image/%' and char_length(avatar_data) <= 200000)),
  add column display_name text check (char_length(display_name) <= 80);

-- ---------------------------------------------------------------------
-- Copias de seguridad
-- Guardan una foto completa de los datos del balneario (clientes, reservas,
-- tramos, pagos, caja, gastos, tarifas, configuración e historial).
-- ---------------------------------------------------------------------
create table public.backups (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  kind         text not null check (kind in ('manual','automatica')),
  note         text check (char_length(note) <= 200),
  counts       jsonb not null,
  size_bytes   integer not null,
  data         jsonb not null,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  created_by_email text
);
create index backups_ws_idx on public.backups(workspace_id, created_at desc);

alter table public.backups enable row level security;
create policy "miembros ven copias" on public.backups for select to authenticated using (private.is_member(workspace_id));
revoke all on public.backups from anon, authenticated;
grant select on public.backups to authenticated;

create or replace function private.snapshot(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb := '{}'::jsonb;
  t text;
  v_rows jsonb;
begin
  foreach t in array array[
    'spaces','map_features','customers','agreements','expense_categories','package_discounts','rates',
    'reservations','reservation_changes','reservation_segments','reservation_charges','reservation_discounts',
    'maintenance_blocks','cash_sessions','payments','expenses','cash_movements','workspace_members','audit_log'
  ] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I x where x.workspace_id = $1', t)
      into v_rows using p_ws;
    v := v || jsonb_build_object(t, v_rows);
  end loop;
  select v || jsonb_build_object('workspace', to_jsonb(w) - 'logo_data') into v from public.workspaces w where w.id = p_ws;
  return v;
end $$;

-- Crea una copia. La automática se hace como máximo una vez cada 20 horas
-- (la pide la aplicación al abrirse) y se conservan las últimas 30.
create or replace function public.create_backup(p_workspace_id uuid, p_kind text default 'manual', p_note text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_data jsonb;
  v_counts jsonb;
  v_id uuid;
  v_size integer;
begin
  if p_kind = 'manual' then
    perform private.require_member(p_workspace_id, array['propietario','administrador']);
  elsif p_kind = 'automatica' then
    perform private.require_member(p_workspace_id);
    perform pg_advisory_xact_lock(hashtextextended('copia:' || p_workspace_id::text, 0));
    if exists (select 1 from public.backups where workspace_id = p_workspace_id and kind = 'automatica'
               and created_at > now() - interval '20 hours') then
      return jsonb_build_object('creada', false);
    end if;
  else
    raise exception 'Tipo de copia inválido.';
  end if;

  v_data := private.snapshot(p_workspace_id);
  select jsonb_object_agg(key, jsonb_array_length(value)) into v_counts
  from jsonb_each(v_data) where jsonb_typeof(value) = 'array';
  v_size := octet_length(v_data::text);

  insert into public.backups (workspace_id, kind, note, counts, size_bytes, data, created_by_email)
  values (p_workspace_id, p_kind, nullif(btrim(p_note), ''), v_counts, v_size, v_data,
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  returning id into v_id;

  delete from public.backups where id in (
    select id from public.backups where workspace_id = p_workspace_id and kind = 'automatica'
    order by created_at desc offset 30);

  return jsonb_build_object('creada', true, 'backup_id', v_id, 'counts', v_counts, 'size_bytes', v_size);
end $$;

revoke all on function public.create_backup(uuid, text, text) from public, anon;
grant execute on function public.create_backup(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Informes de un período (máx. 400 días). Todo sale de los registros reales.
-- Diferencia siempre lo CONTRATADO (precio de las reservas) de lo COBRADO (caja).
-- ---------------------------------------------------------------------
create or replace function public.report_summary(p_workspace_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_res jsonb := '{}'::jsonb;
begin
  perform private.require_member(p_workspace_id);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Elegí un período válido (hasta 400 días).';
  end if;

  -- Ocupación por día (espacios ocupados sobre espacios activos de cada tipo)
  v_res := v_res || jsonb_build_object('ocupacion', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'dia', d.day,
             'carpas', coalesce(o.carpas, 0), 'sombrillas', coalesce(o.sombrillas, 0),
             'cortesias', coalesce(o.cortesias, 0)) order by d.day), '[]'::jsonb)
    from (select gs::date as day from generate_series(p_from, p_to, interval '1 day') gs) d
    left join lateral (
      select count(*) filter (where sp.kind = 'carpa') as carpas,
             count(*) filter (where sp.kind = 'sombrilla') as sombrillas,
             count(*) filter (where r.is_courtesy) as cortesias
      from public.reservation_segments s
      join public.spaces sp on sp.id = s.space_id
      join public.reservations r on r.id = s.reservation_id
      where s.workspace_id = p_workspace_id and s.active and d.day between s.start_date and s.end_date
    ) o on true));
  v_res := v_res || jsonb_build_object('activos', (
    select jsonb_build_object('carpas', count(*) filter (where kind = 'carpa' and active),
                              'sombrillas', count(*) filter (where kind = 'sombrilla' and active))
    from public.spaces where workspace_id = p_workspace_id));

  -- Contratado: reservas confirmadas que comienzan en el período
  v_res := v_res || jsonb_build_object('contratado', (
    select jsonb_build_object(
      'reservas', count(*),
      'precio_lista', coalesce(sum(list_amount), 0),
      'descuentos', coalesce(sum(discount_amount), 0),
      'total', coalesce(sum(total_amount), 0),
      'cortesias', count(*) filter (where is_courtesy),
      'cortesias_dias', coalesce(sum(end_date - start_date + 1) filter (where is_courtesy), 0),
      'cortesias_valor', coalesce(sum(list_amount) filter (where is_courtesy), 0),
      'canceladas', (select count(*) from public.reservations c where c.workspace_id = p_workspace_id
                     and c.status = 'cancelada' and c.start_date between p_from and p_to))
    from public.reservations
    where workspace_id = p_workspace_id and status = 'confirmada' and start_date between p_from and p_to));

  -- Cobrado (caja): por tipo y medio de pago
  v_res := v_res || jsonb_build_object('caja_movimientos', (
    select coalesce(jsonb_agg(jsonb_build_object('categoria', category, 'medio', method, 'sentido', direction,
                                                 'importe', total, 'cantidad', n)), '[]'::jsonb)
    from (
      select m.category, m.method, m.direction, sum(m.amount) as total, count(*) as n
      from public.cash_movements m join public.cash_sessions s on s.id = m.cash_session_id
      where s.workspace_id = p_workspace_id and s.business_date between p_from and p_to
      group by m.category, m.method, m.direction
    ) x));

  -- Cobrado por día (entradas por cobros y otros ingresos, menos devoluciones y anulaciones de cobros)
  v_res := v_res || jsonb_build_object('cobrado_por_dia', (
    select coalesce(jsonb_agg(jsonb_build_object('dia', business_date, 'cobrado', cobrado, 'gastos', gastos) order by business_date), '[]'::jsonb)
    from (
      select s.business_date,
             coalesce(sum(case when m.category in ('cobro','otro_ingreso','anulacion_devolucion') then m.amount
                               when m.category in ('devolucion','anulacion_cobro') then -m.amount end), 0) as cobrado,
             coalesce(sum(case when m.category = 'gasto' then m.amount when m.category = 'anulacion_gasto' then -m.amount end), 0) as gastos
      from public.cash_sessions s left join public.cash_movements m on m.cash_session_id = s.id
      where s.workspace_id = p_workspace_id and s.business_date between p_from and p_to
      group by s.business_date
    ) x));

  -- Gastos por categoría (no anulados)
  v_res := v_res || jsonb_build_object('gastos', (
    select coalesce(jsonb_agg(jsonb_build_object('categoria', c.name, 'importe', t.total, 'cantidad', t.n,
                                                 'efectivo', t.efectivo) order by t.total desc), '[]'::jsonb)
    from (select e.category_id, sum(e.amount) as total, count(*) as n,
                 sum(e.amount) filter (where e.method = 'efectivo') as efectivo
          from public.expenses e
          where e.workspace_id = p_workspace_id and e.voided_at is null and e.spent_on between p_from and p_to
          group by e.category_id) t
    join public.expense_categories c on c.id = t.category_id));

  -- Cierres de caja y diferencias
  v_res := v_res || jsonb_build_object('cierres', (
    select coalesce(jsonb_agg(jsonb_build_object('fecha', business_date, 'apertura', opening_cash, 'esperado', expected_cash,
                                                 'contado', counted_cash, 'diferencia', difference, 'notas', close_notes)
                              order by business_date), '[]'::jsonb)
    from public.cash_sessions
    where workspace_id = p_workspace_id and business_date between p_from and p_to and closed_at is not null));

  -- Descuentos aplicados (reservas confirmadas que comienzan en el período)
  v_res := v_res || jsonb_build_object('descuentos', (
    select coalesce(jsonb_agg(jsonb_build_object('tipo', kind, 'detalle', label, 'importe', total, 'cantidad', n)
                              order by total desc), '[]'::jsonb)
    from (select d.kind, d.label, sum(d.amount) as total, count(*) as n
          from public.reservation_discounts d join public.reservations r on r.id = d.reservation_id
          where r.workspace_id = p_workspace_id and r.status = 'confirmada' and r.start_date between p_from and p_to
          group by d.kind, d.label) x));

  -- Deudas pendientes hoy (no dependen del período)
  v_res := v_res || jsonb_build_object('deudas', (
    select coalesce(jsonb_agg(jsonb_build_object('reserva', r.number, 'reservation_id', r.id,
             'cliente', btrim(c.first_name || ' ' || c.last_name), 'telefono', c.phone,
             'desde', r.start_date, 'hasta', r.end_date, 'total', r.total_amount, 'saldo', b.due_amount)
             order by r.end_date), '[]'::jsonb)
    from public.reservation_balances b
    join public.reservations r on r.id = b.reservation_id
    join public.customers c on c.id = r.customer_id
    where b.workspace_id = p_workspace_id and b.due_amount > 0));

  -- Clientes frecuentes (2 o más reservas confirmadas en total)
  v_res := v_res || jsonb_build_object('frecuentes', (
    select coalesce(jsonb_agg(x order by (x ->> 'reservas')::int desc, (x ->> 'pagado')::numeric desc), '[]'::jsonb)
    from (
      select jsonb_build_object('cliente', btrim(c.first_name || ' ' || c.last_name), 'customer_id', c.id, 'telefono', c.phone,
               'reservas', count(r.id), 'dias', sum(r.end_date - r.start_date + 1),
               'pagado', coalesce(sum(b.paid_amount), 0), 'ultima', max(r.start_date)) as x
      from public.customers c
      join public.reservations r on r.customer_id = c.id and r.status = 'confirmada'
      join public.reservation_balances b on b.reservation_id = r.id
      where c.workspace_id = p_workspace_id
      group by c.id
      having count(r.id) >= 2
      order by count(r.id) desc
      limit 30
    ) t));

  return v_res;
end $$;

revoke all on function public.report_summary(uuid, date, date) from public, anon;
grant execute on function public.report_summary(uuid, date, date) to authenticated;
