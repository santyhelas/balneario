begin;

-- 0058 · Calendario de publicaciones de Instagram del dueño (ideas, fechas y descripciones).

create table if not exists private.ig_posts (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(btrim(title)) between 2 and 140),
  kind        text not null default 'post' check (kind in ('post','carrusel','reel','historia')),
  status      text not null default 'idea' check (status in ('idea','preparando','listo','publicado')),
  planned_on  date,
  caption     text check (char_length(caption) <= 2200),
  hashtags    text check (char_length(hashtags) <= 600),
  notes       text check (char_length(notes) <= 2000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     integer not null default 1
);
create index if not exists ig_posts_date_idx on private.ig_posts(planned_on);
alter table private.ig_posts enable row level security;
revoke all on private.ig_posts from public, anon, authenticated;

create or replace function public.admin_ig_posts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'titulo', title, 'tipo', kind, 'estado', status, 'fecha', planned_on,
                     'descripcion', caption, 'hashtags', hashtags, 'notas', notes, 'actualizado', updated_at, 'version', version)
                     order by planned_on nulls first, created_at) from private.ig_posts), '[]'::jsonb);
end $$;

create or replace function public.admin_save_ig_post(p_id uuid, p_version integer, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_old private.ig_posts%rowtype;
begin
  perform private.require_platform_admin();
  if char_length(btrim(coalesce(p ->> 'titulo', ''))) < 2 then raise exception 'Poné la idea de la publicación.'; end if;
  if p_id is null then
    insert into private.ig_posts (title, kind, status, planned_on, caption, hashtags, notes)
    values (btrim(p ->> 'titulo'), coalesce(nullif(p ->> 'tipo', ''), 'post'), coalesce(nullif(p ->> 'estado', ''), 'idea'), nullif(p ->> 'fecha', '')::date,
            nullif(p ->> 'descripcion', ''), nullif(btrim(coalesce(p ->> 'hashtags', '')), ''), nullif(btrim(coalesce(p ->> 'notas', '')), ''))
    returning id into v_id;
    return v_id;
  end if;
  select * into v_old from private.ig_posts where id = p_id for update;
  if not found then raise exception 'Esa publicación no existe.'; end if;
  if p_version is not null and v_old.version <> p_version then
    raise exception 'Este dato fue modificado desde otro dispositivo. Recargá la pantalla e intentá de nuevo.' using errcode = '40001', hint = 'CONFLICTO_VERSION';
  end if;
  update private.ig_posts set
    title = btrim(p ->> 'titulo'), kind = coalesce(nullif(p ->> 'tipo', ''), kind), status = coalesce(nullif(p ->> 'estado', ''), status),
    planned_on = nullif(p ->> 'fecha', '')::date, caption = nullif(p ->> 'descripcion', ''),
    hashtags = nullif(btrim(coalesce(p ->> 'hashtags', '')), ''), notes = nullif(btrim(coalesce(p ->> 'notas', '')), ''),
    updated_at = now(), version = version + 1
  where id = p_id;
  return p_id;
end $$;

-- Mover de fecha (arrastrar en el calendario) o cambiar el estado sin tocar lo demás.
create or replace function public.admin_move_ig_post(p_id uuid, p_date date, p_status text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  update private.ig_posts set planned_on = p_date, status = coalesce(p_status, status), updated_at = now(), version = version + 1 where id = p_id;
  if not found then raise exception 'Esa publicación no existe.'; end if;
end $$;

create or replace function public.admin_delete_ig_post(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  delete from private.ig_posts where id = p_id;
end $$;
revoke all on function public.admin_ig_posts(), public.admin_save_ig_post(uuid, integer, jsonb), public.admin_move_ig_post(uuid, date, text),
  public.admin_delete_ig_post(uuid) from public, anon;
grant execute on function public.admin_ig_posts(), public.admin_save_ig_post(uuid, integer, jsonb), public.admin_move_ig_post(uuid, date, text),
  public.admin_delete_ig_post(uuid) to authenticated;

commit;
