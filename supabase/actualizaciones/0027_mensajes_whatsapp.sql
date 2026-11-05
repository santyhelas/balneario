-- ACTUALIZACIÓN 0027 · Mensajes de WhatsApp propios del balneario.
-- Pegar en Supabase → SQL Editor → Run (una sola vez, después de la 0026).
begin;
-- =====================================================================
-- 0027 · Mensajes de WhatsApp propios de cada balneario.
--   message_templates = { "deuda_hoy": "Hola {nombre}…", … } (null o vacío → los de siempre).
-- =====================================================================
create or replace function private.valid_message_templates(s jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare k text;
begin
  if s is null then return true; end if;
  if jsonb_typeof(s) <> 'object' then return false; end if;
  for k in select jsonb_object_keys(s) loop
    if k not in ('deuda_hoy', 'deuda_manana', 'deuda_vencida', 'deuda_otros') then return false; end if;
    if jsonb_typeof(s -> k) <> 'string' or char_length(s ->> k) > 1000 then return false; end if;
  end loop;
  return true;
end $$;

alter table public.workspaces add column if not exists message_templates jsonb;
alter table public.workspaces drop constraint if exists workspaces_message_templates_check;
alter table public.workspaces add constraint workspaces_message_templates_check check (private.valid_message_templates(message_templates));
grant update (message_templates) on public.workspaces to authenticated;

commit;
