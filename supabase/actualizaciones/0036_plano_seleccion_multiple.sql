-- ACTUALIZACIÓN 0036 · Plano: mover varias cosas juntas y copiar/pegar.
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0034; la 0035 ya no hace falta).
begin;
-- =====================================================================
-- 0036 · Plano: mover varias cosas juntas y copiar/pegar.
--   · move_map_items: guarda de una sola vez la ubicación nueva de varias
--     carpas, sombrillas y elementos (o se guardan todas, o ninguna).
--   · paste_map_items: duplica carpas, sombrillas y elementos. Las carpas y
--     sombrillas copiadas reciben el número siguiente libre (no se repiten).
-- =====================================================================

create or replace function public.move_map_items(p_workspace_id uuid, p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_ws public.workspaces%rowtype;
  v_it jsonb;
  v_x numeric;
  v_y numeric;
  v_n integer := 0;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'No hay nada para mover.';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'Son demasiadas cosas para mover de una vez.';
  end if;
  select * into v_ws from public.workspaces where id = p_workspace_id;
  for v_it in select * from jsonb_array_elements(p_items) loop
    v_x := round((v_it ->> 'x')::numeric);
    v_y := round((v_it ->> 'y')::numeric);
    if v_x is null or v_y is null or v_x < 0 or v_y < 0 or v_x > v_ws.map_width or v_y > v_ws.map_height then
      raise exception 'Hay cosas que quedarían fuera del plano.';
    end if;
    if v_it ->> 'type' = 'space' then
      update public.spaces set x = v_x, y = v_y, version = version + 1
       where id = (v_it ->> 'id')::uuid and workspace_id = p_workspace_id and version = (v_it ->> 'version')::integer;
    elsif v_it ->> 'type' = 'feature' then
      update public.map_features set x = v_x, y = v_y, version = version + 1
       where id = (v_it ->> 'id')::uuid and workspace_id = p_workspace_id and version = (v_it ->> 'version')::integer;
    else
      raise exception 'Tipo de elemento desconocido.';
    end if;
    if not found then
      raise exception 'Este dato fue modificado desde otro dispositivo. Recargá la pantalla e intentá de nuevo.'
        using errcode = '40001', hint = 'CONFLICTO_VERSION';
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.move_map_items(uuid, jsonb) from public, anon;
grant execute on function public.move_map_items(uuid, jsonb) to authenticated;

-- Número siguiente libre para una copia: "17" → el mayor número + 1; "C17" → "C" + (mayor de las "C…" + 1).
create or replace function private.next_space_code(p_workspace_id uuid, p_code text) returns text
language plpgsql set search_path = '' as $$
declare
  v_prefix text := coalesce(substring(btrim(p_code) from '^(.*?)[0-9]+$'), btrim(p_code) || ' ');
  v_max bigint;
  v_try text;
  v_i integer := 1;
begin
  select max(substring(btrim(code) from char_length(v_prefix) + 1)::bigint) into v_max
    from public.spaces
   where workspace_id = p_workspace_id
     and lower(left(btrim(code), char_length(v_prefix))) = lower(v_prefix)
     and substring(btrim(code) from char_length(v_prefix) + 1) ~ '^[0-9]{1,15}$';
  v_max := coalesce(v_max, 0);
  loop
    v_try := v_prefix || (v_max + v_i)::text;
    exit when char_length(v_try) <= 20 and not exists (
      select 1 from public.spaces where workspace_id = p_workspace_id and lower(btrim(code)) = lower(v_try));
    v_i := v_i + 1;
    if v_i > 100000 or char_length(v_try) > 20 then
      raise exception 'No se pudo numerar la copia de %.', p_code;
    end if;
  end loop;
  return v_try;
end $$;
revoke all on function private.next_space_code(uuid, text) from public, anon, authenticated;

create or replace function public.paste_map_items(p_workspace_id uuid, p_items jsonb, p_dx numeric, p_dy numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ws public.workspaces%rowtype;
  v_it jsonb;
  v_s public.spaces%rowtype;
  v_f public.map_features%rowtype;
  v_x numeric;
  v_y numeric;
  v_id uuid;
  v_out jsonb := '[]'::jsonb;
begin
  perform private.require_member(p_workspace_id, array['propietario','administrador']);
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'No hay nada copiado.';
  end if;
  if jsonb_array_length(p_items) > 300 then
    raise exception 'Se pueden pegar hasta 300 cosas de una vez.';
  end if;
  select * into v_ws from public.workspaces where id = p_workspace_id for update; -- los números de las copias no se pisan
  for v_it in select * from jsonb_array_elements(p_items) loop
    if v_it ->> 'type' = 'space' then
      select * into v_s from public.spaces where id = (v_it ->> 'id')::uuid and workspace_id = p_workspace_id;
      if not found then raise exception 'Una de las carpas copiadas ya no existe.'; end if;
      v_x := least(v_ws.map_width, greatest(0, round(v_s.x + coalesce(p_dx, 0))));
      v_y := least(v_ws.map_height, greatest(0, round(v_s.y + coalesce(p_dy, 0))));
      insert into public.spaces (workspace_id, kind, code, x, y, rotation)
        values (p_workspace_id, v_s.kind, private.next_space_code(p_workspace_id, v_s.code), v_x, v_y, v_s.rotation)
        returning id into v_id;
      v_out := v_out || jsonb_build_object('type', 'space', 'id', v_id);
    elsif v_it ->> 'type' = 'feature' then
      select * into v_f from public.map_features where id = (v_it ->> 'id')::uuid and workspace_id = p_workspace_id and active;
      if not found then raise exception 'Uno de los elementos copiados ya no existe.'; end if;
      v_x := least(v_ws.map_width, greatest(0, round(v_f.x + coalesce(p_dx, 0))));
      v_y := least(v_ws.map_height, greatest(0, round(v_f.y + coalesce(p_dy, 0))));
      insert into public.map_features (workspace_id, kind, label, x, y, width, height, rotation, color, layer)
        values (p_workspace_id, v_f.kind, v_f.label, v_x, v_y, v_f.width, v_f.height, v_f.rotation, v_f.color, v_f.layer)
        returning id into v_id;
      v_out := v_out || jsonb_build_object('type', 'feature', 'id', v_id);
    else
      raise exception 'Tipo de elemento desconocido.';
    end if;
  end loop;
  return v_out;
end $$;
revoke all on function public.paste_map_items(uuid, jsonb, numeric, numeric) from public, anon;
grant execute on function public.paste_map_items(uuid, jsonb, numeric, numeric) to authenticated;

commit;
