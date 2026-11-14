-- 0053 · Volver a habilitar un correo cuyo balneario se eliminó.
-- Antes: al eliminar un balneario, su correo quedaba marcado como "ya usado" y volver a habilitarlo
-- no hacía nada (la persona creaba su usuario y terminaba en la página de presupuestos).
-- Ahora la habilitación se renueva; y si el correo ya tiene un balneario activo, se avisa.

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
  -- Si ese correo ya usó su habilitación: si su balneario sigue existiendo se avisa (antes no hacía nada);
  -- si el balneario se eliminó, la habilitación vuelve a quedar disponible para crear uno nuevo.
  if exists (select 1 from private.signup_allowlist a where a.email = v and a.used_at is not null
               and a.workspace_id is not null and exists (select 1 from public.workspaces w where w.id = a.workspace_id)) then
    raise exception 'Ese correo ya tiene su balneario creado (%). Para cambiarle el plan o las carpas usá su tarjeta.',
      (select w.name from private.signup_allowlist a join public.workspaces w on w.id = a.workspace_id where a.email = v);
  end if;
  update private.signup_allowlist set used_at = null, workspace_id = null where email = v and used_at is not null;
  insert into private.signup_allowlist (email, note, plan, price, max_tents, max_umbrellas, entry_amount, installment_amount)
  values (v, nullif(btrim(coalesce(p_note, '')), ''), p_plan, v_price, p_tents, p_umbrellas,
          case when p_plan = 'temporada' then p_entry end, case when p_plan = 'temporada' then p_installment end)
  on conflict (email) do update set note = coalesce(excluded.note, private.signup_allowlist.note), plan = excluded.plan, price = excluded.price,
    max_tents = excluded.max_tents, max_umbrellas = excluded.max_umbrellas,
    entry_amount = excluded.entry_amount, installment_amount = excluded.installment_amount
  where private.signup_allowlist.used_at is null;
end $$;
