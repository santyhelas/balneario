-- 0055 · Gastos del dueño de Mi Balneario (servidores, dominio, publicidad, etc.), por año.
-- Los carga el dueño desde /dueno/gastos. No se borran: se anulan (queda el registro).

create table if not exists private.owner_expenses (
  id         uuid primary key default gen_random_uuid(),
  spent_on   date not null,
  concept    text not null check (char_length(btrim(concept)) between 2 and 120),
  category   text not null check (category in ('servidores','dominio_correo','publicidad','herramientas','viajes','impuestos','otros')),
  amount     numeric(14,2) not null check (amount > 0),
  notes      text check (char_length(notes) <= 500),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  voided_at  timestamptz,
  voided_by  uuid,
  void_reason text
);
create index if not exists owner_expenses_date_idx on private.owner_expenses(spent_on);
alter table private.owner_expenses enable row level security;
revoke all on private.owner_expenses from public, anon, authenticated;

create or replace function public.admin_add_expense(p_date date, p_concept text, p_category text, p_amount numeric, p_notes text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_platform_admin();
  if p_date is null or p_date > private.today_ar() + 366 then raise exception 'Fecha inválida.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'El importe tiene que ser mayor a cero.'; end if;
  if char_length(btrim(coalesce(p_concept, ''))) < 2 then raise exception 'Poné el concepto del gasto.'; end if;
  insert into private.owner_expenses (spent_on, concept, category, amount, notes, created_by)
  values (p_date, btrim(p_concept), p_category, round(p_amount, 2), nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.admin_add_expense(date, text, text, numeric, text) from public, anon;
grant execute on function public.admin_add_expense(date, text, text, numeric, text) to authenticated;

create or replace function public.admin_void_expense(p_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  update private.owner_expenses set voided_at = now(), voided_by = auth.uid(), void_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_id and voided_at is null;
  if not found then raise exception 'Ese gasto no existe o ya estaba anulado.'; end if;
end $$;
revoke all on function public.admin_void_expense(uuid, text) from public, anon;
grant execute on function public.admin_void_expense(uuid, text) to authenticated;

-- Gastos de un año: la lista, el total por mes y por categoría, y lo cobrado ese año (para ver qué queda).
create or replace function public.admin_expenses(p_year integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_from date := make_date(p_year, 1, 1); v_to date := make_date(p_year + 1, 1, 1);
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'anio', p_year,
    'gastos', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'fecha', e.spent_on, 'concepto', e.concept, 'categoria', e.category,
                         'importe', e.amount, 'notas', e.notes, 'anulado', e.voided_at, 'motivo_anulacion', e.void_reason) order by e.spent_on desc, e.created_at desc)
                        from private.owner_expenses e where e.spent_on >= v_from and e.spent_on < v_to), '[]'::jsonb),
    'por_mes', (select jsonb_agg(jsonb_build_object('mes', m,
                  'gastos', coalesce((select sum(e.amount) from private.owner_expenses e where e.voided_at is null and extract(month from e.spent_on) = m and e.spent_on >= v_from and e.spent_on < v_to), 0),
                  'cobrado', coalesce((select sum(s.amount) from public.subscription_events s where s.kind in ('pago_manual','pago_aprobado')
                                        and (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date >= v_from
                                        and (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date < v_to
                                        and extract(month from (s.created_at at time zone 'America/Argentina/Buenos_Aires')) = m), 0)) order by m)
                 from generate_series(1, 12) m),
    'por_categoria', coalesce((select jsonb_object_agg(category, total) from (
                       select category, sum(amount) total from private.owner_expenses
                        where voided_at is null and spent_on >= v_from and spent_on < v_to group by category) c), '{}'::jsonb),
    'anios', coalesce((select jsonb_agg(distinct extract(year from spent_on)::int) from private.owner_expenses), '[]'::jsonb)
  );
end $$;
revoke all on function public.admin_expenses(integer) from public, anon;
grant execute on function public.admin_expenses(integer) to authenticated;
