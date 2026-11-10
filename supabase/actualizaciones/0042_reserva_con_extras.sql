begin;
-- =====================================================================
-- 0042 · Nueva reserva con extras: todo en una sola operación.
--   Se crea la reserva, se le suman los extras elegidos y recién después se registra
--   el cobro (así «Pagada» cubre la carpa y los extras). Si algo falla, no queda nada a medias.
-- =====================================================================
create or replace function public.create_reservation_v3(
  p_workspace_id uuid, p_request_id uuid, p_customer_id uuid, p_start_date date, p_end_date date,
  p_segments jsonb, p_options jsonb default '{}'::jsonb, p_notes text default null, p_payment jsonb default null,
  p_extras jsonb default '[]'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.reservations%rowtype;
  v_res jsonb;
  v_id uuid;
  v_x jsonb;
begin
  perform private.require_member(p_workspace_id);
  select * into v_existing from public.reservations where workspace_id = p_workspace_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('reservation_id', v_existing.id, 'number', v_existing.number, 'repetida', true);
  end if;
  if p_extras is not null and jsonb_typeof(p_extras) <> 'array' then raise exception 'Extras inválidos.'; end if;
  if jsonb_array_length(coalesce(p_extras, '[]'::jsonb)) > 30 then raise exception 'Demasiados extras en una reserva.'; end if;

  v_res := public.create_reservation_v2(p_workspace_id, p_request_id, p_customer_id, p_start_date, p_end_date,
                                        p_segments, p_options, p_notes, null);
  v_id := (v_res ->> 'reservation_id')::uuid;

  for v_x in select * from jsonb_array_elements(coalesce(p_extras, '[]'::jsonb)) loop
    perform public.add_reservation_extra(v_id, (v_x ->> 'extra_id')::uuid, (v_x ->> 'quantity')::integer, nullif(v_x ->> 'days', '')::integer);
  end loop;

  if p_payment is not null then
    if nullif(p_payment ->> 'usd_amount', '') is not null then
      perform public.register_payment_usd(p_workspace_id, v_id, (p_payment ->> 'usd_amount')::numeric, (p_payment ->> 'exchange_rate')::numeric,
                                          (p_payment ->> 'idempotency_key')::uuid, null);
    else
      perform public.register_payment(p_workspace_id, v_id, (p_payment ->> 'amount')::numeric, p_payment ->> 'method',
                                      (p_payment ->> 'idempotency_key')::uuid, null);
    end if;
  end if;

  return v_res || jsonb_build_object('total_amount', (select total_amount from public.reservations where id = v_id));
end $$;
revoke all on function public.create_reservation_v3(uuid, uuid, uuid, date, date, jsonb, jsonb, text, jsonb, jsonb) from public, anon;
grant execute on function public.create_reservation_v3(uuid, uuid, uuid, date, date, jsonb, jsonb, text, jsonb, jsonb) to authenticated;

commit;
