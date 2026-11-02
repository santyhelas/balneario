-- =====================================================================
-- 0015 · Diseño de las carpas y sombrillas en el plano.
--   tent_style = null → el diseño clásico (a rayas del color del estado).
--   Se puede ejecutar aunque ya se haya aplicado la versión anterior (tent_color).
-- =====================================================================
create or replace function private.valid_tent_style(s jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  k text;
  hex constant text := '^#[0-9a-fA-F]{6}$';
begin
  if s is null then return true; end if;
  if jsonb_typeof(s) <> 'object' then return false; end if;
  for k in select jsonb_object_keys(s) loop
    if k not in ('pattern','fill','accent','border','borderWidth','numberBg','numberText','stateDot') then return false; end if;
  end loop;
  return coalesce(
        (s->>'pattern') in ('liso','rayas','rayas_finas','cuadros','lunares','franja')
    and ((s->>'fill') ~ hex or s->>'fill' = 'estado')
    and ((s->>'accent') ~ hex or s->>'accent' = 'estado')
    and ((s->>'border') ~ hex or s->>'border' in ('estado','ninguno'))
    and (s->'borderWidth') in ('1'::jsonb, '2'::jsonb, '3'::jsonb)
    and ((s->>'numberBg') ~ hex or s->>'numberBg' in ('estado','ninguno'))
    and ((s->>'numberText') ~ hex or s->>'numberText' = 'estado')
    and jsonb_typeof(s->'stateDot') = 'boolean', false);
end $$;

alter table public.workspaces add column if not exists tent_style jsonb;
alter table public.workspaces drop constraint if exists workspaces_tent_style_check;
alter table public.workspaces add constraint workspaces_tent_style_check check (private.valid_tent_style(tent_style));
grant update (tent_style) on public.workspaces to authenticated;

-- Versión anterior de esta actualización (solo un color): ya no se usa.
alter table public.workspaces drop column if exists tent_color;
