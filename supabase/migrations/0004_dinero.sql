-- =====================================================================
-- 0004 · Caja diaria, pagos, devoluciones, anulaciones, gastos.
-- Los registros de dinero son inmutables: los errores se corrigen
-- con una anulación que queda registrada, nunca borrando.
-- =====================================================================

create table public.cash_sessions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete restrict,
  business_date date not null,
  opening_cash  numeric(14,2) not null check (opening_cash >= 0),
  opening_notes text check (char_length(opening_notes) <= 1000),
  opened_at     timestamptz not null default now(),
  opened_by     uuid not null default auth.uid(),
  closed_at     timestamptz,
  closed_by     uuid,
  counted_cash  numeric(14,2) check (counted_cash >= 0),
  expected_cash numeric(14,2),
  difference    numeric(14,2),
  close_notes   text check (char_length(close_notes) <= 1000),
  version       integer not null default 1,
  unique (workspace_id, id),
  unique (workspace_id, business_date),
  check ((closed_at is null) = (counted_cash is null)),
  check ((closed_at is null) = (expected_cash is null)),
  check (difference is null or difference = counted_cash - expected_cash)
);
-- Solo puede haber una caja abierta a la vez por balneario.
create unique index cash_sessions_one_open on public.cash_sessions(workspace_id) where closed_at is null;

create trigger cash_sessions_version before update on public.cash_sessions
  for each row execute function private.check_version();
create trigger cash_sessions_audit after insert or update on public.cash_sessions
  for each row execute function private.audit();
create trigger cash_sessions_no_delete before delete on public.cash_sessions
  for each row execute function private.forbid_change();

-- Una caja cerrada no se reabre ni se modifica.
create or replace function private.cash_sessions_guard() returns trigger
language plpgsql as $$
begin
  if old.closed_at is not null then
    raise exception 'Esta caja ya está cerrada y no se puede modificar.' using errcode = '42501';
  end if;
  if new.opening_cash <> old.opening_cash or new.business_date <> old.business_date then
    raise exception 'La apertura de caja no se puede modificar.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger cash_sessions_guard before update on public.cash_sessions
  for each row execute function private.cash_sessions_guard();

-- ---------------------------------------------------------------------
-- Pagos vinculados a reservas
--   cobro       → dinero que entra (seña, pago parcial, pago total)
--   devolucion  → dinero que se le devuelve al cliente
--   anulacion   → corrige un cobro o devolución cargado por error
-- signed_amount: efecto sobre lo cobrado (+ entra, − sale)
-- ---------------------------------------------------------------------
create table public.payments (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  reservation_id   uuid not null,
  kind             text not null check (kind in ('cobro','devolucion','anulacion')),
  amount           numeric(14,2) not null check (amount > 0),
  signed_amount    numeric(14,2) not null,
  method           text not null check (method in ('efectivo','transferencia','tarjeta')),
  voids_payment_id uuid references public.payments(id),
  cash_session_id  uuid not null,
  idempotency_key  uuid not null,
  note             text check (char_length(note) <= 500),
  reason           text check (char_length(reason) <= 300),
  created_by       uuid not null default auth.uid(),
  created_at       timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, reservation_id) references public.reservations(workspace_id, id),
  foreign key (workspace_id, cash_session_id) references public.cash_sessions(workspace_id, id),
  check (abs(signed_amount) = amount),
  check ((kind = 'anulacion') = (voids_payment_id is not null)),
  check (kind = 'cobro' or char_length(btrim(coalesce(reason, ''))) >= 3)
);
create unique index payments_one_void on public.payments(voids_payment_id) where voids_payment_id is not null;
create index payments_reservation_idx on public.payments(reservation_id);
create index payments_ws_created_idx on public.payments(workspace_id, created_at);

create trigger payments_immutable before update or delete on public.payments
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------
-- Gastos efectivamente pagados
-- ---------------------------------------------------------------------
create table public.expenses (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  cash_session_id uuid not null,
  amount          numeric(14,2) not null check (amount > 0),
  spent_on        date not null,
  concept         text not null check (char_length(btrim(concept)) between 2 and 200),
  category_id     uuid not null,
  supplier        text check (char_length(supplier) <= 120),
  method          text not null check (method in ('efectivo','transferencia','tarjeta')),
  notes           text check (char_length(notes) <= 1000),
  idempotency_key uuid not null,
  created_by      uuid not null default auth.uid(),
  created_at      timestamptz not null default now(),
  voided_at       timestamptz,
  voided_by       uuid,
  void_reason     text,
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, cash_session_id) references public.cash_sessions(workspace_id, id),
  foreign key (workspace_id, category_id) references public.expense_categories(workspace_id, id),
  check ((voided_at is null) = (void_reason is null))
);
create index expenses_ws_date_idx on public.expenses(workspace_id, spent_on);

