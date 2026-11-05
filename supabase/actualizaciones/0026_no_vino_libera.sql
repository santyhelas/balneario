-- ACTUALIZACIÓN 0026 · "No vino": liberar la carpa y descontar el día.
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0025).
begin;
-- =====================================================================
-- 0026 · "No vino": liberar la carpa y descontar el día.
--   · Reserva de 1 día: al marcar "no vino" la carpa se libera sola.
--   · Reserva de varios días: la reserva sigue; se puede liberar el día que
--     no vino y, si el administrador quiere, descontarlo del precio.
--   · La reserva nunca se cancela ni se borra. Liberar un día queda como un
--     cambio de la reserva (se puede revertir); el descuento no se revierte solo.
-- =====================================================================

-- Días liberados por "no vino" (cambios vigentes, no revertidos).
create or replace function private.released_days(p_reservation_id uuid) returns date[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg((c.after_state ->> 'liberado')::date), '{}')
  from public.reservation_changes c
  where c.reservation_id = p_reservation_id and c.kind = 'reubicacion'
    and c.after_state ? 'liberado' and c.reverted_by_change_id is null
$$;

-- Cobertura: cada día de la estadía tiene una carpa, salvo los liberados por "no vino".
create or replace function private.assert_coverage(p_reservation_id uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_res public.reservations%rowtype;
  v_released date[];
  v_missing date;
begin
  select * into v_res from public.reservations where id = p_reservation_id;
  if v_res.status = 'cancelada' then
    if exists (select 1 from public.reservation_segments where reservation_id = p_reservation_id and active) then
      raise exception 'Una reserva cancelada no puede ocupar espacios.';
    end if;
    return;
  end if;
  if exists (select 1 from public.reservation_segments
             where reservation_id = p_reservation_id and active
               and (start_date < v_res.start_date or end_date > v_res.end_date)) then
    raise exception 'Los tramos de carpa se salen de las fechas de la estadía.';
  end if;
  v_released := private.released_days(p_reservation_id);
  select min(d::date) into v_missing
  from generate_series(v_res.start_date, v_res.end_date, interval '1 day') d
  where not (d::date = any(v_released))
    and not exists (select 1 from public.reservation_segments s
                    where s.reservation_id = p_reservation_id and s.active
                      and d::date between s.start_date and s.end_date);
  if v_missing is not null then
    raise exception 'Los tramos de carpa dejan días sin asignar (falta el %).', to_char(v_missing, 'DD/MM/YYYY');
  end if;
end $$;

-- Libera un día de la reserva (sin tocar el dinero). Devuelve el id del cambio o null si ya estaba libre.
create or replace function private.release_day(p_res public.reservations, p_day date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_seg public.reservation_segments%rowtype;
  v_code text;
  v_change_id uuid := gen_random_uuid();
begin
  select * into v_seg from public.reservation_segments
  where reservation_id = p_res.id and active and p_day between start_date and end_date;
  if not found then
    return null;
  end if;
  select code into v_code from public.spaces where id = v_seg.space_id;
  perform private.lock_spaces(array[v_seg.space_id]);

  insert into public.reservation_changes (id, workspace_id, reservation_id, kind, description, reason, before_state)
  values (v_change_id, p_res.workspace_id, p_res.id, 'reubicacion',
          format('No vino: se liberó %s el %s', v_code, to_char(p_day, 'DD/MM/YYYY')), 'No vino',
          jsonb_build_object('segments', private.segments_snapshot(p_res.id)));

  update public.reservation_segments set active = false, ended_by_change_id = v_change_id where id = v_seg.id;
  if v_seg.start_date < p_day then
    insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
    values (v_seg.workspace_id, p_res.id, v_seg.space_id, v_seg.start_date, p_day - 1, v_change_id);
  end if;
  if v_seg.end_date > p_day then
    insert into public.reservation_segments (workspace_id, reservation_id, space_id, start_date, end_date, created_by_change_id)
    values (v_seg.workspace_id, p_res.id, v_seg.space_id, p_day + 1, v_seg.end_date, v_change_id);
  end if;

  update public.reservation_changes
     set after_state = jsonb_build_object('segments', private.segments_snapshot(p_res.id), 'liberado', p_day, 'space_code', v_code)
   where id = v_change_id;
  perform private.assert_coverage(p_res.id);
  update public.reservations set version = version + 1 where id = p_res.id;
  return v_change_id;
end $$;
revoke all on function private.release_day(public.reservations, date) from public, anon, authenticated;

-- Texto con el que se reconoce el descuento de un día de "no vino".
create or replace function private.no_show_reason(p_day date) returns text
language sql immutable as $$ select 'No vino el ' || to_char(p_day, 'DD/MM/YYYY') $$;

-- Liberar el día que no vino (cualquier usuario) y, opcionalmente, descontarlo (administradores).
create or replace function public.release_no_show_day(p_reservation_id uuid, p_day date, p_discount boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_res public.reservations%rowtype;
  v_today date;
  v_change uuid;
  v_days integer;
  v_prev numeric;
  v_amount numeric := 0;
  v_total numeric;
  v_pos integer;
begin
  select * into v_res from public.reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'La reserva no existe.';
  end if;
  if p_discount then
    perform private.require_member(v_res.workspace_id, array['propietario','administrador']);
  else
    perform private.require_member(v_res.workspace_id);
  end if;
  if v_res.status <> 'confirmada' then
    raise exception 'La reserva está cancelada.';
  end if;
  if v_res.arrival_status is distinct from 'no_vino' then
    raise exception 'Primero marcá que el cliente no vino.';
  end if;
  select (now() at time zone w.timezone)::date into v_today from public.workspaces w where w.id = v_res.workspace_id;
  if p_day is null or p_day < v_res.start_date or p_day > v_res.end_date then
    raise exception 'El día tiene que estar dentro de la estadía (del % al %).', to_char(v_res.start_date, 'DD/MM/YYYY'), to_char(v_res.end_date, 'DD/MM/YYYY');
  end if;
  if p_day > v_today then
    raise exception 'Solo se pueden liberar días de hoy o anteriores.';
  end if;

  v_change := private.release_day(v_res, p_day);
  if v_change is null and not (p_day = any(private.released_days(p_reservation_id))) then
    raise exception 'Ese día no tiene carpa asignada.';
  end if;

  if p_discount then
    if v_res.is_courtesy then
      raise exception 'Una cortesía no tiene precio para descontar.';
    end if;
    if exists (select 1 from public.reservation_discounts
               where reservation_id = p_reservation_id and kind = 'manual' and reason = private.no_show_reason(p_day)) then
      raise exception 'Ese día ya se descontó.';
    end if;
    -- Lo que vale un día de esta reserva (total contratado ÷ días), sin contar días ya descontados.
    select v.total_amount + coalesce(sum(d.amount), 0) into v_prev
    from public.reservations v
    left join public.reservation_discounts d on d.reservation_id = v.id and d.kind = 'manual' and d.reason like 'No vino el %'
    where v.id = p_reservation_id
    group by v.total_amount;
    v_days := v_res.end_date - v_res.start_date + 1;
    select total_amount into v_total from public.reservations where id = p_reservation_id;
    v_amount := least(round(v_prev / v_days, 2), v_total);
    if v_amount > 0 then
      select coalesce(max(position), 0) + 1 into v_pos from public.reservation_discounts where reservation_id = p_reservation_id;
      insert into public.reservation_discounts (workspace_id, reservation_id, position, kind, label, amount, reason)
      values (v_res.workspace_id, p_reservation_id, v_pos, 'manual', 'Día no usado (no vino)', v_amount, private.no_show_reason(p_day));
      perform set_config('app.reason', private.no_show_reason(p_day) || ': se descuenta el día', true);
      update public.reservations
         set discount_amount = discount_amount + v_amount, total_amount = total_amount - v_amount, version = version + 1
       where id = p_reservation_id;
    end if;
  end if;

  return jsonb_build_object('change_id', v_change, 'liberado', p_day, 'descuento', v_amount);
end $$;
revoke all on function public.release_no_show_day(uuid, date, boolean) from public, anon;
grant execute on function public.release_no_show_day(uuid, date, boolean) to authenticated;

-- Un día liberado y descontado no se vuelve a ocupar revirtiendo el cambio
-- (habría que deshacer también el descuento, que es dinero).
create or replace function private.block_revert_discounted() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_day date;
begin
  if new.kind <> 'reversion' or new.reverts_change_id is null or private.restoring(new.workspace_id::text) then
    return new;
  end if;
  select (after_state ->> 'liberado')::date into v_day from public.reservation_changes where id = new.reverts_change_id;
  if v_day is not null and exists (select 1 from public.reservation_discounts
                                   where reservation_id = new.reservation_id and kind = 'manual' and reason = private.no_show_reason(v_day)) then
    raise exception 'Ese día ya se descontó del precio: no se puede volver a ocupar automáticamente. Si vino, hacé una reserva nueva para ese día.'
      using hint = 'REVERSION_CON_DESCUENTO';
  end if;
  return new;
end $$;
create trigger reservation_changes_block_discounted before insert on public.reservation_changes
  for each row execute function private.block_revert_discounted();

-- Llegó / no vino: la reserva de 1 día se libera sola al marcar "no vino";
-- si después se corrige la marca, se vuelve a ocupar (si sigue libre y no se descontó).
create or replace function public.set_arrival(p_reservation_id uuid, p_state text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_res public.reservations%rowtype;
  v_today date;
  v_chg uuid;
  v_released uuid;
begin
  select * into v_res from public.reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'La reserva no existe.';
  end if;
  perform private.require_member(v_res.workspace_id);
  if p_state is not null and p_state not in ('llego', 'no_vino') then
    raise exception 'Estado de llegada inválido.';
  end if;
  if v_res.status <> 'confirmada' then
    raise exception 'La reserva está cancelada.';
  end if;
  select (now() at time zone w.timezone)::date into v_today from public.workspaces w where w.id = v_res.workspace_id;
  if p_state is not null and v_res.start_date > v_today then
    raise exception 'La reserva empieza el %: recién ese día se puede marcar la llegada.', to_char(v_res.start_date, 'DD/MM/YYYY');
  end if;
  if v_res.arrival_status is not distinct from p_state then
    return jsonb_build_object('arrival_status', p_state, 'sin_cambios', true);
  end if;

  -- Deja de ser "no vino": se vuelven a ocupar los días liberados (el más reciente primero).
  if v_res.arrival_status = 'no_vino' then
    for v_chg in select c.id from public.reservation_changes c
                 where c.reservation_id = p_reservation_id and c.kind = 'reubicacion'
                   and c.after_state ? 'liberado' and c.reverted_by_change_id is null
                 order by c.at desc loop
      perform public.revert_change(v_chg, 'Se corrigió la marca de "no vino"');
    end loop;
    select * into v_res from public.reservations where id = p_reservation_id;
  end if;

  update public.reservations
     set arrival_status = p_state,
         arrival_at = case when p_state is null then null else now() end,
         arrival_by = case when p_state is null then null else auth.uid() end,
         version = version + 1
   where id = p_reservation_id
  returning * into v_res;

  if p_state = 'no_vino' and v_res.start_date = v_res.end_date then
    v_released := private.release_day(v_res, v_res.start_date);
  end if;
  return jsonb_build_object('arrival_status', p_state, 'liberado', v_released is not null);
end $$;
revoke all on function public.set_arrival(uuid, text) from public, anon;
grant execute on function public.set_arrival(uuid, text) to authenticated;

commit;
