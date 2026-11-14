begin;

-- 0052 · Planes: Temporada habilita todo el año y sus cuotas vencen a principio de febrero y de marzo.
--
-- · Temporada: la entrada (al contratar) habilita 12 meses, como el Anual. La cuota 1 (enero) vence el
--   1 de febrero y la cuota 2 (febrero) el 1 de marzo; pagarlas no cambia el vencimiento, queda registrado.
-- · El Panel del dueño avisa las cuotas vencidas sin pagar (no se bloquea al balneario por eso).

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
    v_label := case v_part when 1 then 'Entrada' when 2 then 'Cuota 1 de 2 (enero, vence a principio de febrero)' else 'Cuota 2 de 2 (febrero, vence a principio de marzo)' end;
    -- La entrada habilita todo el año (12 meses); las cuotas no cambian el vencimiento.
    v_until := coalesce(p_until, case when v_part = 1 then private.extend_until('anual', s.paid_until, private.today_ar())
                                      else greatest(s.paid_until, private.today_ar()) end);
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
        jsonb_build_object('nombre', 'Cuota 1 (enero)', 'importe', s.installment_amount, 'vence', make_date(extract(year from v_season)::int, 2, 1), 'pagada', v_paid >= 2),
        jsonb_build_object('nombre', 'Cuota 2 (febrero)', 'importe', s.installment_amount, 'vence', make_date(extract(year from v_season)::int, 3, 1), 'pagada', v_paid >= 3)) end,
    'bloquea_desde', case when s.status = 'exenta' then null else coalesce(s.paid_until, s.created_at::date) + v_grace + 1 end,
    'vencido', private.plan_expired(p_workspace_id), 'dias_gracia', v_grace,
    'proximo_debito', s.next_charge_on, 'debito_automatico', s.mp_preapproval_id is not null and s.status = 'activa',
    'pagador', s.mp_payer_email, 'ultimo_pago', s.last_payment_at, 'ultimo_estado', s.last_payment_status,
    'temporada_hasta', v_season, 'hoy', private.today_ar(),
    'movimientos', coalesce((select jsonb_agg(jsonb_build_object('tipo', e.kind, 'importe', e.amount, 'detalle', e.detail, 'fecha', e.created_at) order by e.created_at desc)
                             from (select * from public.subscription_events where workspace_id = p_workspace_id order by created_at desc limit 12) e), '[]'::jsonb)
  );
end $$;

commit;
