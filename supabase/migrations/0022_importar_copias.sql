-- =====================================================================
-- 0022 · Importar una copia de seguridad desde un archivo descargado.
--   · Solo el propietario. El archivo se revisa y queda guardado como una copia
--     más ("Importada"); para usarla hay que tocar Restaurar (dos pasos, a propósito).
--   · Si el archivo es de OTRO balneario (por ejemplo, para pasar los datos a una
--     cuenta nueva), se le asignan identificadores nuevos para que no choque con nada.
-- =====================================================================
alter table public.backups drop constraint if exists backups_kind_check;
alter table public.backups add constraint backups_kind_check check (kind in ('manual', 'automatica', 'importada'));

create or replace function public.import_backup(p_workspace_id uuid, p_data jsonb, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tables text[] := private.restore_tables();
  v_src text;
  v_remap boolean;
  v_out jsonb := '{}'::jsonb;
  v_rows jsonb;
  v_counts jsonb;
  v_total integer := 0;
  v_size integer;
  v_id uuid;
  t text;
begin
  perform private.require_member(p_workspace_id, array['propietario']);
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'El archivo no es una copia de seguridad del sistema.';
  end if;
  if coalesce(p_data ->> 'formato', 'balneario-copia-v1') <> 'balneario-copia-v1'
     or not (p_data ? 'reservations' and p_data ? 'customers') then
    raise exception 'El archivo no es una copia de seguridad del sistema (faltan reservas o clientes).';
  end if;
  v_size := octet_length(p_data::text);
  if v_size > 50 * 1024 * 1024 then
    raise exception 'El archivo es demasiado grande (máximo 50 MB).';
  end if;

  foreach t in array v_tables loop
    v_rows := coalesce(p_data -> t, '[]'::jsonb);
    if jsonb_typeof(v_rows) <> 'array' then
      raise exception 'El archivo está dañado (la parte "%" no es una lista).', t;
    end if;
    v_total := v_total + jsonb_array_length(v_rows);
  end loop;
  if v_total > 300000 then
    raise exception 'El archivo tiene demasiados registros.';
  end if;

  v_src := p_data -> 'workspace' ->> 'id';
  v_remap := v_src is distinct from p_workspace_id::text;

  -- Las copias viejas (antes de la actualización 0021) no guardaban bien las carpas: no se pueden pasar a otro balneario.
  if v_remap and jsonb_array_length(coalesce(p_data -> 'spaces', '[]'::jsonb)) > 0
     and jsonb_typeof(p_data -> 'spaces' -> 0) <> 'object' then
    raise exception 'Esta copia es anterior a la actualización de las copias y no guarda las carpas: solo se puede usar en el mismo balneario donde se hizo.';
  end if;

  -- Identificadores nuevos cuando la copia viene de otro balneario.
  create temporary table if not exists _idmap (old_txt text primary key, new uuid not null) on commit drop;
  truncate _idmap;
  if v_remap then
    foreach t in array v_tables loop
      insert into _idmap (old_txt, new)
      select r ->> 'id', gen_random_uuid()
      from jsonb_array_elements(coalesce(p_data -> t, '[]'::jsonb)) r
      where jsonb_typeof(r) = 'object' and r ? 'id'
      on conflict (old_txt) do nothing;
    end loop;
  end if;

  foreach t in array v_tables loop
    v_rows := coalesce(p_data -> t, '[]'::jsonb);
    select coalesce(jsonb_agg(
             case when jsonb_typeof(r) = 'object' then
               r
               || coalesce((select jsonb_object_agg(e.key, to_jsonb(m.new)) from jsonb_each_text(r) e join _idmap m on m.old_txt = e.value), '{}'::jsonb)
               || jsonb_build_object('workspace_id', p_workspace_id)
             else r end), '[]'::jsonb)
      into v_rows
    from jsonb_array_elements(v_rows) r;
    v_out := v_out || jsonb_build_object(t, v_rows);
  end loop;
  v_out := v_out || jsonb_build_object('workspace', jsonb_build_object('id', p_workspace_id),
                                       'importada_de', v_src, 'creada_original', p_data ->> 'creada');

  select jsonb_object_agg(key, jsonb_array_length(value)) into v_counts from jsonb_each(v_out) where jsonb_typeof(value) = 'array';
  insert into public.backups (workspace_id, kind, note, counts, size_bytes, data, created_by_email)
  values (p_workspace_id, 'importada',
          left(coalesce(nullif(btrim(p_note), ''), 'Archivo importado') ||
               case when p_data ? 'creada' then ' · copia del ' || to_char((p_data ->> 'creada')::timestamptz at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI') else '' end ||
               case when v_remap then ' · de otro balneario' else '' end, 200),
          v_counts, octet_length(v_out::text), v_out,
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  returning id into v_id;
  return jsonb_build_object('backup_id', v_id, 'counts', v_counts, 'de_otro_balneario', v_remap);
end $$;

revoke all on function public.import_backup(uuid, jsonb, text) from public, anon;
grant execute on function public.import_backup(uuid, jsonb, text) to authenticated;
