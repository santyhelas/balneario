"use client";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { FEATURE_INFO, featuresOf, type Features } from "@/lib/features";
import { useWorkspace } from "@/components/workspace";

/** Prende o apaga una función opcional del balneario (con control de versión). Devuelve el error, si hubo. */
export async function setFeature(wsId: string, k: keyof Features, value: boolean): Promise<string | null> {
  const sb = getSupabase();
  const cur = await sb.from("workspaces").select("features, version").eq("id", wsId).single();
  if (cur.error) return friendlyError(cur.error);
  const row = cur.data as { features: Record<string, boolean>; version: number };
  const { error } = await sb.from("workspaces").update({ features: { ...row.features, [k]: value }, version: row.version + 1 }).eq("id", wsId);
  return error ? friendlyError(error) : null;
}

/** Funciones opcionales: lo que no usa el balneario no aparece en pantalla. */
export function FeaturesCard() {
  const { ws, isAdmin, reloadWorkspace } = useWorkspace();
  const [busy, setBusy] = useState<keyof Features | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (ws.features === undefined) return <p className="text-sm text-muted">Para elegir funciones hay que aplicar la actualización 0060 de la base de datos.</p>;
  const f = featuresOf(ws);
  async function toggle(k: keyof Features) {
    setBusy(k);
    setErr(null);
    const error = await setFeature(ws.id, k, !f[k]);
    if (error) { setBusy(null); return setErr(error); }
    await reloadWorkspace();
    setBusy(null);
  }
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">Funciones opcionales</h3>
      <p className="mb-2 text-xs text-muted">Prendé solo lo que usás: lo demás no aparece y el sistema queda más simple.</p>
      <ul className="flex flex-col gap-2">
        {FEATURE_INFO.map((x) => (
          <li key={x.key}>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 hover:bg-surface-2">
              <input type="checkbox" className="mt-1" checked={f[x.key]} disabled={!isAdmin || busy !== null} onChange={() => toggle(x.key)} />
              <span><span className="block text-sm font-medium">{x.label}{busy === x.key && " …"}</span><span className="block text-xs text-muted">{x.help}</span></span>
            </label>
          </li>
        ))}
      </ul>
      {!isAdmin && <p className="mt-2 text-xs text-muted">Solo un administrador puede cambiarlas.</p>}
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </div>
  );
}
