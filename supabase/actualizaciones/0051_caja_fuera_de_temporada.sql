begin;

-- 0051 · Fuera de temporada: el balneario puede apagar los avisos de la caja diaria
-- (no se pide abrirla al entrar ni avisa «Caja sin abrir»). La caja sigue funcionando si se la abre a mano.

alter table public.workspaces add column if not exists cash_prompts boolean not null default true;
grant update (cash_prompts) on public.workspaces to authenticated;

commit;
