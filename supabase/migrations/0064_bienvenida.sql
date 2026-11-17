-- =====================================================================
-- 0064 · Mensaje de bienvenida por WhatsApp (con las reglas del balneario).
--        Se guarda junto a los otros mensajes: message_templates.bienvenida (hasta 2000 letras).
-- =====================================================================
create or replace function private.valid_message_templates(s jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare k text; v_max integer;
begin
  if s is null then return true; end if;
  if jsonb_typeof(s) <> 'object' then return false; end if;
  for k in select jsonb_object_keys(s) loop
    if k not in ('deuda_hoy', 'deuda_manana', 'deuda_vencida', 'deuda_otros', 'mail_asunto', 'mail_cuerpo', 'bienvenida') then return false; end if;
    if jsonb_typeof(s -> k) <> 'string' then return false; end if;
    v_max := (case k when 'mail_asunto' then 200 when 'mail_cuerpo' then 3000 when 'bienvenida' then 2000 else 1000 end);
    if char_length(s ->> k) > v_max then return false; end if;
  end loop;
  return true;
end $$;
