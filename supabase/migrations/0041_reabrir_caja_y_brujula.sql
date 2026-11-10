-- =====================================================================
-- 0041 · Reabrir la caja de hoy (si se cerró por error) y ubicación de la brújula en el plano.
--   · Reabrir: solo la caja del día, solo propietario o administrador y con motivo.
--     El cierre anterior no se pierde: queda guardado en reopen_history (y en el historial).
--     Los movimientos no se tocan.
--   · compass_layout: dónde va la brújula sobre el plano y de qué tamaño ({x, y, scale}).
-- =====================================================================
alter table public.cash_sessions add column if not exists reopen_history jsonb;
alter table public.workspaces add column if not exists compass_layout jsonb;

-- La caja cerrada sigue sin poder modificarse, salvo dentro de reopen_cash_session.
create or replace function private.cash_sessions_guard() returns trigger
language plpgsql as $$
begin
  if old.closed_at is not null and coalesce(current_setting('app.cash_reopen', true), '') <> old.id::text then
    raise exception 'Esta caja ya está cerrada y no se puede modificar.' using errcode = '42501';
  end if;
  if new.opening_cash <> old.opening_cash or new.business_date <> old.business_date then
    raise exception 'La apertura de caja no se puede modificar.' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.reopen_cash_session(p_session_id uuid, p_expected_version integer, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_s public.cash_sessions%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_s from public.cash_sessions where id = p_session_id for update;
  if not found then raise exception 'La caja no existe.'; end if;
  perform private.require_member(v_s.workspace_id, array['propietario','administrador']);
  if v_s.closed_at is null then raise exception 'Esta caja ya está abierta.'; end if;
  if v_s.business_date <> private.ws_today(v_s.workspace_id) then
    raise exception 'Solo se puede reabrir la caja de hoy.';
  end if;
  if v_s.version <> p_expected_version then
    raise exception 'Otra persona cambió esta caja recién. Volvé a intentar.' using errcode = '40001';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then raise exception 'Escribí el motivo para reabrir la caja.'; end if;
  if char_length(v_reason) > 300 then raise exception 'El motivo puede tener hasta 300 caracteres.'; end if;
  if exists (select 1 from public.cash_sessions where workspace_id = v_s.workspace_id and closed_at is null) then
    raise exception 'Ya hay otra caja abierta.';
  end if;

  perform set_config('app.cash_reopen', v_s.id::text, true);
  update public.cash_sessions set
    reopen_history = coalesce(reopen_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'cerrada', v_s.closed_at, 'cerrada_por', v_s.closed_by, 'contado', v_s.counted_cash, 'esperado', v_s.expected_cash,
      'diferencia', v_s.difference, 'notas', v_s.close_notes, 'reabierta', now(), 'reabierta_por', auth.uid(), 'motivo', v_reason)),
    closed_at = null, closed_by = null, counted_cash = null, expected_cash = null, difference = null, close_notes = null,
    version = p_expected_version + 1
  where id = v_s.id;
  perform set_config('app.cash_reopen', '', true);

  return public.cash_session_summary(v_s.id);
end $$;
revoke all on function public.reopen_cash_session(uuid, integer, text) from public, anon;
grant execute on function public.reopen_cash_session(uuid, integer, text) to authenticated;
