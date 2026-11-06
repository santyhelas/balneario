-- ACTUALIZACIÓN 0030 · Planes (mensual / temporada) con débito automático de Mercado Pago.
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0029).
begin;
-- =====================================================================
-- 0030 · Planes de Mi Balneario (mensual o temporada) con débito automático.
--   · Cada balneario habilitado con plan tiene una "suscripción": plan, precio y
--     hasta qué día está pago.
--   · Mercado Pago debita solo (mensual: cada mes; temporada: cada 1/12). El servidor
--     recibe los avisos de Mercado Pago y extiende la fecha.
--   · Si el plan vence (el cliente canceló o rebotó el débito), a los 3 días de gracia
--     el balneario queda en "solo lectura": ve y descarga todo, pero no carga cambios.
--   · Los balnearios sin plan (por ejemplo el tuyo) no tienen vencimiento.
-- =====================================================================

-- Precios y reglas generales (los cambia el dueño desde su panel)
alter table private.plataforma add column if not exists precio_mensual   numeric(14,2) not null default 0 check (precio_mensual >= 0);
alter table private.plataforma add column if not exists precio_temporada numeric(14,2) not null default 0 check (precio_temporada >= 0);
alter table private.plataforma add column if not exists dias_gracia      integer not null default 3 check (dias_gracia between 0 and 30);

-- El correo habilitado lleva el plan contratado
alter table private.signup_allowlist add column if not exists plan text check (plan in ('mensual','temporada'));
alter table private.signup_allowlist add column if not exists price numeric(14,2) check (price >= 0);

create or replace function private.today_ar() returns date
language sql stable as $$ select (now() at time zone 'America/Argentina/Buenos_Aires')::date $$;

-- Fin de la temporada que incluye (o sigue a) una fecha: la temporada va del 1/12 al 31/3.
create or replace function private.season_end(p_day date) returns date
language sql immutable as $$
  select case when extract(month from p_day) <= 3 then make_date(extract(year from p_day)::int, 3, 31)
              else make_date(extract(year from p_day)::int + 1, 3, 31) end
$$;
-- Próximo 1/12 (el de este año si todavía no pasó).
create or replace function private.next_season_start(p_day date) returns date
language sql immutable as $$
  select case when p_day <= make_date(extract(year from p_day)::int, 12, 1) then make_date(extract(year from p_day)::int, 12, 1)
              else make_date(extract(year from p_day)::int + 1, 12, 1) end
$$;