-- Un gasto solo puede anularse (una vez); nada más se modifica.
create or replace function private.expenses_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Los gastos no se borran; se anulan.' using errcode = '42501';
  end if;
  if old.voided_at is not null
     or (to_jsonb(new) - 'voided_at' - 'voided_by' - 'void_reason') <> (to_jsonb(old) - 'voided_at' - 'voided_by' - 'void_reason') then
    raise exception 'Un gasto registrado no se puede modificar; solo anular.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger expenses_guard before update or delete on public.expenses
  for each row execute function private.expenses_guard();
create trigger expenses_audit after insert or update on public.expenses
  for each row execute function private.audit();

-- ---------------------------------------------------------------------
-- Movimientos de caja (entradas y salidas, por medio de pago)
-- ---------------------------------------------------------------------
create table public.cash_movements (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  cash_session_id uuid not null,
  direction       text not null check (direction in ('entrada','salida')),
  method          text not null check (method in ('efectivo','transferencia','tarjeta')),
  amount          numeric(14,2) not null check (amount > 0),
  category        text not null check (category in ('cobro','devolucion','anulacion_cobro','anulacion_devolucion',
                                                    'gasto','anulacion_gasto','otro_ingreso')),
  concept         text not null check (char_length(concept) <= 200),
  payment_id      uuid unique,
  expense_id      uuid,
  idempotency_key uuid,
  created_by      uuid not null default auth.uid(),
  created_at      timestamptz not null default now(),
  foreign key (workspace_id, cash_session_id) references public.cash_sessions(workspace_id, id),
  foreign key (workspace_id, payment_id) references public.payments(workspace_id, id),
  foreign key (workspace_id, expense_id) references public.expenses(workspace_id, id),
  unique (workspace_id, idempotency_key),
  check ((category in ('cobro','devolucion','anulacion_cobro','anulacion_devolucion')) = (payment_id is not null)),
  check ((category in ('gasto','anulacion_gasto')) = (expense_id is not null)),
  check (category <> 'otro_ingreso' or idempotency_key is not null)
);
create unique index cash_movements_expense_once on public.cash_movements(expense_id, category) where expense_id is not null;
create index cash_movements_session_idx on public.cash_movements(cash_session_id);

create trigger cash_movements_immutable before update or delete on public.cash_movements
  for each row execute function private.forbid_change();

-- Una caja cerrada no acepta movimientos nuevos.
create or replace function private.cash_movements_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.cash_sessions s where s.id = new.cash_session_id and s.closed_at is not null) then
    raise exception 'La caja ya está cerrada; no se pueden agregar movimientos.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger cash_movements_guard before insert on public.cash_movements
  for each row execute function private.cash_movements_guard();

-- ---------------------------------------------------------------------
-- Saldo de cada reserva calculado con los pagos reales
-- ---------------------------------------------------------------------
create view public.reservation_balances with (security_invoker = true) as
select
  r.id as reservation_id,
  r.workspace_id,
  r.status,
  r.total_amount,
  coalesce(p.paid, 0)::numeric(14,2) as paid_amount,
  case when r.status = 'cancelada' then 0
       else greatest(r.total_amount - coalesce(p.paid, 0), 0) end::numeric(14,2) as due_amount,
  case when r.status = 'cancelada' then coalesce(p.paid, 0)
       else greatest(coalesce(p.paid, 0) - r.total_amount, 0) end::numeric(14,2) as credit_amount
from public.reservations r
left join (
  select reservation_id, sum(signed_amount) as paid from public.payments group by reservation_id
) p on p.reservation_id = r.id;

-- ---------------------------------------------------------------------
-- Funciones internas
-- ---------------------------------------------------------------------

