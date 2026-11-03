-- =====================================================================
-- 0018 · Notas del día para el personal ("hoy viene el proveedor de hielo").
--   Cualquier usuario del balneario las crea, las tilda como hechas o las quita.
--   No se borran: "quitar" las oculta y queda en el historial.
-- =====================================================================
create table public.day_notes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  day          date not null,
  text         text not null check (char_length(btrim(text)) between 1 and 300),
  done         boolean not null default false,
  done_at      timestamptz,
  done_by      uuid,
  active       boolean not null default true,
  created_by   uuid not null default auth.uid(),
  created_at   timestamptz not null default now(),
  version      integer not null default 1
);
create index day_notes_ws_day_idx on public.day_notes(workspace_id, day);

create trigger day_notes_version before update on public.day_notes
  for each row execute function private.check_version();
create trigger day_notes_audit after insert or update on public.day_notes
  for each row execute function private.audit();
create trigger day_notes_no_delete before delete on public.day_notes
  for each row execute function private.forbid_change();

alter table public.day_notes enable row level security;
create policy "miembros leen notas" on public.day_notes for select to authenticated using (private.is_member(workspace_id));
create policy "miembros crean notas" on public.day_notes for insert to authenticated
  with check (private.is_member(workspace_id) and created_by = auth.uid());
create policy "miembros editan notas" on public.day_notes for update to authenticated
  using (private.is_member(workspace_id)) with check (private.is_member(workspace_id));

revoke all on public.day_notes from anon, authenticated;
grant select on public.day_notes to authenticated;
grant insert (workspace_id, day, text) on public.day_notes to authenticated;
grant update (text, day, done, done_at, done_by, active, version) on public.day_notes to authenticated;
