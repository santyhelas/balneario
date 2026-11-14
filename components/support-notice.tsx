"use client";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/format";

type Access = { id: string; fecha: string; motivo: string | null };
const KEY = "balneario-soporte-visto";

/** Aviso al balneario: el soporte de Mi Balneario miró sus datos (solo lectura). Se oculta con «Entendido» hasta el próximo ingreso de soporte. */
export function SupportAccessNotice({ workspaceId }: { workspaceId: string }) {
  const [last, setLast] = useState<Access | null>(null);
  useEffect(() => {
    getSupabase().rpc("support_accesses", { p_workspace_id: workspaceId }).then(({ data }) => {
      const list = (data as Access[] | null) ?? [];
      if (!list.length) return;
      let seen: string | null = null;
      try { seen = localStorage.getItem(`${KEY}-${workspaceId}`); } catch { /* sin almacenamiento */ }
      if (seen !== list[0].id) setLast(list[0]);
    }, () => undefined);
  }, [workspaceId]);
  if (!last) return null;
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-950 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100">
      <span>
        El soporte de Mi Balneario miró tus datos el <strong>{formatDateTime(last.fecha)}</strong>{last.motivo ? ` (${last.motivo})` : ""}, solo para ayudarte: no cambió nada.
      </span>
      <button type="button" className="rounded-lg border border-sky-400 px-3 py-1 font-semibold hover:bg-white/60 dark:hover:bg-black/20"
        onClick={() => { try { localStorage.setItem(`${KEY}-${workspaceId}`, last.id); } catch { /* sin almacenamiento */ } setLast(null); }}>
        Entendido
      </button>
    </div>
  );
}
