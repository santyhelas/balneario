"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatDateTime, formatMoney, todayISO } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Input, Select, Spinner, cx } from "@/components/ui";

type Filter = "hoy" | "proximas" | "deuda" | "finalizadas" | "canceladas" | "todas";
type Row = {
  id: string; number: number; start_date: string; end_date: string; status: string; is_courtesy: boolean; total_amount: number;
  customers: { first_name: string; last_name: string; phone: string | null };
  reservation_segments: { active: boolean; start_date: string; spaces: { code: string } }[];
};
type Bal = { reservation_id: string; paid_amount: number; due_amount: number; credit_amount: number };
type LastChange = { change_id: string; reservation_number: number; description: string; at: string; actor_email: string | null } | null;

const FILTERS: [Filter, string][] = [["hoy", "En curso hoy"], ["proximas", "Próximas"], ["deuda", "Con deuda"], ["finalizadas", "Finalizadas"], ["canceladas", "Canceladas"], ["todas", "Todas"]];

export default function ReservasPage() {
  const { ws } = useWorkspace();
  const sb = getSupabase();
  const today = todayISO(ws.timezone);
  const [filter, setFilter] = useState<Filter>("hoy");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const list = useLoader(async () => {
    let ids: string[] | null = null;
    if (filter === "deuda") {
      const debts = unwrap(await sb.from("reservation_balances").select("reservation_id").eq("workspace_id", ws.id).gt("due_amount", 0)) as { reservation_id: string }[];
      ids = debts.map((d) => d.reservation_id);
      if (ids.length === 0) return { rows: [] as Row[], bal: {} as Record<string, Bal> };
    }
    let query = sb.from("reservations")
      .select("id, number, start_date, end_date, status, is_courtesy, total_amount, customers!inner(first_name, last_name, phone), reservation_segments(active, start_date, spaces(code))")
      .eq("workspace_id", ws.id)
      .limit(200);
    if (filter === "hoy") query = query.eq("status", "confirmada").lte("start_date", today).gte("end_date", today).order("end_date");
    if (filter === "proximas") query = query.eq("status", "confirmada").gt("start_date", today).order("start_date");
    if (filter === "finalizadas") query = query.eq("status", "confirmada").lt("end_date", today).order("end_date", { ascending: false });
    if (filter === "canceladas") query = query.eq("status", "cancelada").order("cancelled_at", { ascending: false });
    if (filter === "todas") query = query.order("start_date", { ascending: false });
    if (filter === "deuda" && ids) query = query.in("id", ids).order("end_date");
    if (debounced) {
      if (/^#?\d+$/.test(debounced)) query = query.eq("number", Number(debounced.replace("#", "")));
      else {
        const safe = debounced.replace(/[%,()*]/g, " ");
        query = query.or(`first_name.ilike.%${safe}%,last_name.ilike.%${safe}%`, { referencedTable: "customers" });
      }
    }
    const rows = unwrap(await query) as unknown as Row[];
    const bal = rows.length
      ? (unwrap(await sb.from("reservation_balances").select("reservation_id, paid_amount, due_amount, credit_amount").in("reservation_id", rows.map((r) => r.id))) as Bal[])
      : [];
    return { rows, bal: Object.fromEntries(bal.map((b) => [b.reservation_id, b])) as Record<string, Bal> };
  }, [ws.id, filter, debounced, today]);

  // Deshacer último cambio
  const [undo, setUndo] = useState<LastChange>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  async function openUndo() {
    setMsg(null);
    const { data, error } = await sb.rpc("last_reversible_change", { p_workspace_id: ws.id });
    if (error) return setMsg({ tone: "danger", text: friendlyError(error) });
    if (!data) return setMsg({ tone: "danger", text: "No hay cambios para deshacer." });
    setUndo(data as LastChange);
    setUndoOpen(true);
  }
  async function doUndo() {
    if (!undo) return;
    setUndoBusy(true);
    const { error } = await sb.rpc("revert_change", { p_change_id: undo.change_id, p_reason: "Deshacer último cambio" });
    setUndoBusy(false);
    setUndoOpen(false);
    if (error) return setMsg({ tone: "danger", text: friendlyError(error) });
    setMsg({ tone: "ok", text: `Se deshizo: ${undo.description} (reserva #${undo.reservation_number}).` });
    list.reload();
  }

  return (
    <>
      <PageHeader
        title="Reservas"
        actions={
          <>
            <Button variant="secondary" onClick={openUndo}>Deshacer último cambio</Button>
            <Link href="/reservas/nueva"><Button>Nueva reserva</Button></Link>
          </>
        }
      />
      <SyncNotice error={list.error} stale={list.stale} updatedAt={list.updatedAt} onRetry={list.reload} />
      {msg && <Alert tone={msg.tone} className="mb-3">{msg.text}</Alert>}

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {FILTERS.map(([f, l]) => (
              <button key={f} onClick={() => setFilter(f)} className={cx("rounded-lg px-3 py-1.5 text-sm", filter === f ? "bg-accent text-accent-fg" : "bg-surface-2 hover:opacity-80")}>{l}</button>
            ))}
          </div>
          <Input type="search" placeholder="Buscar cliente o N° de reserva" value={q} onChange={(e) => setQ(e.target.value)} className="ml-auto max-w-xs" aria-label="Buscar" />
        </div>

        {list.loading && !list.data ? (
          <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando…</div>
        ) : !list.data || list.data.rows.length === 0 ? (
          <EmptyState>No hay reservas para mostrar.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr><th className="py-2 pr-3">N°</th><th className="pr-3">Cliente</th><th className="pr-3">Lugar</th><th className="pr-3">Estadía</th><th className="pr-3 text-right">Total</th><th className="pr-3 text-right">Saldo</th><th /></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.data.rows.map((r) => {
                  const b = list.data!.bal[r.id];
                  const codes = r.reservation_segments.filter((s) => s.active).sort((a, z) => a.start_date.localeCompare(z.start_date)).map((s) => s.spaces.code).filter((c, i, a) => a.indexOf(c) === i);
                  return (
                    <tr key={r.id} className="hover:bg-surface-2">
                      <td className="py-2 pr-3"><Link className="font-medium text-accent hover:underline" href={`/reservas/${r.id}`}>#{r.number}</Link></td>
                      <td className="pr-3">{r.customers.first_name} {r.customers.last_name}</td>
                      <td className="pr-3">{codes.join(" → ") || "—"}</td>
                      <td className="pr-3 whitespace-nowrap">{formatDate(r.start_date)} – {formatDate(r.end_date)}</td>
                      <td className="pr-3 text-right tabular">{formatMoney(r.total_amount)}</td>
                      <td className="pr-3 text-right tabular">
                        {r.status === "cancelada" ? <Badge tone="muted">Cancelada</Badge>
                          : r.is_courtesy ? <Badge tone="info">Cortesía</Badge>
                          : b && Number(b.due_amount) > 0 ? <span className="font-medium text-danger">{formatMoney(b.due_amount)}</span>
                          : <Badge tone="ok">Pagada</Badge>}
                      </td>
                      <td className="text-right"><Link href={`/reservas/${r.id}`} className="text-xs text-accent hover:underline">Abrir</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {list.data.rows.length === 200 && <p className="mt-2 text-xs text-muted">Se muestran las primeras 200. Usá la búsqueda para encontrar otras.</p>}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={undoOpen}
        title="Deshacer último cambio"
        message={undo ? <>Se va a revertir: <strong className="text-fg">{undo.description}</strong> (reserva #{undo.reservation_number}), hecho el {formatDateTime(undo.at, ws.timezone)}{undo.actor_email ? ` por ${undo.actor_email}` : ""}. El cambio original queda en el historial.</> : null}
        confirmLabel="Deshacer"
        busy={undoBusy}
        onConfirm={doUndo}
        onCancel={() => setUndoOpen(false)}
      />
    </>
  );
}