-- Devuelve la caja abierta de hoy (y la bloquea para que no se cierre
-- mientras se registra el movimiento). Explica el problema si no la hay.
create or replace function private.today_session(p_workspace_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := private.ws_today(p_workspace_id);
  v_session public.cash_sessions%rowtype;
begin
  select * into v_session from public.cash_sessions
  where workspace_id = p_workspace_id and closed_at is null
  for share;
  if not found then
    raise exception 'La caja de hoy no está abierta. Abrila para registrar cobros o gastos.'
      using hint = 'CAJA_CERRADA';
  end if;
  if v_session.business_date <> v_today then
    raise exception 'La caja del % quedó sin cerrar. Cerrala antes de registrar movimientos de hoy.',
      to_char(v_session.business_date, 'DD/MM/YYYY') using hint = 'CAJA_ANTERIOR_ABIERTA';
  end if;
  return v_session.id;
end $$;

-- Registra un cobro, devolución o anulación de forma idempotente:
-- si se reintenta con la misma clave, devuelve el pago ya existente.
create or replace function private.record_payment(
  p_workspace_id uuid, p_reservation_id uuid, p_kind text, p_amount numeric, p_method text,
  p_idempotency_key uuid, p_note text, p_reason text, p_voids_payment_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.payments%rowtype;
  v_res public.reservations%rowtype;
  v_orig public.payments%rowtype;
  v_session uuid;
  v_paid numeric(14,2);
  v_signed numeric(14,2);
  v_amount numeric(14,2) := round(p_amount, 2);
  v_id uuid;
  v_category text;
  v_concept text;
begin
  if p_idempotency_key is null then
    raise exception 'Falta la clave de operación.';
  end if;

  select * into v_existing from public.payments
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.reservation_id <> p_reservation_id or v_existing.kind <> p_kind
       or (p_kind <> 'anulacion' and (v_existing.amount <> v_amount or v_existing.method <> p_method)) then
      raise exception 'Esta operación ya fue registrada con otros datos.';
    end if;
    return v_existing.id;
  end if;

  v_session := private.today_session(p_workspace_id);

  -- Bloquea la reserva: dos pagos simultáneos se procesan de a uno.
  select * into v_res from public.reservations
  where id = p_reservation_id and workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'La reserva no existe.';
  end if;

  -- Reintento simultáneo con la misma clave: el otro ya terminó.
  select * into v_existing from public.payments
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return v_existing.id;
  end if;

  select coalesce(sum(signed_amount), 0) into v_paid from public.payments where reservation_id = p_reservation_id;

  if p_kind = 'cobro' then
    if v_res.status = 'cancelada' then
      raise exception 'No se pueden registrar cobros en una reserva cancelada.';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'El importe debe ser mayor a cero.';
    end if;
    if v_amount > v_res.total_amount - v_paid then
      raise exception 'El cobro (%) supera el saldo pendiente (%).',
        to_char(v_amount, 'FM999G999G990D00'), to_char(greatest(v_res.total_amount - v_paid, 0), 'FM999G999G990D00');
    end if;
    v_signed := v_amount;
    v_category := 'cobro';
    v_concept := format('Cobro reserva #%s', v_res.number);

  elsif p_kind = 'devolucion' then
    if v_amount is null or v_amount <= 0 then
      raise exception 'El importe debe ser mayor a cero.';
    end if;
    if v_amount > v_paid then
      raise exception 'La devolución supera lo cobrado en la reserva.';
    end if;
    v_signed := -v_amount;
    v_category := 'devolucion';
    v_concept := format('Devolución reserva #%s', v_res.number);

  elsif p_kind = 'anulacion' then
    select * into v_orig from public.payments
    where id = p_voids_payment_id and reservation_id = p_reservation_id;
    if not found then
      raise exception 'El pago a anular no existe en esta reserva.';
    end if;
    if v_orig.kind = 'anulacion' then
      raise exception 'Una anulación no se puede anular.';
    end if;
    if exists (select 1 from public.payments where voids_payment_id = v_orig.id) then
      raise exception 'Ese pago ya fue anulado.';
    end if;
    v_amount := v_orig.amount;
    p_method := v_orig.method;
    v_signed := -v_orig.signed_amount;
    v_category := case v_orig.kind when 'cobro' then 'anulacion_cobro' else 'anulacion_devolucion' end;
    v_concept := format('Anulación de %s · reserva #%s', v_orig.kind, v_res.number);
  else
    raise exception 'Tipo de pago inválido.';
  end if;

  if p_method not in ('efectivo','transferencia','tarjeta') then
    raise exception 'Medio de pago inválido.';
  end if;

  insert into public.payments (workspace_id, reservation_id, kind, amount, signed_amount, method,
                               voids_payment_id, cash_session_id, idempotency_key, note, reason)
  values (p_workspace_id, p_reservation_id, p_kind, v_amount, v_signed, p_method,
          p_voids_payment_id, v_session, p_idempotency_key, nullif(btrim(p_note), ''), nullif(btrim(p_reason), ''))
  returning id into v_id;

  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, payment_id)
  values (p_workspace_id, v_session, case when v_signed > 0 then 'entrada' else 'salida' end,
          p_method, v_amount, v_category, v_concept, v_id);

  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Funciones públicas: pagos
-- ---------------------------------------------------------------------
create or replace function public.register_payment(
  p_workspace_id uuid, p_reservation_id uuid, p_amount numeric, p_method text,
  p_idempotency_key uuid, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_member(p_workspace_id);
  v_id := private.record_payment(p_workspace_id, p_reservation_id, 'cobro', p_amount, p_method,
                                 p_idempotency_key, p_note, null);
  return jsonb_build_object('payment_id', v_id);
end $$;

create or replace function public.refund_payment(
  p_workspace_id uuid, p_reservation_id uuid, p_amount numeric, p_method text,
  p_idempotency_key uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  perform set_config('app.reason', coalesce(p_reason, ''), true);
  v_id := private.record_payment(p_workspace_id, p_reservation_id, 'devolucion', p_amount, p_method,
                                 p_idempotency_key, null, p_reason);
  return jsonb_build_object('payment_id', v_id);
end $$;

create or replace function public.void_payment(
  p_workspace_id uuid, p_payment_id uuid, p_idempotency_key uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_res uuid; v_id uuid;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  select reservation_id into v_res from public.payments where id = p_payment_id and workspace_id = p_workspace_id;
  if not found then
    raise exception 'El pago no existe.';
  end if;
  perform set_config('app.reason', coalesce(p_reason, ''), true);
  v_id := private.record_payment(p_workspace_id, v_res, 'anulacion', null, null,
                                 p_idempotency_key, null, p_reason, p_payment_id);
  return jsonb_build_object('payment_id', v_id);
end $$;

-- ---------------------------------------------------------------------
-- Funciones públicas: caja
-- ---------------------------------------------------------------------
create or replace function public.open_cash_session(
  p_workspace_id uuid, p_opening_cash numeric, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date;
  v_session public.cash_sessions%rowtype;
begin
  perform private.require_member(p_workspace_id);
  v_today := private.ws_today(p_workspace_id);

  -- Evita aperturas simultáneas desde dos dispositivos.
  perform pg_advisory_xact_lock(hashtextextended('caja:' || p_workspace_id::text, 0));

  select * into v_session from public.cash_sessions
  where workspace_id = p_workspace_id and business_date = v_today;
  if found then
    if v_session.closed_at is not null then
      raise exception 'La caja de hoy ya fue abierta y cerrada.' using hint = 'CAJA_YA_CERRADA';
    end if;
    -- Ya estaba abierta: no se pide ni se registra otra apertura.
    return jsonb_build_object('session_id', v_session.id, 'already_open', true);
  end if;

  select * into v_session from public.cash_sessions
  where workspace_id = p_workspace_id and closed_at is null;
  if found then
    raise exception 'La caja del % quedó sin cerrar. Cerrala antes de abrir la de hoy.',
      to_char(v_session.business_date, 'DD/MM/YYYY') using hint = 'CAJA_ANTERIOR_ABIERTA';
  end if;

  if p_opening_cash is null or p_opening_cash < 0 then
    raise exception 'Ingresá el efectivo inicial (puede ser 0).';
  end if;

  insert into public.cash_sessions (workspace_id, business_date, opening_cash, opening_notes)
  values (p_workspace_id, v_today, round(p_opening_cash, 2), nullif(btrim(p_notes), ''))
  returning * into v_session;

  return jsonb_build_object('session_id', v_session.id, 'already_open', false);
end $$;

-- Resumen de una caja: apertura, entradas y salidas por medio, efectivo esperado.
create or replace function public.cash_session_summary(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_s public.cash_sessions%rowtype;
  v_methods jsonb;
  v_cash_in numeric(14,2);
  v_cash_out numeric(14,2);
begin
  select * into v_s from public.cash_sessions where id = p_session_id;
  if not found then
    raise exception 'La caja no existe.';
  end if;
  perform private.require_member(v_s.workspace_id);

  select coalesce(sum(amount) filter (where direction = 'entrada' and method = 'efectivo'), 0),
         coalesce(sum(amount) filter (where direction = 'salida' and method = 'efectivo'), 0)
    into v_cash_in, v_cash_out
  from public.cash_movements where cash_session_id = p_session_id;

  select coalesce(jsonb_object_agg(m.method, jsonb_build_object(
           'entradas', coalesce(x.entradas, 0), 'salidas', coalesce(x.salidas, 0))), '{}'::jsonb)
    into v_methods
  from (values ('efectivo'), ('transferencia'), ('tarjeta')) m(method)
  left join (
    select method,
           sum(amount) filter (where direction = 'entrada') as entradas,
           sum(amount) filter (where direction = 'salida') as salidas
    from public.cash_movements where cash_session_id = p_session_id group by method
  ) x on x.method = m.method;

  return jsonb_build_object(
    'session_id', v_s.id,
    'business_date', v_s.business_date,
    'opening_cash', v_s.opening_cash,
    'opened_at', v_s.opened_at,
    'opened_by', v_s.opened_by,
    'por_medio', v_methods,
    'efectivo_esperado', v_s.opening_cash + v_cash_in - v_cash_out,
    'closed_at', v_s.closed_at,
    'counted_cash', v_s.counted_cash,
    'difference', v_s.difference,
    'close_notes', v_s.close_notes,
    'version', v_s.version
  );
end $$;

create or replace function public.close_cash_session(
  p_session_id uuid, p_counted_cash numeric, p_expected_version integer, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_s public.cash_sessions%rowtype;
  v_expected numeric(14,2);
begin
  select * into v_s from public.cash_sessions where id = p_session_id for update;
  if not found then
    raise exception 'La caja no existe.';
  end if;
  perform private.require_member(v_s.workspace_id);
  if v_s.closed_at is not null then
    raise exception 'Esta caja ya está cerrada.';
  end if;
  if p_counted_cash is null or p_counted_cash < 0 then
    raise exception 'Ingresá el efectivo contado.';
  end if;

  select v_s.opening_cash
         + coalesce(sum(amount) filter (where direction = 'entrada' and method = 'efectivo'), 0)
         - coalesce(sum(amount) filter (where direction = 'salida' and method = 'efectivo'), 0)
    into v_expected
  from public.cash_movements where cash_session_id = p_session_id;

  update public.cash_sessions set
    closed_at = now(),
    closed_by = auth.uid(),
    counted_cash = round(p_counted_cash, 2),
    expected_cash = v_expected,
    difference = round(p_counted_cash, 2) - v_expected,
    close_notes = nullif(btrim(p_notes), ''),
    version = p_expected_version + 1
  where id = p_session_id;

  return public.cash_session_summary(p_session_id);
end $$;

-- ---------------------------------------------------------------------
-- Funciones públicas: gastos y otros ingresos
-- ---------------------------------------------------------------------
create or replace function public.register_expense(
  p_workspace_id uuid, p_idempotency_key uuid, p_amount numeric, p_spent_on date, p_concept text,
  p_category_id uuid, p_method text, p_supplier text default null, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.expenses%rowtype;
  v_session uuid;
  v_id uuid;
begin
  perform private.require_member(p_workspace_id);

  select * into v_existing from public.expenses
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('expense_id', v_existing.id, 'repetida', true);
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El importe debe ser mayor a cero.';
  end if;
  if p_spent_on is null or p_spent_on > private.ws_today(p_workspace_id) then
    raise exception 'Solo se registran gastos ya pagados (la fecha no puede ser futura).';
  end if;
  if p_method not in ('efectivo','transferencia','tarjeta') then
    raise exception 'Medio de pago inválido.';
  end if;
  if not exists (select 1 from public.expense_categories c
                 where c.id = p_category_id and c.workspace_id = p_workspace_id and c.active) then
    raise exception 'Elegí una categoría válida.';
  end if;

  v_session := private.today_session(p_workspace_id);

  insert into public.expenses (workspace_id, cash_session_id, amount, spent_on, concept, category_id,
                               supplier, method, notes, idempotency_key)
  values (p_workspace_id, v_session, round(p_amount, 2), p_spent_on, btrim(p_concept), p_category_id,
          nullif(btrim(p_supplier), ''), p_method, nullif(btrim(p_notes), ''), p_idempotency_key)
  returning id into v_id;

  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, expense_id)
  values (p_workspace_id, v_session, 'salida', p_method, round(p_amount, 2), 'gasto', left('Gasto: ' || btrim(p_concept), 200), v_id);

  return jsonb_build_object('expense_id', v_id, 'repetida', false);
end $$;

create or replace function public.void_expense(
  p_workspace_id uuid, p_expense_id uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_e public.expenses%rowtype;
  v_session uuid;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Indicá el motivo de la anulación.';
  end if;
  select * into v_e from public.expenses where id = p_expense_id and workspace_id = p_workspace_id for update;
  if not found then
    raise exception 'El gasto no existe.';
  end if;
  if v_e.voided_at is not null then
    return jsonb_build_object('expense_id', v_e.id, 'repetida', true);
  end if;

  v_session := private.today_session(p_workspace_id);
  perform set_config('app.reason', p_reason, true);

  update public.expenses set voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason)
  where id = p_expense_id;

  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, expense_id)
  values (p_workspace_id, v_session, 'entrada', v_e.method, v_e.amount, 'anulacion_gasto',
          left('Anulación gasto: ' || v_e.concept, 200), v_e.id);

  return jsonb_build_object('expense_id', v_e.id, 'repetida', false);
end $$;

create or replace function public.register_other_income(
  p_workspace_id uuid, p_idempotency_key uuid, p_amount numeric, p_method text, p_concept text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing uuid;
  v_session uuid;
  v_id uuid;
begin
  perform private.require_member(p_workspace_id);
  select id into v_existing from public.cash_movements
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('movement_id', v_existing, 'repetida', true);
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'El importe debe ser mayor a cero.';
  end if;
  if char_length(btrim(coalesce(p_concept, ''))) < 3 then
    raise exception 'Indicá el concepto del ingreso.';
  end if;
  if p_method not in ('efectivo','transferencia','tarjeta') then
    raise exception 'Medio de pago inválido.';
  end if;
  v_session := private.today_session(p_workspace_id);
  insert into public.cash_movements (workspace_id, cash_session_id, direction, method, amount, category, concept, idempotency_key)
  values (p_workspace_id, v_session, 'entrada', p_method, round(p_amount, 2), 'otro_ingreso', btrim(p_concept), p_idempotency_key)
  returning id into v_id;
  return jsonb_build_object('movement_id', v_id, 'repetida', false);
end $$;

-- ---------------------------------------------------------------------
-- Seguridad
-- ---------------------------------------------------------------------
alter table public.cash_sessions  enable row level security;
alter table public.payments       enable row level security;
alter table public.expenses       enable row level security;
alter table public.cash_movements enable row level security;

create policy "miembros leen cajas" on public.cash_sessions for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen pagos" on public.payments for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen gastos" on public.expenses for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen movimientos" on public.cash_movements for select to authenticated using (private.is_member(workspace_id));

revoke all on public.cash_sessions, public.payments, public.expenses, public.cash_movements from anon, authenticated;
grant select on public.cash_sessions, public.payments, public.expenses, public.cash_movements to authenticated;
revoke all on public.reservation_balances from anon;
grant select on public.reservation_balances to authenticated;

revoke all on function public.register_payment(uuid, uuid, numeric, text, uuid, text),
  public.refund_payment(uuid, uuid, numeric, text, uuid, text),
  public.void_payment(uuid, uuid, uuid, text),
  public.open_cash_session(uuid, numeric, text),
  public.cash_session_summary(uuid),
  public.close_cash_session(uuid, numeric, integer, text),
  public.register_expense(uuid, uuid, numeric, date, text, uuid, text, text, text),
  public.void_expense(uuid, uuid, text),
  public.register_other_income(uuid, uuid, numeric, text, text)
  from public, anon;
grant execute on function public.register_payment(uuid, uuid, numeric, text, uuid, text),
  public.refund_payment(uuid, uuid, numeric, text, uuid, text),
  public.void_payment(uuid, uuid, uuid, text),
  public.open_cash_session(uuid, numeric, text),
  public.cash_session_summary(uuid),
  public.close_cash_session(uuid, numeric, integer, text),
  public.register_expense(uuid, uuid, numeric, date, text, uuid, text, text, text),
  public.void_expense(uuid, uuid, text),
  public.register_other_income(uuid, uuid, numeric, text, text)
  to authenticated;
