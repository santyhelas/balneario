"use client";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { downloadText } from "@/lib/csv";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, EmptyState, Spinner, TextField } from "@/components/ui";

type Backup = { id: string; kind: "manual" | "automatica"; note: string | null; counts: Record<string, number>; size_bytes: number; created_at: string; created_by_email: string | null };

const LABELS: Record<string, string> = {
  customers: "clientes", reservations: "reservas", reservation_segments: "tramos", payments: "pagos",
  cash_sessions: "cajas", cash_movements: "movimientos", expenses: "gastos", rates: "tarifas", spaces: "espacios",
};

export default function CopiasPage() {
  const { ws, isAdmin } = useWorkspace();
  const sb = getSupabase();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  const q = useLoader(async () => unwrap(await sb.from("backups").select("id, kind, note, counts, size_bytes, created_at, created_by_email")
    .eq("workspace_id", ws.id).order("created_at", { ascending: false }).limit(60)) as Backup[], [ws.id], 0);

  async function create() {
    setBusy(true);
    setMsg(null);
    const { data, error } = await sb.rpc("create_backup", { p_workspace_id: ws.id, p_kind: "manual", p_note: note || null });
    setBusy(false);
    if (error) return setMsg({ tone: "danger", text: friendlyError(error) });
    const c = (data as { counts: Record<string, number> }).counts;
    setNote("");
    setMsg({ tone: "ok", text: `Copia creada: ${c.reservations ?? 0} reservas, ${c.customers ?? 0} clientes, ${c.payments ?? 0} pagos.` });
    q.reload();
  }

  async function download(b: Backup) {
    setDownloading(b.id);
    setMsg(null);
    const { data, error } = await sb.from("backups").select("data, created_at").eq("id", b.id).single();
    setDownloading(null);
    if (error) return setMsg({ tone: "danger", text: friendlyError(error) });
    const stamp = b.created_at.slice(0, 16).replace(/[:T]/g, "-");
    downloadText(`copia_${ws.name.replace(/[^\w]+/g, "_")}_${stamp}.json`, JSON.stringify({ formato: "balneario-copia-v1", creada: b.created_at, ...(data as { data: object }).data }, null, 1), "application/json");
  }

  return (
    <>
      <PageHeader title="Copias de seguridad" subtitle="Una foto completa de los datos: clientes, reservas, tramos, pagos, caja, gastos, tarifas, configuración e historial." />
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {msg && <Alert tone={msg.tone} className="mb-3">{msg.text}</Alert>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div className="flex flex-col gap-4">
          <Card title="Crear copia ahora">
            {isAdmin ? (
              <div className="flex flex-col gap-3">
                <TextField label="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Ej: antes de cambiar tarifas" />
                <Button onClick={create} loading={busy}>Crear copia</Button>
              </div>
            ) : <p className="text-sm text-muted">Solo los administradores pueden crear copias manuales.</p>}
          </Card>
          <Card title="Cómo funciona">
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
              <li><strong className="text-fg">Automática:</strong> se hace sola una vez por día al abrir el sistema. Se guardan las últimas 30.</li>
              <li><strong className="text-fg">Manual:</strong> cuando quieras, por ejemplo antes de un cambio grande.</li>
              <li><strong className="text-fg">Descargar:</strong> baja un archivo con todo, para guardarlo en tu computadora o en Google Drive.</li>
              <li>Las copias quedan en el servidor: no se pierden si se cambia o actualiza la página.</li>
            </ul>
            <Alert tone="info" className="mt-3">La restauración de una copia se hace con asistencia, para no pisar datos por accidente. Si alguna vez la necesitás, pedila indicando la fecha de la copia.</Alert>
          </Card>
        </div>

        <Card title="Historial de copias">
          {q.loading && !q.data ? <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando…</div>
            : !q.data || q.data.length === 0 ? <EmptyState>Todavía no hay copias. La primera automática se crea al abrir el panel.</EmptyState> : (
            <ul className="divide-y divide-line text-sm">
              {q.data.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium">
                      {formatDateTime(b.created_at, ws.timezone)}
                      <Badge tone={b.kind === "manual" ? "info" : "muted"}>{b.kind === "manual" ? "Manual" : "Automática"}</Badge>
                    </div>
                    <div className="text-xs text-muted">
                      {Object.entries(LABELS).filter(([k]) => b.counts[k] !== undefined).map(([k, l]) => `${b.counts[k]} ${l}`).join(" · ")}
                      {" · "}{(b.size_bytes / 1024).toFixed(0)} KB{b.note ? ` · ${b.note}` : ""}{b.created_by_email && b.kind === "manual" ? ` · ${b.created_by_email}` : ""}
                    </div>
                  </div>
                  <Button variant="secondary" onClick={() => download(b)} loading={downloading === b.id}>Descargar</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
