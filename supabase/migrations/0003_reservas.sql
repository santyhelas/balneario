-- =====================================================================
-- 0003 · Reservas, tramos de ocupación, precios, descuentos,
--        mantenimiento e historial de cambios.
-- Las fechas son inclusivas: start_date y end_date cuentan como ocupados.
-- =====================================================================

create table public.reservations (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete restrict,
  number          bigint generated always as identity,
  customer_id     uuid not null,
  start_date      date not null,
  end_date        date not null,
  status          text not null default 'confirmada' check (status in ('confirmada','cancelada')),
  is_courtesy     boolean not null default false,
  list_amount     numeric(14,2) not null check (list_amount >= 0),
  discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0),
  total_amount    numeric(14,2) not null check (total_amount >= 0),
  notes           text check (char_length(notes) <= 2000),
  request_id      uuid not null,
  version         integer not null default 1,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  cancelled_at    timestamptz,
  cancelled_by    uuid,
  cancel_reason   text,
  unique (workspace_id, id),
  unique (workspace_id, request_id),
  foreign key (workspace_id, customer_id) references public.customers(workspace_id, id),
  check (end_date >= start_date),
  check (end_date - start_date < 366),
  check (total_amount = list_amount - discount_amount),
  check (not is_courtesy or total_amount = 0),
  check ((status = 'cancelada') = (cancelled_at is not null))
);
create index reservations_dates_idx on public.reservations(workspace_id, start_date, end_date);
create index reservations_customer_idx on public.reservations(workspace_id, customer_id);

create trigger reservations_version before update on public.reservations
  for each row execute function private.check_version();
create trigger reservations_audit after insert or update on public.reservations
  for each row execute function private.audit();
