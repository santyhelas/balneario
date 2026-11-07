"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { addDays, formatDate, formatMoney, todayISO } from "@/lib/format";
import { METHOD_LABEL } from "@/lib/methods";
import { useWorkspace } from "@/components/workspace";
import { useStatus } from "@/components/status";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Button, Card, ConfirmDialog, EmptyState, Field, Input, Select, Spinner, TextField, cx } from "@/components/ui";
import { ExpenseModal, type ExpenseCategory } from "@/components/cash";
import { downloadXlsx } from "@/lib/xlsx";

type Row = {
  id: string; amount: number; spent_on: string; concept: string; supplier: string | null; method: string; notes: string | null;
  voided_at: string | null; void_reason: string | null; created_at: string; category_id: string;
};

export default function GastosPage() {
  const { ws, isAdmin } = useWorkspace();
  const status = useStatus();
  const sb = getSupabase();
  const today = todayISO(ws.timezone);
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const [cat, setCat] = useState("");
  const [showVoided, setShowVoided] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [voiding, setVoiding] = useState<Row | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Abre "Nuevo gasto" directamente si se llegó desde la barra superior (?nuevo=1).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("nuevo") === "1") {
      setNewOpen(true);
      window.history.replaceState(null, "", "/gastos");
    }
  }, []);

  const q = useLoader(async () => {
    const cats = unwrap(await sb.from("expense_categories").select("id, name, active").eq("workspace_id", ws.id).order("name")) as ExpenseCategory[];
    let query = sb.from("expenses").select("id, amount, spent_on, concept, supplier, method, notes, voided_at, void_reason, created_at, category_id")
      .eq("workspace_id", ws.id).gte("spent_on", from).lte("spent_on", to).order("spent_on", { ascending: false }).order("created_at", { ascending: false }).limit(500);
    if (cat) query = query.eq("category_id", cat);
    const rows = unwrap(await query) as Row[];
    return { cats, rows };
  }, [ws.id, from, to, cat]);

  const catName = useMemo(() => new Map((q.data?.cats ?? []).map((c) => [c.id, c.name])), [q.data]);
  const valid = (q.data?.rows ?? []).filter((r) => !r.voided_at);
  const rows = (q.data?.rows ?? []).filter((r) => showVoided || !r.voided_at);
  const total = valid.reduce((s, r) => s + Number(r.amount), 0);
  const cash = valid.filter((r) => r.method === "efectivo").reduce((s, r) => s + Number(r.amount), 0);
  const byCat = useMemo(() => {
    const m = new Map<string, number>();
    valid.forEach((r) => m.set(r.category_id, (m.get(r.category_id) ?? 0) + Number(r.amount)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [valid]);
  const cajaAbierta = status.summary?.caja.estado === "abierta" && !status.summary?.caja_anterior_sin_cerrar;

  async function confirmVoid() {
    if (!voiding) return;
    if (reason.trim().length < 3) return setError("Indicá el motivo.");
    setBusy(true);
    setError(null);
    const { error } = await sb.rpc("void_expense", { p_workspace_id: ws.id, p_expense_id: voiding.id, p_reason: reason });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setVoiding(null);
    setReason("");
    setMsg("Gasto anulado. Queda tachado en el historial y compensado en la caja de hoy.");
    q.reload();
    status.reload();
  }

  return (
    <>
      <PageHeader
        title="Gastos"
        subtitle="Solo gastos ya pagados. Los pagados en efectivo salen de la caja; los demás no tocan el efectivo."
        actions={
          <>
            <Button variant="secondary" disabled={rows.length === 0} onClick={() => downloadXlsx(`gastos_${from}_${to}.xlsx`, [{
              name: "Gastos",
              header: ["Fecha", "Concepto", "Categoría", "Proveedor", "Medio de pago", "Importe", "Estado", "Observaciones"],
              rows: [
                ...rows.map((r) => [formatDate(r.spent_on), r.concept, catName.get(r.category_id) ?? "", r.supplier ?? "", METHOD_LABEL[r.method] ?? r.method, Number(r.amount), r.voided_at ? `Anulado: ${r.void_reason}` : "Vigente", r.notes ?? ""]),
                [],
                ["", "TOTAL (sin anulados)", "", "", "", total, "", ""],
                ["", "Pagado en efectivo", "", "", "", cash, "", ""],
              ],
              widths: [12, 34, 20, 20, 16, 14, 26, 30],
              money: [5],
            }, {
              name: "Por categoría",
              header: ["Categoría", "Importe", "% del total"],
              rows: byCat.map(([id, amount]) => [catName.get(id) ?? "", amount, total ? Math.round((amount / total) * 1000) / 10 : 0]),
              widths: [28, 16, 12],
              money: [1],
            }])}>
              Descargar Excel
            </Button>
            <Button onClick={() => setNewOpen(true)} disabled={!cajaAbierta}>Nuevo gasto</Button>
          </>
        }
      />
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {msg && <Alert tone="ok" className="mb-3">{msg}</Alert>}
      {!cajaAbierta && status.summary && <Alert tone="warn" className="mb-3">Para registrar o anular gastos la caja del día tiene que estar abierta. <Link href="/caja" className="underline">Ir a caja</Link></Alert>}

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="Desde"><Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-auto" /></Field>
        <Field label="Hasta"><Input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className="w-auto" /></Field>
        <Field label="Categoría">
          <Select value={cat} onChange={(e) => setCat(e.target.value)} className="w-auto">
            <option value="">Todas</option>
            {(q.data?.cats ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Button variant="secondary" onClick={() => { setFrom(today); setTo(today); }}>Hoy</Button>
        <Button variant="secondary" onClick={() => { setFrom(addDays(today, -6)); setTo(today); }}>7 días</Button>
        <Button variant="secondary" onClick={() => { setFrom(today.slice(0, 8) + "01"); setTo(today); }}>Este mes</Button>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} /> Ver anulados</label>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Total del período" value={formatMoney(total)} tone="danger" />
        <Kpi label="Pagado en efectivo" value={formatMoney(cash)} />
        <Kpi label="Otros medios" value={formatMoney(total - cash)} />
        <Kpi label="Cantidad" value={String(valid.length)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title="Detalle">
          {q.loading && !q.data ? <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando…</div>
            : rows.length === 0 ? <EmptyState>No hay gastos en el período.</EmptyState> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-xs text-muted">
                    <th className="border-r border-line px-2 py-1.5 font-semibold">Fecha</th>
                    <th className="border-r border-line px-2 py-1.5 font-semibold">Concepto</th>
                    <th className="border-r border-line px-2 py-1.5 font-semibold">Categoría</th>
                    <th className="border-r border-line px-2 py-1.5 font-semibold">Proveedor</th>
                    <th className="border-r border-line px-2 py-1.5 font-semibold">Medio</th>
                    <th className="border-r border-line px-2 py-1.5 text-right font-semibold">Importe</th>
                    <th className="px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={cx("border-b border-line", r.voided_at && "text-muted line-through")} title={r.voided_at ? `Anulado: ${r.void_reason}` : r.notes ?? undefined}>
                      <td className="border-r border-line px-2 py-1.5 tabular">{formatDate(r.spent_on)}</td>
                      <td className="border-r border-line px-2 py-1.5 font-medium">{r.concept}</td>
                      <td className="border-r border-line px-2 py-1.5">{catName.get(r.category_id)}</td>
                      <td className="border-r border-line px-2 py-1.5">{r.supplier ?? ""}</td>
                      <td className="border-r border-line px-2 py-1.5">{METHOD_LABEL[r.method] ?? r.method}</td>
                      <td className="border-r border-line px-2 py-1.5 text-right tabular font-semibold">{formatMoney(r.amount)}</td>
                      <td className="px-2 py-1.5 text-right">
                        {isAdmin && !r.voided_at && cajaAbierta && <button className="text-xs text-danger hover:underline" onClick={() => { setError(null); setVoiding(r); }}>Anular</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-surface-2 font-semibold">
                    <td className="px-2 py-1.5" colSpan={5}>Total (sin anulados)</td>
                    <td className="border-r border-line px-2 py-1.5 text-right tabular">{formatMoney(total)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
        <Card title="Por categoría">
          {byCat.length === 0 ? <EmptyState>Sin datos.</EmptyState> : (
            <ul className="flex flex-col gap-2 text-sm">
              {byCat.map(([id, amount]) => (
                <li key={id}>
                  <div className="flex justify-between"><span>{catName.get(id)}</span><span className="tabular font-medium">{formatMoney(amount)}</span></div>
                  <div className="mt-1 h-2 rounded-full bg-surface-2"><div className="h-2 rounded-full bg-danger/70" style={{ width: `${total ? (amount / total) * 100 : 0}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <ExpenseModal open={newOpen} categories={q.data?.cats ?? []} today={today} onClose={() => setNewOpen(false)}
        onDone={() => { setNewOpen(false); setMsg("Gasto registrado."); q.reload(); status.reload(); }} />
      <ConfirmDialog
        open={voiding !== null}
        title="Anular gasto"
        confirmLabel="Anular gasto"
        danger
        busy={busy}
        onCancel={() => { setVoiding(null); setReason(""); }}
        onConfirm={confirmVoid}
        message={
          <div className="flex flex-col gap-3">
            <p>Se registra una anulación de <strong className="text-fg">{formatMoney(voiding?.amount)}</strong> ({voiding?.concept}). El gasto no se borra: queda tachado y la caja de hoy lo compensa.</p>
            <TextField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} />
            {error && <Alert tone="danger">{error}</Alert>}
          </div>
        }
      />
    </>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={cx("tabular mt-1 text-xl font-bold", tone === "danger" && "text-danger")}>{value}</div>
    </div>
  );
}
