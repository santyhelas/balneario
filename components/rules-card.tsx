"use client";
import { useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { useLoader } from "@/lib/data";
import { friendlyError, isVersionConflict } from "@/lib/errors";
import { formatMoney, parseMoney } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { Alert, Button, Card, Spinner, TextField } from "@/components/ui";

type Row = { cash_limit: number | null; discount_cap_percent: number | null; tent_capacity?: number | null; umbrella_capacity?: number | null; version: number };

/** Configuración: límite de efectivo en caja, tope de descuento y máximo de personas por carpa/sombrilla. */
export function RulesCard() {
  const { ws, isAdmin } = useWorkspace();
  const sb = getSupabase();
  const q = useLoader(async () => {
    const full = await sb.from("workspaces").select("cash_limit, discount_cap_percent, tent_capacity, umbrella_capacity, version").eq("id", ws.id).single();
    if (!full.error) return { ...(full.data as Row), capacityReady: true };
    if (full.error.code !== "42703") throw full.error;
    // Sin la actualización 0046 todavía: se muestra lo demás igual.
    const r = await sb.from("workspaces").select("cash_limit, discount_cap_percent, version").eq("id", ws.id).single();
    if (r.error?.code === "42703") return null;
    if (r.error) throw r.error;
    return { ...(r.data as Row), capacityReady: false };
  }, [ws.id], 0);
  if (q.data === null) {
    return <Card title="Caja y descuentos"><p className="text-sm text-muted">Para usar esto hay que aplicar la actualización 0033 de la base de datos.</p></Card>;
  }
  if (!q.data) return <Card title="Caja y descuentos"><div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando…</div></Card>;
  return <RulesForm key={q.data.version} row={q.data} editable={isAdmin} onSaved={q.reload} />;
}

function RulesForm({ row, editable, onSaved }: { row: Row & { capacityReady: boolean }; editable: boolean; onSaved: () => void }) {
  const { ws } = useWorkspace();
  const [tentCap, setTentCap] = useState(row.tent_capacity ? String(row.tent_capacity) : "");
  const [umbCap, setUmbCap] = useState(row.umbrella_capacity ? String(row.umbrella_capacity) : "");
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
    const capOf = (v: string) => (v.trim() === "" ? null : Number(v));
    const tc = capOf(tentCap), uc = capOf(umbCap);
    for (const [v, n] of [[tc, "carpa"], [uc, "sombrilla"]] as const) {
      if (v !== null && (!Number.isInteger(v) || v < 1 || v > 100)) return setMsg({ tone: "danger", text: `El máximo de personas por ${n} tiene que ser un número entero entre 1 y 100 (o vacío para no tener máximo).` });
    }
    setBusy(true);
    setMsg(null);
    const patch: Record<string, unknown> = { cash_limit: l, discount_cap_percent: c, version: row.version + 1 };
    if (row.capacityReady) { patch.tent_capacity = tc; patch.umbrella_capacity = uc; }
    const { error } = await getSupabase().from("workspaces").update(patch).eq("id", ws.id).select("id").single();
    setBusy(false);
    if (error) return setMsg({ tone: "danger", text: isVersionConflict(error) ? "Otra persona cambió la configuración recién. Recargá y probá de nuevo." : friendlyError(error) });
    setMsg({ tone: "ok", text: "Guardado." });
    onSaved();
  }

  return (
    <Card title="Caja, descuentos y reservas">
      <form onSubmit={save} className="flex flex-col gap-3 text-sm">
        {row.capacityReady ? (
          <div>
            <div className="grid grid-cols-2 gap-3">
              <TextField label="Máximo de personas por carpa" inputMode="numeric" value={tentCap} onChange={(e) => setTentCap(e.target.value.replace(/\D/g, ""))} placeholder="Sin máximo" disabled={!editable} />
              <TextField label="Máximo por sombrilla" inputMode="numeric" value={umbCap} onChange={(e) => setUmbCap(e.target.value.replace(/\D/g, ""))} placeholder="Sin máximo" disabled={!editable} />
            </div>
            <p className="mt-1 text-xs text-muted">Al cargar una reserva con más personas que este máximo, el sistema preselecciona las carpas que hacen falta, pegadas en el plano.</p>
          </div>
        ) : (
          <p className="text-xs text-muted">Para fijar el máximo de personas por carpa hay que aplicar la actualización 0046 de la base de datos.</p>
        )}
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