create trigger reservations_no_delete before delete on public.reservations
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------
-- Historial de cambios de cada reserva (para deshacer y revertir)
-- ---------------------------------------------------------------------
create table public.reservation_changes (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null,
  reservation_id        uuid not null,
  kind                  text not null check (kind in ('creacion','reubicacion','cancelacion','reversion')),
  description           text not null,
  reason                text,
  before_state          jsonb,
  after_state           jsonb,
  reverts_change_id     uuid references public.reservation_changes(id),
  reverted_by_change_id uuid references public.reservation_changes(id),
  actor_id              uuid default auth.uid(),
  actor_email           text default (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'),
  at                    timestamptz not null default now(),
  foreign key (workspace_id, reservation_id) references public.reservations(workspace_id, id)
);
create index reservation_changes_res_idx on public.reservation_changes(reservation_id, at desc);
create index reservation_changes_ws_idx on public.reservation_changes(workspace_id, at desc);
create unique index reservation_changes_one_revert on public.reservation_changes(reverts_change_id)
  where reverts_change_id is not null;

-- Solo se puede completar after_state (una vez) y marcar la reversión (una vez).
create or replace function private.changes_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'El historial no se puede borrar.' using errcode = '42501';
  end if;
  if (to_jsonb(new) - 'after_state' - 'reverted_by_change_id') <> (to_jsonb(old) - 'after_state' - 'reverted_by_change_id')
     or (old.after_state is not null and new.after_state is distinct from old.after_state)
     or (old.reverted_by_change_id is not null and new.reverted_by_change_id is distinct from old.reverted_by_change_id) then
    raise exception 'El historial no se puede modificar.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger reservation_changes_guard before update or delete on public.reservation_changes
  for each row execute function private.changes_guard();

-- ---------------------------------------------------------------------
-- Tramos de ocupación: qué carpa usa la reserva cada día
-- ---------------------------------------------------------------------
create table public.reservation_segments (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null,
  reservation_id       uuid not null,
  space_id             uuid not null,
  start_date           date not null,
  end_date             date not null,
  active               boolean not null default true,
  created_by_change_id uuid not null references public.reservation_changes(id),
  ended_by_change_id   uuid references public.reservation_changes(id),
  created_at           timestamptz not null default now(),
  foreign key (workspace_id, reservation_id) references public.reservations(workspace_id, id),
  foreign key (workspace_id, space_id) references public.spaces(workspace_id, id),
  check (end_date >= start_date),
  check (active = (ended_by_change_id is null)),
  -- Garantía en la base de datos: un espacio no puede estar ocupado dos veces el mismo día.
  constraint segments_no_double_booking exclude using gist (
    space_id with =, daterange(start_date, end_date, '[]') with &&
  ) where (active),
  -- Una reserva no puede tener dos carpas el mismo día.
  constraint segments_no_overlap_in_reservation exclude using gist (
    reservation_id with =, daterange(start_date, end_date, '[]') with &&
  ) where (active)
);
create index reservation_segments_res_idx on public.reservation_segments(reservation_id) where active;
create index reservation_segments_space_idx on public.reservation_segments(space_id, start_date, end_date) where active;

-- ---------------------------------------------------------------------
-- Mantenimiento
-- ---------------------------------------------------------------------
create table public.maintenance_blocks (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  space_id     uuid not null,
  start_date   date not null,
  end_date     date not null,
  reason       text not null check (char_length(btrim(reason)) between 3 and 300),
  notes        text check (char_length(notes) <= 2000),
  active       boolean not null default true,
  version      integer not null default 1,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  foreign key (workspace_id, space_id) references public.spaces(workspace_id, id),
  check (end_date >= start_date),
  constraint maintenance_no_overlap exclude using gist (
    space_id with =, daterange(start_date, end_date, '[]') with &&
  ) where (active)
);

create trigger maintenance_version before update on public.maintenance_blocks
  for each row execute function private.check_version();
create trigger maintenance_audit after insert or update on public.maintenance_blocks
  for each row execute function private.audit();
create trigger maintenance_no_delete before delete on public.maintenance_blocks
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------
-- Bloqueos por espacio: serializa las operaciones que compiten por la
-- misma carpa (reservas, cambios, mantenimiento) entre dispositivos.
-- ---------------------------------------------------------------------
create or replace function private.lock_spaces(p_space_ids uuid[]) returns void
language plpgsql as $$
declare v_id uuid;
begin
  for v_id in select distinct s from unnest(p_space_ids) s where s is not null order by s loop
    perform pg_advisory_xact_lock(hashtextextended('espacio:' || v_id::text, 0));
  end loop;
end $$;

-- Describe por qué un espacio no está libre en un rango (null si está libre).
create or replace function private.space_conflict(
  p_space_id uuid, p_start date, p_end date, p_ignore_reservation uuid default null
) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_space public.spaces%rowtype;
  v_msg text;
begin
  select * into v_space from public.spaces where id = p_space_id;
  if not found then
    return 'El espacio no existe.';
  end if;
  if not v_space.active then
    return format('%s está desactivado.', v_space.code);
  end if;

  select format('%s está en mantenimiento del %s al %s (%s).', v_space.code,
                to_char(m.start_date, 'DD/MM/YYYY'), to_char(m.end_date, 'DD/MM/YYYY'), m.reason)
    into v_msg
  from public.maintenance_blocks m
  where m.space_id = p_space_id and m.active
    and daterange(m.start_date, m.end_date, '[]') && daterange(p_start, p_end, '[]')
  order by m.start_date limit 1;
  if v_msg is not null then return v_msg; end if;

  select format('%s está ocupada del %s al %s por la reserva #%s (%s).', v_space.code,
                to_char(greatest(s.start_date, p_start), 'DD/MM/YYYY'),
                to_char(least(s.end_date, p_end), 'DD/MM/YYYY'),
                r.number, btrim(c.first_name || ' ' || c.last_name))
    into v_msg
  from public.reservation_segments s
  join public.reservations r on r.id = s.reservation_id
  join public.customers c on c.id = r.customer_id
  where s.space_id = p_space_id and s.active
    and (p_ignore_reservation is null or s.reservation_id <> p_ignore_reservation)
    and daterange(s.start_date, s.end_date, '[]') && daterange(p_start, p_end, '[]')
  order by s.start_date limit 1;
  return v_msg;
end $$;

-- Al activar un tramo: el espacio debe estar activo y sin mantenimiento.
create or replace function private.segments_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_msg text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Los tramos no se borran; se finalizan con un cambio registrado.' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    -- Lo único permitido es finalizar un tramo activo.
    if not (old.active and not new.active and new.ended_by_change_id is not null
            and (to_jsonb(new) - 'active' - 'ended_by_change_id') = (to_jsonb(old) - 'active' - 'ended_by_change_id')) then
      raise exception 'Un tramo solo puede finalizarse, no modificarse.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.active then
    perform private.lock_spaces(array[new.space_id]);
    if exists (select 1 from public.reservations r where r.id = new.reservation_id and r.status = 'cancelada') then
      raise exception 'No se pueden asignar espacios a una reserva cancelada.';
    end if;
    if new.start_date < (select r.start_date from public.reservations r where r.id = new.reservation_id)
       or new.end_date > (select r.end_date from public.reservations r where r.id = new.reservation_id) then
      raise exception 'El tramo queda fuera de las fechas de la reserva.';
    end if;
    -- Desactivado o mantenimiento (las superposiciones con otras reservas
    -- las rechaza la restricción segments_no_double_booking).
    select case
             when not sp.active then format('%s está desactivado.', sp.code)
             else (select format('%s está en mantenimiento del %s al %s (%s).', sp.code,
                          to_char(m.start_date, 'DD/MM/YYYY'), to_char(m.end_date, 'DD/MM/YYYY'), m.reason)
                   from public.maintenance_blocks m
                   where m.space_id = new.space_id and m.active
                     and daterange(m.start_date, m.end_date, '[]') && daterange(new.start_date, new.end_date, '[]')
                   limit 1)
           end
      into v_msg
    from public.spaces sp where sp.id = new.space_id;
    if v_msg is not null then
      raise exception '%', v_msg using errcode = '23P01';
    end if;
  end if;
  return new;
end $$;

create trigger reservation_segments_guard before insert or update or delete on public.reservation_segments
  for each row execute function private.segments_guard();
create trigger reservation_segments_audit after insert or update on public.reservation_segments
  for each row execute function private.audit();

-- Al crear o modificar un mantenimiento: no puede pisar reservas activas.
create or replace function private.maintenance_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_msg text;
begin
  if tg_op = 'UPDATE' and new.space_id <> old.space_id then
    raise exception 'No se puede cambiar el espacio de un mantenimiento. Finalizalo y creá otro.';
  end if;
  if new.active then
    perform private.lock_spaces(array[new.space_id]);
    if not (select sp.active from public.spaces sp where sp.id = new.space_id) then
      raise exception 'El espacio está desactivado.';
    end if;
    select string_agg(format('reserva #%s de %s (%s al %s)', r.number,
                             btrim(c.first_name || ' ' || c.last_name),
                             to_char(greatest(s.start_date, new.start_date), 'DD/MM/YYYY'),
                             to_char(least(s.end_date, new.end_date), 'DD/MM/YYYY')), '; ' order by s.start_date)
      into v_msg
    from public.reservation_segments s
    join public.reservations r on r.id = s.reservation_id
    join public.customers c on c.id = r.customer_id
    where s.space_id = new.space_id and s.active
      and daterange(s.start_date, s.end_date, '[]') && daterange(new.start_date, new.end_date, '[]');
    if v_msg is not null then
      raise exception 'El mantenimiento choca con: %. Primero cambiá de carpa a esos clientes.', v_msg
        using errcode = '23P01', hint = 'CONFLICTO_MANTENIMIENTO';
    end if;
  end if;
  return new;
end $$;

create trigger maintenance_guard before insert or update on public.maintenance_blocks
  for each row execute function private.maintenance_guard();

-- No se puede desactivar un espacio que tiene reservas de hoy en adelante.
create or replace function private.spaces_deactivation_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_msg text;
begin
  if old.active and not new.active then
    perform private.lock_spaces(array[new.id]);
    select string_agg(format('#%s (%s al %s)', r.number, to_char(s.start_date, 'DD/MM/YYYY'),
                             to_char(s.end_date, 'DD/MM/YYYY')), ', ' order by s.start_date)
      into v_msg
    from public.reservation_segments s
    join public.reservations r on r.id = s.reservation_id
    where s.space_id = new.id and s.active and s.end_date >= private.ws_today(new.workspace_id);
    if v_msg is not null then
      raise exception 'No se puede desactivar %: tiene reservas pendientes %. Cambialas de carpa primero.', new.code, v_msg;
    end if;
  end if;
  return new;
end $$;

create trigger spaces_deactivation_guard before update of active on public.spaces
  for each row execute function private.spaces_deactivation_guard();

-- ---------------------------------------------------------------------
-- Detalle de precio (fotografía histórica) y descuentos aplicados
-- ---------------------------------------------------------------------
create table public.reservation_charges (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  reservation_id uuid not null,
  position       integer not null,
  description    text not null check (char_length(description) <= 200),
  space_kind     text check (space_kind in ('carpa','sombrilla')),
  start_date     date,
  end_date       date,
  days           integer check (days > 0),
  unit_price     numeric(14,2) check (unit_price >= 0),
  amount         numeric(14,2) not null check (amount >= 0),
  is_manual      boolean not null default false,
  rate_snapshot  jsonb,
  foreign key (workspace_id, reservation_id) references public.reservations(workspace_id, id),
  check (end_date is null or start_date is null or end_date >= start_date),
  unique (reservation_id, position)
);

create table public.reservation_discounts (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  reservation_id uuid not null,
  position       integer not null,
  kind           text not null check (kind in ('efectivo','convenio','manual','cortesia')),
  agreement_id   uuid,
  label          text not null check (char_length(label) <= 120),
  percent        numeric(5,2) check (percent > 0 and percent <= 100),
  amount         numeric(14,2) not null check (amount >= 0),
  reason         text check (char_length(reason) <= 300),
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  foreign key (workspace_id, reservation_id) references public.reservations(workspace_id, id),
  foreign key (workspace_id, agreement_id) references public.agreements(workspace_id, id),
  check (kind <> 'convenio' or agreement_id is not null),
  check (kind <> 'manual' or char_length(btrim(coalesce(reason, ''))) >= 3),
  unique (reservation_id, position)
);

create trigger reservation_charges_immutable before update or delete on public.reservation_charges
  for each row execute function private.forbid_change();
create trigger reservation_discounts_immutable before update or delete on public.reservation_discounts
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------
-- Comprueba que los tramos activos cubran toda la estadía sin huecos.
-- ---------------------------------------------------------------------
create or replace function private.assert_coverage(p_reservation_id uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_res public.reservations%rowtype;
  v_prev date;
  v_count integer := 0;
  r record;
begin
  select * into v_res from public.reservations where id = p_reservation_id;
  if v_res.status = 'cancelada' then
    if exists (select 1 from public.reservation_segments where reservation_id = p_reservation_id and active) then
      raise exception 'Una reserva cancelada no puede ocupar espacios.';
    end if;
    return;
  end if;
  v_prev := v_res.start_date - 1;
  for r in select start_date, end_date from public.reservation_segments
           where reservation_id = p_reservation_id and active order by start_date loop
    if r.start_date <> v_prev + 1 then
      raise exception 'Los tramos de carpa dejan días sin asignar o se superponen (a partir del %).',
        to_char(v_prev + 1, 'DD/MM/YYYY');
    end if;
    v_prev := r.end_date;
    v_count := v_count + 1;
  end loop;
  if v_count = 0 or v_prev <> v_res.end_date then
    raise exception 'Los tramos de carpa no cubren toda la estadía (falta desde el %).',
      to_char(v_prev + 1, 'DD/MM/YYYY');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Seguridad: lectura para miembros; la escritura de reservas y tramos
-- solo es posible mediante las funciones validadas (ver 0005).
-- ---------------------------------------------------------------------
alter table public.reservations          enable row level security;
alter table public.reservation_changes   enable row level security;
alter table public.reservation_segments  enable row level security;
alter table public.maintenance_blocks    enable row level security;
alter table public.reservation_charges   enable row level security;
alter table public.reservation_discounts enable row level security;

create policy "miembros leen reservas" on public.reservations for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen cambios" on public.reservation_changes for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen tramos" on public.reservation_segments for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen mantenimiento" on public.maintenance_blocks for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen precios" on public.reservation_charges for select to authenticated using (private.is_member(workspace_id));
create policy "miembros leen descuentos" on public.reservation_discounts for select to authenticated using (private.is_member(workspace_id));

create policy "admins crean mantenimiento" on public.maintenance_blocks for insert to authenticated
  with check (private.has_role(workspace_id, array['propietario','administrador']));
create policy "admins editan mantenimiento" on public.maintenance_blocks for update to authenticated
  using (private.has_role(workspace_id, array['propietario','administrador']))
  with check (private.has_role(workspace_id, array['propietario','administrador']));

revoke all on public.reservations, public.reservation_changes, public.reservation_segments,
  public.maintenance_blocks, public.reservation_charges, public.reservation_discounts from anon, authenticated;
grant select on public.reservations, public.reservation_changes, public.reservation_segments,
  public.maintenance_blocks, public.reservation_charges, public.reservation_discounts to authenticated;
grant insert (workspace_id, space_id, start_date, end_date, reason, notes) on public.maintenance_blocks to authenticated;
grant update (end_date, reason, notes, active, version) on public.maintenance_blocks to authenticated;
