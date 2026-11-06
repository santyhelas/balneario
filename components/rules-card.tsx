"use client";
import { useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { useLoader } from "@/lib/data";
import { friendlyError, isVersionConflict } from "@/lib/errors";
import { formatMoney, parseMoney } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { Alert, Button, Card, Spinner, TextField } from "@/components/ui";

/** Configuración: límite de efectivo en caja y tope de descuento. */
export function RulesCard() {
  const { ws, isAdmin } = useWorkspace();
  const sb = getSupabase();
  const q = useLoader(async () => {
    const r = await sb.from("workspaces").select("cash_limit, discount_cap_percent, version").eq("id", ws.id).single();
    if (r.error?.code === "42703") return null;
    if (r.error) throw r.error;
    return r.data as { cash_limit: number | null; discount_cap_percent: number | null; version: number };
  }, [ws.id], 0);
  if (q.data === null) {
    return <Card title="Caja y descuentos"><p className="text-sm text-muted">Para usar esto hay que aplicar la actualización 0033 de la base de datos.</p></Card>;
  }
  if (!q.data) return <Card title="Caja y descuentos"><div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando…</div></Card>;
  return <RulesForm key={q.data.version} row={q.data} editable={isAdmin} onSaved={q.reload} />;
}

function RulesForm({ row, editable, onSaved }: { row: { cash_limit: number | null; discount_cap_percent: number | null; version: number }; editable: boolean; onSaved: () => void }) {
  const { ws } = useWorkspace();
  const [limit, setLimit] = useState(row.cash_limit ? String(Number(row.cash_limit)) : "");
  const [cap, setCap] = useState(row.discount_cap_percent ? String(Number(row.discount_cap_percent)) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const l = limit.trim() === "" ? null : parseMoney(limit);
    const c = cap.trim() === "" ? null : Number(cap.replace(",", "."));
    if (l !== null && (!l || l <= 0)) return setMsg({ tone: "danger", text: "El límite de efectivo tiene que ser mayor a cero (o vacío para no tener límite)." });
    if (c !== null && (!Number.isFinite(c) || c <= 0 || c > 100)) return setMsg({ tone: "danger", text: "El tope de descuento tiene que ser entre 1 y 100% (o vacío para no tener tope)." });
    setBusy(true);
    setMsg(null);
    const { error } = await getSupabase().from("workspaces").update({ cash_limit: l, discount_cap_percent: c, version: row.version + 1 }).eq("id", ws.id).select("id").single();
    setBusy(false);
    if (error) return setMsg({ tone: "danger", text: isVersionConflict(error) ? "Otra persona cambió la configuración recién. Recargá y probá de nuevo." : friendlyError(error) });
    setMsg({ tone: "ok", text: "Guardado." });
    onSaved();
  }

  return (
    <Card title="Caja y descuentos">
      <form onSubmit={save} className="flex flex-col gap-3 text-sm">
        <div>
          <TextField label="Límite de efectivo en caja" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Sin límite" disabled={!editable} />
          <p className="mt-1 text-xs text-muted">Cuando el efectivo de la caja pasa este monto, te avisa que conviene hacer un depósito.{row.cash_limit ? ` Ahora: ${formatMoney(row.cash_limit)}.` : ""}</p>
        </div>
        <div>
          <TextField label="Tope de descuento (%)" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="Sin tope" disabled={!editable} />
          <p className="mt-1 text-xs text-muted">Ninguna reserva puede tener, sumando todos sus descuentos, más que este porcentaje del precio. También se cambia en Convenios y descuentos.</p>
        </div>
        {editable ? <Button type="submit" loading={busy} className="self-start">Guardar</Button> : <p className="text-xs text-muted">Solo los administradores pueden cambiar esto.</p>}
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </form>
    </Card>
  );
}
