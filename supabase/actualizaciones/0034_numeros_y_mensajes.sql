-- ACTUALIZACIÓN 0034 · Número de reserva correlativo por balneario y mensaje de correo.
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0033).
begin;
-- =====================================================================
-- 0034 · Número de reserva correlativo por balneario y mensajes con más datos.
--   · Cada balneario numera sus reservas desde 1, sin saltos (antes el número era
--     compartido entre todos los balnearios y las demos, y quedaban huecos).
--     Las reservas existentes se renumeran en el orden en que se crearon, y los
--     textos de la caja que las nombran ("Cobro reserva #…") se actualizan igual.
--   · Mensajes: se suman el asunto y el texto del correo al cliente.
-- =====================================================================

create table if not exists private.reservation_counters (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  last_number  bigint not null default 0
);
alter table private.reservation_counters enable row level security;
revoke all on private.reservation_counters from public, anon, authenticated;

-- El número deja de ser global.
alter table public.reservations alter column number drop identity if exists;

-- Renumerar lo que ya existe (por balneario, en orden de creación).
create temporary table _renum as
  select id, workspace_id, number as old_number,
         row_number() over (partition by workspace_id order by created_at, number) as new_number
  from public.reservations;

alter table public.reservations disable trigger reservations_version;
alter table public.reservations disable trigger reservations_audit;
alter table public.reservations disable trigger reservations_pausa;
update public.reservations r set number = m.new_number
  from _renum m where m.id = r.id and r.number <> m.new_number;
alter table public.reservations enable trigger reservations_version;
alter table public.reservations enable trigger reservations_audit;
alter table public.reservations enable trigger reservations_pausa;

-- Los movimientos de caja nombran la reserva por número: se actualiza solo ese número.
alter table public.cash_movements disable trigger cash_movements_immutable;
alter table public.cash_movements disable trigger cash_movements_guard;
alter table public.cash_movements disable trigger cash_movements_pausa;
update public.cash_movements cm
   set concept = regexp_replace(cm.concept, 'reserva #' || m.old_number || '(?![0-9])', 'reserva #' || m.new_number)
  from public.payments p join _renum m on m.id = p.reservation_id
 where cm.payment_id = p.id and m.old_number <> m.new_number;
alter table public.cash_movements enable trigger cash_movements_immutable;
alter table public.cash_movements enable trigger cash_movements_guard;
alter table public.cash_movements enable trigger cash_movements_pausa;

insert into private.reservation_counters (workspace_id, last_number)
  select workspace_id, max(number) from public.reservations group by workspace_id
on conflict (workspace_id) do update set last_number = excluded.last_number;

drop table _renum;

alter table public.reservations drop constraint if exists reservations_number_unique;
alter table public.reservations add constraint reservations_number_unique unique (workspace_id, number);

-- Número para cada reserva nueva: el siguiente del balneario. Al restaurar una copia
-- (que trae sus números), el contador se pone al día para no repetir.
create or replace function private.assign_reservation_number() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v bigint;
begin
  if new.number is null then
    insert into private.reservation_counters (workspace_id, last_number) values (new.workspace_id, 1)
    on conflict (workspace_id) do update set last_number = private.reservation_counters.last_number + 1
    returning last_number into v;
    new.number := v;
  else
    insert into private.reservation_counters (workspace_id, last_number) values (new.workspace_id, new.number)
    on conflict (workspace_id) do update set last_number = greatest(private.reservation_counters.last_number, excluded.last_number);
  end if;
  return new;
end $$;
drop trigger if exists reservations_number on public.reservations;
create trigger reservations_number before insert on public.reservations
  for each row execute function private.assign_reservation_number();

-- ---------------------------------------------------------------------
-- Mensajes: también el correo al cliente (asunto y texto)
-- ---------------------------------------------------------------------
create or replace function private.valid_message_templates(s jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare k text; v_max integer;
begin
  if s is null then return true; end if;
  if jsonb_typeof(s) <> 'object' then return false; end if;
  for k in select jsonb_object_keys(s) loop
    if k not in ('deuda_hoy', 'deuda_manana', 'deuda_vencida', 'deuda_otros', 'mail_asunto', 'mail_cuerpo') then return false; end if;
    if jsonb_typeof(s -> k) <> 'string' then return false; end if;
    v_max := (case k when 'mail_asunto' then 200 when 'mail_cuerpo' then 3000 else 1000 end);
    if char_length(s ->> k) > v_max then return false; end if;
  end loop;
  return true;
end $$;

commit;
