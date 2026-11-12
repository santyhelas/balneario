-- 0046 · Personas por reserva, máximo por carpa/sombrilla y reservas de grupo (varias carpas juntas).
--
-- · reservations.people: cuántas personas ocupan ese espacio (opcional, sin separar adultos y menores).
-- · reservations.group_id: une las reservas que se hicieron juntas para un mismo grupo. Cada carpa sigue
--   siendo su propia reserva (disponibilidad, cambios de carpa, historial y deshacer funcionan igual).
-- · workspaces.tent_capacity / umbrella_capacity: máximo de personas que define el balneario (vacío = sin máximo).
-- · create_reservation_group: crea la reserva principal y las carpas extra en una sola transacción
--   (o se guardan todas o ninguna) y reparte el cobro entre ellas.

alter table public.reservations add column if not exists people integer check (people is null or people between 1 and 500);
alter table public.reservations add column if not exists group_id uuid;
create index if not exists reservations_group_idx on public.reservations(workspace_id, group_id) where group_id is not null;

alter table public.workspaces add column if not exists tent_capacity integer check (tent_capacity is null or tent_capacity between 1 and 100);
alter table public.workspaces add column if not exists umbrella_capacity integer check (umbrella_capacity is null or umbrella_capacity between 1 and 100);
grant update (tent_capacity, umbrella_capacity) on public.workspaces to authenticated;

