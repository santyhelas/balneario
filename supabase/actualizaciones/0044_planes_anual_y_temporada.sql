begin;
-- =====================================================================
-- 0044 · Planes Anual y Temporada (entrada + 2 cuotas).
--   · Anual: un solo pago que cubre 12 meses.
--   · Temporada: una entrada al contratar y 2 cuotas iguales que vencen el 1/1 y el 1/2.
--     Entrada → pago hasta el 31/12 · cuota 1 → hasta el 31/1 · cuota 2 → hasta el 31/3.
--   · Los pagos los registra el dueño a mano (transferencia o efectivo).
--   · El plan "mensual" queda solo para lo que ya existía.
-- =====================================================================
alter table private.plataforma add column if not exists precio_anual      numeric(14,2) not null default 0 check (precio_anual >= 0);
alter table private.plataforma add column if not exists temporada_entrada numeric(14,2) not null default 0 check (temporada_entrada >= 0);
alter table private.plataforma add column if not exists temporada_cuota   numeric(14,2) not null default 0 check (temporada_cuota >= 0);

alter table private.signup_allowlist drop constraint if exists signup_allowlist_plan_check;
alter table private.signup_allowlist add constraint signup_allowlist_plan_check check (plan in ('mensual','anual','temporada'));
alter table private.signup_allowlist add column if not exists entry_amount numeric(14,2) check (entry_amount >= 0);
alter table private.signup_allowlist add column if not exists installment_amount numeric(14,2) check (installment_amount >= 0);

alter table public.subscriptions drop constraint if exists subscriptions_plan_check;
alter table public.subscriptions add constraint subscriptions_plan_check check (plan in ('mensual','anual','temporada'));
alter table public.subscriptions add column if not exists entry_amount numeric(14,2) check (entry_amount >= 0);
alter table public.subscriptions add column if not exists installment_amount numeric(14,2) check (installment_amount >= 0);
-- Cuántas partes de la temporada en curso se pagaron (0 a 3) y de qué temporada (su 31/3).
alter table public.subscriptions add column if not exists installments_paid integer not null default 0 check (installments_paid between 0 and 3);
alter table public.subscriptions add column if not exists season_end date;

-- Hasta qué día queda pago después de un cobro (anual: un año; temporada: lo resuelve el pago por cuotas).
create or replace function private.extend_until(p_plan text, p_current date, p_paid_on date) returns date
language sql immutable as $$
  select case p_plan
    when 'mensual' then (greatest(coalesce(p_current, p_paid_on), p_paid_on) + interval '1 month')::date
    when 'anual' then (greatest(coalesce(p_current, p_paid_on), p_paid_on) + interval '1 year')::date
    else case when private.season_end(p_paid_on) > coalesce(p_current, p_paid_on - 1)
              then private.season_end(p_paid_on)
              else private.season_end(p_current + 1) end
  end
$$;

-- Temporada: hasta cuándo cubre cada parte (1 = entrada, 2 = cuota de enero, 3 = cuota de febrero).
create or replace function private.season_part_until(p_season_end date, p_part integer) returns date
language sql immutable as $$
  select case p_part
    when 1 then make_date(extract(year from p_season_end)::int, 1, 1) - 1
    when 2 then make_date(extract(year from p_season_end)::int, 2, 1) - 1
    else p_season_end end
$$;

create or replace function private.allowlist_creates_subscription() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p private.plataforma%rowtype;
begin
  if new.workspace_id is not null and old.workspace_id is null and new.plan is not null then
    select * into p from private.plataforma where id = 1;
    insert into public.subscriptions (workspace_id, plan, price, entry_amount, installment_amount, paid_until, season_end)
    values (new.workspace_id, new.plan,
            coalesce(new.price, case new.plan when 'mensual' then p.precio_mensual when 'anual' then p.precio_anual
                                              else coalesce(new.entry_amount, p.temporada_entrada) + 2 * coalesce(new.installment_amount, p.temporada_cuota) end),
            case when new.plan = 'temporada' then coalesce(new.entry_amount, p.temporada_entrada) end,
            case when new.plan = 'temporada' then coalesce(new.installment_amount, p.temporada_cuota) end,
            private.today_ar(), private.season_end(private.today_ar()))
    on conflict (workspace_id) do nothing;
    insert into public.subscription_events (workspace_id, kind, detail) values (new.workspace_id, 'alta', 'Plan ' || new.plan);
  end if;
  return new;