create table public.subscriptions (
  workspace_id        uuid primary key references public.workspaces(id) on delete cascade,
  plan                text not null check (plan in ('mensual','temporada')),
  price               numeric(14,2) not null check (price >= 0),
  -- pendiente: todavía no activó el débito · activa: débito automático autorizado ·
  -- cancelada: el cliente decidió no renovar · manual: paga por transferencia/efectivo ·
  -- exenta: sin vencimiento
  status              text not null default 'pendiente' check (status in ('pendiente','activa','cancelada','manual','exenta')),
  paid_until          date,
  mp_preapproval_id   text unique,
  mp_payer_email      text,
  next_charge_on      date,
  last_payment_at     timestamptz,
  last_payment_status text check (last_payment_status in ('aprobado','rechazado')),
  last_payment_amount numeric(14,2),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
create policy "miembros ven su plan" on public.subscriptions for select to authenticated using (private.is_member(workspace_id));
revoke all on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;
grant select, insert, update on public.subscriptions to service_role;

create table public.subscription_events (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind         text not null check (kind in ('alta','debito_activado','pago_aprobado','pago_rechazado','cancelada','pago_manual','cambio_plan')),
  amount       numeric(14,2),
  detail       text,
  external_id  text,
  actor_id     uuid,
  created_at   timestamptz not null default now(),
  seen_at      timestamptz,
  unique (kind, external_id)
);
create index subscription_events_ws_idx on public.subscription_events (workspace_id, created_at desc);
alter table public.subscription_events enable row level security;
create policy "miembros ven los movimientos de su plan" on public.subscription_events for select to authenticated using (private.is_member(workspace_id));
revoke all on public.subscription_events from anon, authenticated;
grant select on public.subscription_events to authenticated;

-- ---------------------------------------------------------------------
-- ¿Puede cargar cambios? (pausa del dueño o plan vencido)
-- ---------------------------------------------------------------------
create or replace function private.plan_expired(p_ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.subscriptions s
    where s.workspace_id = p_ws and s.status <> 'exenta'
      and coalesce(s.paid_until, s.created_at::date) + (select dias_gracia from private.plataforma where id = 1) < private.today_ar()
  )
$$;

create or replace function private.block_if_paused() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ws text := coalesce(to_jsonb(new) ->> 'workspace_id', to_jsonb(old) ->> 'workspace_id');
begin
  if private.purging(v_ws) or private.restoring(v_ws) then
    return coalesce(new, old);
  end if;
  if exists (select 1 from public.workspaces w where w.id = v_ws::uuid and w.paused_at is not null) then
    raise exception 'Este balneario está en pausa: podés ver y descargar tus datos, pero no cargar cambios. Escribinos para reactivarlo.'
      using errcode = '42501', hint = 'PAUSADO';
  end if;
  if private.plan_expired(v_ws::uuid) then
    raise exception 'Tu plan de Mi Balneario venció: podés ver y descargar tus datos, pero no cargar cambios. Renovalo en Configuración → Mi plan.'
      using errcode = '42501', hint = 'PLAN_VENCIDO';
  end if;
  return coalesce(new, old);
end $$;

-- Hasta qué día queda pago después de un cobro.
create or replace function private.extend_until(p_plan text, p_current date, p_paid_on date) returns date
language sql immutable as $$
  select case p_plan
    when 'mensual' then (greatest(coalesce(p_current, p_paid_on), p_paid_on) + interval '1 month')::date
    else case when private.season_end(p_paid_on) > coalesce(p_current, p_paid_on - 1)
              then private.season_end(p_paid_on)
              else private.season_end(p_current + 1) end
  end
$$;

-- Al crear el balneario con un correo habilitado con plan, nace su suscripción.
-- Arranca con la fecha de hoy: tiene los días de gracia para activar el débito.
create or replace function private.allowlist_creates_subscription() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.workspace_id is not null and old.workspace_id is null and new.plan is not null then
    insert into public.subscriptions (workspace_id, plan, price, paid_until)
    values (new.workspace_id, new.plan,
            coalesce(new.price, (select case new.plan when 'mensual' then precio_mensual else precio_temporada end from private.plataforma where id = 1)),
            private.today_ar())
    on conflict (workspace_id) do nothing;
    insert into public.subscription_events (workspace_id, kind, detail) values (new.workspace_id, 'alta', 'Plan ' || new.plan);
  end if;
  return new;
end $$;
drop trigger if exists allowlist_creates_subscription on private.signup_allowlist;
create trigger allowlist_creates_subscription after update on private.signup_allowlist
  for each row execute function private.allowlist_creates_subscription();

-- ---------------------------------------------------------------------
-- Para el balneario: ver su plan y decidir no renovar (si no tiene débito)
-- ---------------------------------------------------------------------
create or replace function public.my_plan(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions%rowtype; v_grace int;
begin
  perform private.require_member(p_workspace_id);
  select * into s from public.subscriptions where workspace_id = p_workspace_id;
  if not found then return null; end if;
  select dias_gracia into v_grace from private.plataforma where id = 1;
  return jsonb_build_object(
    'plan', s.plan, 'precio', s.price, 'estado', s.status, 'pago_hasta', s.paid_until,
    'bloquea_desde', case when s.status = 'exenta' then null else coalesce(s.paid_until, s.created_at::date) + v_grace + 1 end,
    'vencido', private.plan_expired(p_workspace_id), 'dias_gracia', v_grace,
    'proximo_debito', s.next_charge_on, 'debito_automatico', s.mp_preapproval_id is not null and s.status = 'activa',
    'pagador', s.mp_payer_email, 'ultimo_pago', s.last_payment_at, 'ultimo_estado', s.last_payment_status,
    'temporada_hasta', private.season_end(private.today_ar()), 'hoy', private.today_ar(),
    'movimientos', coalesce((select jsonb_agg(jsonb_build_object('tipo', e.kind, 'importe', e.amount, 'detalle', e.detail, 'fecha', e.created_at) order by e.created_at desc)
                             from (select * from public.subscription_events where workspace_id = p_workspace_id order by created_at desc limit 12) e), '[]'::jsonb)
  );
end $$;
revoke all on function public.my_plan(uuid) from public, anon;
grant execute on function public.my_plan(uuid) to authenticated;

-- "No renovar" cuando no hay débito automático (si lo hay, lo cancela el servidor en Mercado Pago).
create or replace function public.cancel_my_plan(p_workspace_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions%rowtype;
begin
  perform private.require_member(p_workspace_id, array['propietario']);
  select * into s from public.subscriptions where workspace_id = p_workspace_id for update;
  if not found or s.status in ('cancelada','exenta') then raise exception 'No hay un plan para cancelar.'; end if;
  if s.mp_preapproval_id is not null and s.status = 'activa' then
    raise exception 'El débito automático se cancela desde el botón «No renovar» (avisa a Mercado Pago).';
  end if;
  update public.subscriptions set status = 'cancelada', updated_at = now() where workspace_id = p_workspace_id;
  insert into public.subscription_events (workspace_id, kind, detail, actor_id) values (p_workspace_id, 'cancelada', 'El cliente decidió no renovar', auth.uid());
end $$;
revoke all on function public.cancel_my_plan(uuid) from public, anon;
grant execute on function public.cancel_my_plan(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Para el servidor (Mercado Pago). Solo con la clave secreta (service_role).
-- ---------------------------------------------------------------------
create or replace function public.plan_for_checkout(p_workspace_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('plan', s.plan, 'precio', s.price, 'estado', s.status, 'preapproval', s.mp_preapproval_id,
                            'balneario', w.name, 'pago_hasta', s.paid_until, 'hoy', private.today_ar(),
                            'inicio_temporada', private.next_season_start(private.today_ar()))
  from public.subscriptions s join public.workspaces w on w.id = s.workspace_id
  where s.workspace_id = p_workspace_id
$$;

create or replace function public.plan_mp_link(p_workspace_id uuid, p_preapproval_id text, p_payer_email text) returns void
language sql security definer set search_path = '' as $$
  update public.subscriptions set mp_preapproval_id = p_preapproval_id, mp_payer_email = p_payer_email, updated_at = now()
  where workspace_id = p_workspace_id
$$;

-- Estado del débito según Mercado Pago (authorized / paused / cancelled / pending).
create or replace function public.plan_mp_status(p_preapproval_id text, p_status text, p_next_charge date, p_actor uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions%rowtype;
begin
  select * into s from public.subscriptions where mp_preapproval_id = p_preapproval_id for update;
  if not found then return; end if;
  if p_status = 'authorized' then
    -- Con el débito autorizado queda cubierto hasta el primer cobro (temporada: el 1/12).
    -- Si se suma con la temporada ya empezada, esta temporada no la cubre el débito
    -- (empieza el próximo 1/12): esa la registra el dueño como pago aparte.
    update public.subscriptions
       set status = 'activa', next_charge_on = p_next_charge,
           paid_until = case when s.plan = 'temporada' and extract(month from private.today_ar()) in (12, 1, 2, 3)
                             then paid_until
                             else greatest(coalesce(paid_until, private.today_ar()), coalesce(p_next_charge, private.today_ar())) end,
           updated_at = now()
     where workspace_id = s.workspace_id;
    if s.status <> 'activa' then
      insert into public.subscription_events (workspace_id, kind, detail, external_id)
      values (s.workspace_id, 'debito_activado', 'Débito automático activado en Mercado Pago', p_preapproval_id || ':authorized')
      on conflict (kind, external_id) do nothing;
    end if;
  elsif p_status in ('cancelled', 'paused') then
    if s.status = 'activa' then
      update public.subscriptions set status = 'cancelada', next_charge_on = null, updated_at = now() where workspace_id = s.workspace_id;
      insert into public.subscription_events (workspace_id, kind, detail, external_id, actor_id)
      values (s.workspace_id, 'cancelada',
              case when p_status = 'paused' then 'Débito pausado en Mercado Pago' else 'Débito automático cancelado: no se renueva' end,
              p_preapproval_id || ':' || p_status || ':' || now()::date, p_actor)
      on conflict (kind, external_id) do nothing;
    end if;
  else
    update public.subscriptions set next_charge_on = p_next_charge, updated_at = now() where workspace_id = s.workspace_id;
  end if;
end $$;

-- Un cobro del débito (aprobado o rechazado). No se aplica dos veces el mismo pago.
create or replace function public.plan_mp_payment(p_preapproval_id text, p_payment_id text, p_status text, p_amount numeric, p_paid_on date) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions%rowtype; v_new boolean;
begin
  select * into s from public.subscriptions where mp_preapproval_id = p_preapproval_id for update;
  if not found then return; end if;
  if p_status = 'approved' then
    insert into public.subscription_events (workspace_id, kind, amount, detail, external_id)
    values (s.workspace_id, 'pago_aprobado', p_amount, 'Débito automático (Mercado Pago)', p_payment_id)
    on conflict (kind, external_id) do nothing
    returning true into v_new;
    if v_new then
      update public.subscriptions
         set paid_until = private.extend_until(s.plan, s.paid_until, p_paid_on),
             last_payment_at = now(), last_payment_status = 'aprobado', last_payment_amount = p_amount, updated_at = now()
       where workspace_id = s.workspace_id;
    end if;
  elsif p_status = 'rejected' then
    insert into public.subscription_events (workspace_id, kind, amount, detail, external_id)
    values (s.workspace_id, 'pago_rechazado', p_amount, 'Mercado Pago no pudo debitar el plan', p_payment_id)
    on conflict (kind, external_id) do nothing
    returning true into v_new;
    if v_new then
      update public.subscriptions set last_payment_at = now(), last_payment_status = 'rechazado', last_payment_amount = p_amount, updated_at = now()
       where workspace_id = s.workspace_id;
    end if;
  end if;
end $$;

-- Balnearios con débito, para revisarlos una vez por día por si se perdió algún aviso.
create or replace function public.plan_mp_pending() returns setof text
language sql stable security definer set search_path = '' as $$
  select mp_preapproval_id from public.subscriptions where mp_preapproval_id is not null and status in ('pendiente','activa')
$$;

revoke all on function public.plan_for_checkout(uuid), public.plan_mp_link(uuid, text, text), public.plan_mp_status(text, text, date, uuid),
  public.plan_mp_payment(text, text, text, numeric, date), public.plan_mp_pending() from public, anon, authenticated;
grant execute on function public.plan_for_checkout(uuid), public.plan_mp_link(uuid, text, text), public.plan_mp_status(text, text, date, uuid),
  public.plan_mp_payment(text, text, text, numeric, date), public.plan_mp_pending() to service_role;
grant execute on function private.today_ar(), private.season_end(date), private.next_season_start(date), private.extend_until(text, date, date),
  private.plan_expired(uuid) to service_role;

-- ---------------------------------------------------------------------
-- Panel del dueño
-- ---------------------------------------------------------------------
create or replace function public.admin_set_prices(p_mensual numeric, p_temporada numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  if p_mensual is null or p_mensual < 0 or p_temporada is null or p_temporada < 0 then raise exception 'Precio inválido.'; end if;
  update private.plataforma set precio_mensual = p_mensual, precio_temporada = p_temporada where id = 1;
end $$;

drop function if exists public.admin_allow_signup(text, text);
create or replace function public.admin_allow_signup(p_email text, p_note text default null, p_plan text default null, p_price numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v text := lower(btrim(coalesce(p_email, '')));
begin
  perform private.require_platform_admin();
  if v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Correo inválido.'; end if;
  if p_plan is not null and p_plan not in ('mensual','temporada') then raise exception 'Plan inválido.'; end if;
  if p_price is not null and p_price < 0 then raise exception 'Precio inválido.'; end if;
  insert into private.signup_allowlist (email, note, plan, price) values (v, nullif(btrim(coalesce(p_note, '')), ''), p_plan, p_price)
  on conflict (email) do update set note = coalesce(excluded.note, private.signup_allowlist.note), plan = excluded.plan, price = excluded.price
  where private.signup_allowlist.used_at is null;
end $$;

-- Asignar o cambiar el plan de un balneario (también "exento" = sin vencimiento).
create or replace function public.admin_set_plan(p_workspace_id uuid, p_plan text, p_price numeric, p_exempt boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  if p_plan not in ('mensual','temporada') then raise exception 'Plan inválido.'; end if;
  if p_price is null or p_price < 0 then raise exception 'Precio inválido.'; end if;
  if not exists (select 1 from public.workspaces where id = p_workspace_id and not is_demo) then raise exception 'El balneario no existe.'; end if;
  insert into public.subscriptions (workspace_id, plan, price, status, paid_until)
  values (p_workspace_id, p_plan, p_price, case when p_exempt then 'exenta' else 'pendiente' end, private.today_ar())
  on conflict (workspace_id) do update
    set plan = excluded.plan, price = excluded.price,
        status = case when p_exempt then 'exenta'
                      when public.subscriptions.status = 'exenta' then 'pendiente'
                      else public.subscriptions.status end,
        updated_at = now();
  insert into public.subscription_events (workspace_id, kind, amount, detail, actor_id)
  values (p_workspace_id, 'cambio_plan', p_price, 'Plan ' || p_plan || case when p_exempt then ' (sin vencimiento)' else '' end, auth.uid());
end $$;

-- Pago por fuera de Mercado Pago (transferencia, efectivo): extiende el plan.
create or replace function public.admin_register_payment(p_workspace_id uuid, p_amount numeric, p_until date default null, p_note text default null) returns date
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions%rowtype; v_until date;
begin
  perform private.require_platform_admin();
  select * into s from public.subscriptions where workspace_id = p_workspace_id for update;
  if not found then raise exception 'Ese balneario no tiene plan. Asignale uno primero.'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Importe inválido.'; end if;
  v_until := coalesce(p_until, private.extend_until(s.plan, s.paid_until, private.today_ar()));
  if v_until < private.today_ar() then raise exception 'La fecha tiene que ser hoy o más adelante.'; end if;
  update public.subscriptions
     set paid_until = v_until, status = case when status in ('pendiente','cancelada') then 'manual' else status end,
         last_payment_at = now(), last_payment_status = 'aprobado', last_payment_amount = p_amount, updated_at = now()
   where workspace_id = p_workspace_id;
  insert into public.subscription_events (workspace_id, kind, amount, detail, actor_id)
  values (p_workspace_id, 'pago_manual', p_amount, coalesce(nullif(btrim(p_note), ''), 'Pago registrado a mano') || ' · pago hasta el ' || to_char(v_until, 'DD/MM/YYYY'), auth.uid());
  return v_until;
end $$;

create or replace function public.admin_mark_seen(p_event_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  update public.subscription_events set seen_at = now() where id = p_event_id and seen_at is null;
end $$;

-- Cantidad de avisos para el dueño (para el número rojo del menú).
create or replace function public.admin_alert_count() returns integer
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return (select count(*) from public.subscription_events where kind in ('cancelada','pago_rechazado') and seen_at is null)
       + (select count(*) from public.subscriptions s where private.plan_expired(s.workspace_id));
end $$;

create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_grace int;
begin
  perform private.require_platform_admin();
  select dias_gracia into v_grace from private.plataforma where id = 1;
  select jsonb_build_object(
    'balnearios', coalesce((
      select jsonb_agg(x order by (x ->> 'creado') desc) from (
        select jsonb_build_object(
          'id', w.id, 'nombre', w.name, 'creado', w.created_at, 'pausado', w.paused_at, 'motivo_pausa', w.paused_reason,
          'propietario', (select u.email::text from public.workspace_members m join auth.users u on u.id = m.user_id
                          where m.workspace_id = w.id and m.role = 'propietario' order by m.created_at limit 1),
          'usuarios', (select count(*) from public.workspace_members m where m.workspace_id = w.id),
          'carpas', (select count(*) from public.spaces s where s.workspace_id = w.id and s.active and s.kind = 'carpa'),
          'sombrillas', (select count(*) from public.spaces s where s.workspace_id = w.id and s.active and s.kind = 'sombrilla'),
          'reservas', (select count(*) from public.reservations r where r.workspace_id = w.id and r.status = 'confirmada'),
          'reservas_30d', (select count(*) from public.reservations r where r.workspace_id = w.id and r.created_at > now() - interval '30 days'),
          'ultimo_uso', (select max(a.at) from public.audit_log a where a.workspace_id = w.id),
          'plan', (select jsonb_build_object('plan', s.plan, 'precio', s.price, 'estado', s.status, 'pago_hasta', s.paid_until,
                                             'vencido', private.plan_expired(w.id), 'debito', s.mp_preapproval_id is not null and s.status = 'activa',
                                             'proximo_debito', s.next_charge_on, 'ultimo_estado', s.last_payment_status, 'ultimo_pago', s.last_payment_at)
                   from public.subscriptions s where s.workspace_id = w.id)
        ) as x
        from public.workspaces w
        where not w.is_demo
      ) t), '[]'::jsonb),
    'habilitaciones', coalesce((
      select jsonb_agg(jsonb_build_object('correo', a.email, 'nota', a.note, 'creado', a.created_at, 'usado', a.used_at,
                                          'plan', a.plan, 'precio', a.price,
                                          'balneario', (select name from public.workspaces where id = a.workspace_id))
                       order by a.created_at desc)
      from private.signup_allowlist a), '[]'::jsonb),
    'avisos', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'tipo', e.kind, 'balneario', w.name, 'workspace_id', e.workspace_id,
                                          'importe', e.amount, 'detalle', e.detail, 'fecha', e.created_at) order by e.created_at desc)
      from public.subscription_events e join public.workspaces w on w.id = e.workspace_id
      where e.kind in ('cancelada','pago_rechazado') and e.seen_at is null), '[]'::jsonb),
    'precios', (select jsonb_build_object('mensual', precio_mensual, 'temporada', precio_temporada, 'dias_gracia', dias_gracia) from private.plataforma where id = 1),
    'hoy', private.today_ar(),
    'demos_abiertas', (select count(*) from public.workspaces where is_demo)
  ) into v;
  return v;
end $$;

revoke all on function public.admin_set_prices(numeric, numeric), public.admin_allow_signup(text, text, text, numeric),
  public.admin_set_plan(uuid, text, numeric, boolean), public.admin_register_payment(uuid, numeric, date, text),
  public.admin_mark_seen(uuid), public.admin_alert_count() from public, anon;
grant execute on function public.admin_set_prices(numeric, numeric), public.admin_allow_signup(text, text, text, numeric),
  public.admin_set_plan(uuid, text, numeric, boolean), public.admin_register_payment(uuid, numeric, date, text),
  public.admin_mark_seen(uuid), public.admin_alert_count() to authenticated;

commit;