create or replace function public.create_reservation_group(
  p_workspace_id uuid, p_request_id uuid, p_customer_id uuid, p_start_date date, p_end_date date,
  p_segments jsonb, p_extra_spaces uuid[] default '{}', p_options jsonb default '{}'::jsonb, p_notes text default null,
  p_payment jsonb default null, p_extras jsonb default '[]'::jsonb, p_people integer default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.reservations%rowtype;
  v_extra uuid[] := coalesce(p_extra_spaces, '{}');
  v_n integer;
  v_group uuid;
  v_main jsonb;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_opts jsonb;
  v_i integer;
  v_left numeric;
  v_pay numeric;
  v_due numeric;
  v_people integer;
begin
  perform private.require_member(p_workspace_id);
  -- Reintento (doble clic, recarga): devuelve lo que ya se guardó.
  select * into v_existing from public.reservations where workspace_id = p_workspace_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('reservation_id', v_existing.id, 'number', v_existing.number, 'group_id', v_existing.group_id, 'repetida', true);
  end if;
  if p_people is not null and (p_people < 1 or p_people > 500) then raise exception 'La cantidad de personas tiene que ser entre 1 y 500.'; end if;
  if array_length(v_extra, 1) > 9 then raise exception 'Un grupo puede tener hasta 10 espacios.'; end if;
  if (select count(distinct e.sid) from unnest(v_extra) as e(sid)) <> coalesce(array_length(v_extra, 1), 0) then
    raise exception 'Hay espacios repetidos en el grupo.';
  end if;
  if exists (select 1 from unnest(v_extra) as e(sid), jsonb_array_elements(p_segments) s where (s ->> 'space_id')::uuid = e.sid) then
    raise exception 'Un espacio del grupo es el mismo que el principal.';
  end if;
  if exists (select 1 from unnest(v_extra) as e(sid) where not exists (select 1 from public.spaces sp where sp.id = e.sid and sp.workspace_id = p_workspace_id and sp.active)) then
    raise exception 'Uno de los espacios del grupo no existe o está desactivado.';
  end if;
  if coalesce(array_length(v_extra, 1), 0) > 0 and p_payment is not null and nullif(p_payment ->> 'usd_amount', '') is not null then
    raise exception 'En una reserva de grupo cobrá en pesos; los dólares se registran después desde cada reserva.';
  end if;

  v_n := 1 + coalesce(array_length(v_extra, 1), 0);
  v_group := case when v_n > 1 then gen_random_uuid() end;

  -- Principal (con sus tramos, extras y opciones de precio tal cual)
  v_main := public.create_reservation_v3(p_workspace_id, p_request_id, p_customer_id, p_start_date, p_end_date,
                                          p_segments, p_options, p_notes, null, p_extras);
  v_ids := array_append(v_ids, (v_main ->> 'reservation_id')::uuid);

  -- Las demás carpas del grupo: toda la estadía, mismo precio y descuentos.
  -- Un descuento manual en pesos se aplica una sola vez (en la principal), no en cada carpa.
  v_opts := case when p_options -> 'manual' ->> 'type' = 'monto' then p_options - 'manual' else p_options end;
  for v_i in 1 .. v_n - 1 loop
    v_id := (public.create_reservation_v3(
      p_workspace_id, md5(p_request_id::text || ':grupo:' || v_i)::uuid, p_customer_id, p_start_date, p_end_date,
      jsonb_build_array(jsonb_build_object('space_id', v_extra[v_i], 'start_date', p_start_date, 'end_date', p_end_date)),
      v_opts, p_notes, null, '[]'::jsonb) ->> 'reservation_id')::uuid;
    v_ids := array_append(v_ids, v_id);
  end loop;

  -- Personas repartidas entre las carpas (la principal se lleva el resto) y el grupo.
  for v_i in 1 .. v_n loop
    v_people := case when p_people is null then null
                     else (p_people / v_n) + case when v_i <= p_people % v_n then 1 else 0 end end;
    if v_people = 0 then v_people := null; end if;
    update public.reservations set people = v_people, group_id = v_group, version = version + 1
     where id = v_ids[v_i] and (people is distinct from v_people or group_id is distinct from v_group);
  end loop;

  -- Cobro: se reparte en orden, completando cada carpa antes de pasar a la siguiente.
  if p_payment is not null then
    if v_n = 1 then
      if nullif(p_payment ->> 'usd_amount', '') is not null then
        perform public.register_payment_usd(p_workspace_id, v_ids[1], (p_payment ->> 'usd_amount')::numeric, (p_payment ->> 'exchange_rate')::numeric,
                                            (p_payment ->> 'idempotency_key')::uuid, null);
      else
        perform public.register_payment(p_workspace_id, v_ids[1], (p_payment ->> 'amount')::numeric, p_payment ->> 'method',
                                        (p_payment ->> 'idempotency_key')::uuid, null);
      end if;
    else
      v_left := (p_payment ->> 'amount')::numeric;
      if v_left is null or v_left <= 0 then raise exception 'Importe del cobro inválido.'; end if;
      for v_i in 1 .. v_n loop
        exit when v_left <= 0;
        select total_amount into v_due from public.reservations where id = v_ids[v_i];
        v_pay := least(v_left, v_due);
        if v_pay > 0 then
          perform public.register_payment(p_workspace_id, v_ids[v_i], v_pay, p_payment ->> 'method',
                                          case when v_i = 1 then (p_payment ->> 'idempotency_key')::uuid
                                               else md5((p_payment ->> 'idempotency_key') || ':grupo:' || v_i)::uuid end, null);
          v_left := v_left - v_pay;
        end if;
      end loop;
      if v_left > 0.009 then raise exception 'El cobro supera el total del grupo.'; end if;
    end if;
  end if;

  return v_main || jsonb_build_object(
    'group_id', v_group,
    'reservations', (select jsonb_agg(jsonb_build_object('id', r.id, 'number', r.number) order by r.number)
                       from public.reservations r where r.id = any(v_ids)),
    'total_amount', (select sum(total_amount) from public.reservations where id = any(v_ids)));
end $$;
revoke all on function public.create_reservation_group(uuid, uuid, uuid, date, date, jsonb, uuid[], jsonb, text, jsonb, jsonb, integer) from public, anon;
grant execute on function public.create_reservation_group(uuid, uuid, uuid, date, date, jsonb, uuid[], jsonb, text, jsonb, jsonb, integer) to authenticated;

-- Cambiar la cantidad de personas de una reserva ya hecha.
create or replace function public.set_reservation_people(p_reservation_id uuid, p_expected_version integer, p_people integer)
returns void language plpgsql security definer set search_path = '' as $$
declare v_r public.reservations%rowtype;
begin
  select * into v_r from public.reservations where id = p_reservation_id for update;
  if not found then raise exception 'La reserva no existe.'; end if;
  perform private.require_member(v_r.workspace_id);
  if v_r.version <> p_expected_version then
    raise exception 'Este dato fue modificado desde otro dispositivo. Recargá la pantalla e intentá de nuevo.' using errcode = '40001', hint = 'CONFLICTO_VERSION';
  end if;
  if p_people is not null and (p_people < 1 or p_people > 500) then raise exception 'La cantidad de personas tiene que ser entre 1 y 500.'; end if;
  update public.reservations set people = p_people, version = version + 1 where id = p_reservation_id;
end $$;
revoke all on function public.set_reservation_people(uuid, integer, integer) from public, anon;
grant execute on function public.set_reservation_people(uuid, integer, integer) to authenticated;