end $$;

drop function if exists public.admin_set_prices(numeric, numeric);
create or replace function public.admin_set_prices(p_anual numeric, p_entrada numeric, p_cuota numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  if p_anual is null or p_anual < 0 or p_entrada is null or p_entrada < 0 or p_cuota is null or p_cuota < 0 then raise exception 'Precio inválido.'; end if;
  update private.plataforma set precio_anual = p_anual, temporada_entrada = p_entrada, temporada_cuota = p_cuota,
         precio_temporada = p_entrada + 2 * p_cuota where id = 1;
end $$;
revoke all on function public.admin_set_prices(numeric, numeric, numeric) from public, anon;
grant execute on function public.admin_set_prices(numeric, numeric, numeric) to authenticated;

drop function if exists public.admin_allow_signup(text, text, text, numeric, integer, integer);
create or replace function public.admin_allow_signup(p_email text, p_note text default null, p_plan text default null, p_price numeric default null,
                                                     p_tents integer default null, p_umbrellas integer default null,
                                                     p_entry numeric default null, p_installment numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v text := lower(btrim(coalesce(p_email, ''))); v_price numeric := p_price;
begin
  perform private.require_platform_admin();
  if v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Correo inválido.'; end if;
  if p_plan is not null and p_plan not in ('anual','temporada') then raise exception 'Plan inválido.'; end if;
  if p_plan = 'temporada' then
    if p_entry is null or p_entry < 0 or p_installment is null or p_installment < 0 then raise exception 'Poné la entrada y la cuota.'; end if;
    v_price := p_entry + 2 * p_installment;
  end if;
  if v_price is not null and v_price < 0 then raise exception 'Precio inválido.'; end if;
  if (p_tents is not null and (p_tents < 0 or p_tents > 600)) or (p_umbrellas is not null and (p_umbrellas < 0 or p_umbrellas > 300)) then
    raise exception 'Indicá hasta 600 carpas y 300 sombrillas.';
  end if;
  insert into private.signup_allowlist (email, note, plan, price, max_tents, max_umbrellas, entry_amount, installment_amount)
  values (v, nullif(btrim(coalesce(p_note, '')), ''), p_plan, v_price, p_tents, p_umbrellas,
          case when p_plan = 'temporada' then p_entry end, case when p_plan = 'temporada' then p_installment end)
  on conflict (email) do update set note = coalesce(excluded.note, private.signup_allowlist.note), plan = excluded.plan, price = excluded.price,
    max_tents = excluded.max_tents, max_umbrellas = excluded.max_umbrellas,
    entry_amount = excluded.entry_amount, installment_amount = excluded.installment_amount
  where private.signup_allowlist.used_at is null;
end $$;
revoke all on function public.admin_allow_signup(text, text, text, numeric, integer, integer, numeric, numeric) from public, anon;
grant execute on function public.admin_allow_signup(text, text, text, numeric, integer, integer, numeric, numeric) to authenticated;

drop function if exists public.admin_set_plan(uuid, text, numeric, boolean);
create or replace function public.admin_set_plan(p_workspace_id uuid, p_plan text, p_price numeric, p_exempt boolean default false,
                                                 p_entry numeric default null, p_installment numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_price numeric := p_price;
begin
  perform private.require_platform_admin();
  if p_plan not in ('anual','temporada') then raise exception 'Plan inválido.'; end if;
  if p_plan = 'temporada' then
    if p_entry is null or p_entry < 0 or p_installment is null or p_installment < 0 then raise exception 'Poné la entrada y la cuota.'; end if;
    v_price := p_entry + 2 * p_installment;
  end if;
  if v_price is null or v_price < 0 then raise exception 'Precio inválido.'; end if;
  if not exists (select 1 from public.workspaces where id = p_workspace_id and not is_demo) then raise exception 'El balneario no existe.'; end if;
  insert into public.subscriptions (workspace_id, plan, price, status, paid_until, entry_amount, installment_amount, season_end)
  values (p_workspace_id, p_plan, v_price, case when p_exempt then 'exenta' else 'pendiente' end, private.today_ar(),
          case when p_plan = 'temporada' then p_entry end, case when p_plan = 'temporada' then p_installment end,
          private.season_end(private.today_ar()))
  on conflict (workspace_id) do update
    set plan = excluded.plan, price = excluded.price, entry_amount = excluded.entry_amount, installment_amount = excluded.installment_amount,
        status = case when p_exempt then 'exenta'
                      when public.subscriptions.status = 'exenta' then 'pendiente'
                      else public.subscriptions.status end,
        updated_at = now();
  insert into public.subscription_events (workspace_id, kind, amount, detail, actor_id)
  values (p_workspace_id, 'cambio_plan', v_price,
          'Plan ' || p_plan || case when p_plan = 'temporada' then ' (entrada ' || p_entry || ' + 2 cuotas de ' || p_installment || ')' else '' end
          || case when p_exempt then ' (sin vencimiento)' else '' end, auth.uid());
end $$;
revoke all on function public.admin_set_plan(uuid, text, numeric, boolean, numeric, numeric) from public, anon;
grant execute on function public.admin_set_plan(uuid, text, numeric, boolean, numeric, numeric) to authenticated;

-- Pago registrado a mano. En Temporada cada pago es la parte que sigue (entrada, cuota 1, cuota 2).
create or replace function public.admin_register_payment(p_workspace_id uuid, p_amount numeric, p_until date default null, p_note text default null) returns date
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions%rowtype; v_until date; v_season date := private.season_end(private.today_ar()); v_part integer; v_label text;
begin
  perform private.require_platform_admin();
  select * into s from public.subscriptions where workspace_id = p_workspace_id for update;
  if not found then raise exception 'Ese balneario no tiene plan. Asignale uno primero.'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Importe inválido.'; end if;
  if s.plan = 'temporada' then
    -- Temporada nueva: vuelve a empezar por la entrada.
    v_part := case when s.season_end is distinct from v_season then 1 else least(s.installments_paid + 1, 3) end;
    v_label := case v_part when 1 then 'Entrada' when 2 then 'Cuota 1 de 2 (enero)' else 'Cuota 2 de 2 (febrero)' end;
    v_until := coalesce(p_until, greatest(private.season_part_until(v_season, v_part), private.today_ar()));
  else
    v_until := coalesce(p_until, private.extend_until(s.plan, s.paid_until, private.today_ar()));
  end if;
  if v_until < private.today_ar() then raise exception 'La fecha tiene que ser hoy o más adelante.'; end if;
  update public.subscriptions
     set paid_until = v_until, status = case when status in ('pendiente','cancelada') then 'manual' else status end,
         installments_paid = case when s.plan = 'temporada' then v_part else installments_paid end,
         season_end = case when s.plan = 'temporada' then v_season else season_end end,
         last_payment_at = now(), last_payment_status = 'aprobado', last_payment_amount = p_amount, updated_at = now()
   where workspace_id = p_workspace_id;
  insert into public.subscription_events (workspace_id, kind, amount, detail, actor_id)
  values (p_workspace_id, 'pago_manual', p_amount,
          coalesce(v_label || ' · ', '') || coalesce(nullif(btrim(p_note), ''), 'Pago registrado a mano') || ' · pago hasta el ' || to_char(v_until, 'DD/MM/YYYY'), auth.uid());
  return v_until;
end $$;

-- Para el balneario: su plan, con las partes de la temporada.
create or replace function public.my_plan(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions%rowtype; v_grace int; v_season date := private.season_end(private.today_ar()); v_paid int;
begin
  perform private.require_member(p_workspace_id);
  select * into s from public.subscriptions where workspace_id = p_workspace_id;
  if not found then return null; end if;
  select dias_gracia into v_grace from private.plataforma where id = 1;
  v_paid := case when s.season_end is distinct from v_season then 0 else s.installments_paid end;
  return jsonb_build_object(
    'plan', s.plan, 'precio', s.price, 'estado', s.status, 'pago_hasta', s.paid_until,
    'entrada', s.entry_amount, 'cuota', s.installment_amount, 'cuotas_pagas', v_paid,
    'partes', case when s.plan = 'temporada' then jsonb_build_array(
        jsonb_build_object('nombre', 'Entrada', 'importe', s.entry_amount, 'vence', null, 'pagada', v_paid >= 1),
        jsonb_build_object('nombre', 'Cuota 1', 'importe', s.installment_amount, 'vence', make_date(extract(year from v_season)::int, 1, 1), 'pagada', v_paid >= 2),
        jsonb_build_object('nombre', 'Cuota 2', 'importe', s.installment_amount, 'vence', make_date(extract(year from v_season)::int, 2, 1), 'pagada', v_paid >= 3)) end,
    'bloquea_desde', case when s.status = 'exenta' then null else coalesce(s.paid_until, s.created_at::date) + v_grace + 1 end,
    'vencido', private.plan_expired(p_workspace_id), 'dias_gracia', v_grace,
    'proximo_debito', s.next_charge_on, 'debito_automatico', s.mp_preapproval_id is not null and s.status = 'activa',
    'pagador', s.mp_payer_email, 'ultimo_pago', s.last_payment_at, 'ultimo_estado', s.last_payment_status,
    'temporada_hasta', v_season, 'hoy', private.today_ar(),
    'movimientos', coalesce((select jsonb_agg(jsonb_build_object('tipo', e.kind, 'importe', e.amount, 'detalle', e.detail, 'fecha', e.created_at) order by e.created_at desc)
                             from (select * from public.subscription_events where workspace_id = p_workspace_id order by created_at desc limit 12) e), '[]'::jsonb)
  );
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
          'max_carpas', w.max_tents, 'max_sombrillas', w.max_umbrellas, 'version', w.version,
          'reservas', (select count(*) from public.reservations r where r.workspace_id = w.id and r.status = 'confirmada'),
          'reservas_30d', (select count(*) from public.reservations r where r.workspace_id = w.id and r.created_at > now() - interval '30 days'),
          'ultimo_uso', (select max(a.at) from public.audit_log a where a.workspace_id = w.id),
          'plan', (select jsonb_build_object('plan', s.plan, 'precio', s.price, 'estado', s.status, 'pago_hasta', s.paid_until,
                                             'entrada', s.entry_amount, 'cuota', s.installment_amount,
                                             'cuotas_pagas', case when s.season_end is distinct from private.season_end(private.today_ar()) then 0 else s.installments_paid end,
                                             'vencido', private.plan_expired(w.id), 'debito', s.mp_preapproval_id is not null and s.status = 'activa',
                                             'proximo_debito', s.next_charge_on, 'ultimo_estado', s.last_payment_status, 'ultimo_pago', s.last_payment_at)
                   from public.subscriptions s where s.workspace_id = w.id)
        ) as x
        from public.workspaces w
        where not w.is_demo
      ) t), '[]'::jsonb),
    'habilitaciones', coalesce((
      select jsonb_agg(jsonb_build_object('correo', a.email, 'nota', a.note, 'creado', a.created_at, 'usado', a.used_at,
                                          'plan', a.plan, 'precio', a.price, 'entrada', a.entry_amount, 'cuota', a.installment_amount, 'carpas', a.max_tents, 'sombrillas', a.max_umbrellas,
                                          'balneario', (select name from public.workspaces where id = a.workspace_id))
                       order by a.created_at desc)
      from private.signup_allowlist a), '[]'::jsonb),
    'avisos', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'tipo', e.kind, 'balneario', w.name, 'workspace_id', e.workspace_id,
                                          'importe', e.amount, 'detalle', e.detail, 'fecha', e.created_at) order by e.created_at desc)
      from public.subscription_events e join public.workspaces w on w.id = e.workspace_id
      where e.kind in ('cancelada','pago_rechazado') and e.seen_at is null), '[]'::jsonb),
    'precios', (select jsonb_build_object('mensual', precio_mensual, 'temporada', precio_temporada, 'anual', precio_anual,
                                          'entrada', temporada_entrada, 'cuota', temporada_cuota, 'dias_gracia', dias_gracia) from private.plataforma where id = 1),
    'hoy', private.today_ar(),
    'demos_abiertas', (select count(*) from public.workspaces where is_demo)
  ) into v;
  return v;
end $$;

commit;
