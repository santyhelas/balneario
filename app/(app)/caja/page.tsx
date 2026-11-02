"use client";
import { useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { newKey, unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatDateTime, formatMoney, formatTime, parseMoney, todayISO } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Button, Card, ConfirmDialog, EmptyState, Field, Input, Modal, Select, Spinner, Textarea, TextField } from "@/components/ui";
import { CloseCashModal, OpenCashModal, type CashSummary } from "@/components/cash";

type Session = { id: string; business_date: string; opening_cash: number; closed_at: string | null; expected_cash: number | null; counted_cash: number | null; difference: number | null };
type Movement = { id: string; direction: "entrada" | "salida"; method: string; amount: number; category: string; concept: string; created_at: string; expense_id: string | null };
type Category = { id: string; name: string; active: boolean };
type ExpenseRow = { id: string; voided_at: string | null };

type PageData = {
  sessions: Session[];
  current: Session | null;
  summary: CashSummary | null;
  movements: Movement[];
  categories: Category[];
  expenses: Record<string, ExpenseRow>;
};

const METHOD: Record<string, string> = { efectivo: "Efectivo", transferencia: "Transferencia", tarjeta: "Tarjeta" };
const CATEGORY: Record<string, string> = {
  cobro: "Cobro",
  devolucion: "Devolución",
  anulacion_cobro: "Anulación de cobro",
  anulacion_devolucion: "Anulación de devolución",
  gasto: "Gasto",
  anulacion_gasto: "Anulación de gasto",
  otro_ingreso: "Otro ingreso",
};

export default function CajaPage() {
  const { ws, isAdmin } = useWorkspace();
  const sb = getSupabase();
  const today = todayISO(ws.timezone);

  const { data, error, loading, reload, stale, updatedAt } = useLoader<PageData>(async () => {
    const sessions = unwrap(
      await sb.from("cash_sessions").select("id, business_date, opening_cash, closed_at, expected_cash, counted_cash, difference")
        .eq("workspace_id", ws.id).order("business_date", { ascending: false }).limit(30),
    ) as Session[];
    const current = sessions.find((s) => !s.closed_at) ?? sessions.find((s) => s.business_date === today) ?? null;
    let summary: CashSummary | null = null;
    let movements: Movement[] = [];
    let expenses: Record<string, ExpenseRow> = {};
    if (current) {
      summary = unwrap(await sb.rpc("cash_session_summary", { p_session_id: current.id })) as CashSummary;
      movements = unwrap(
        await sb.from("cash_movements").select("id, direction, method, amount, category, concept, created_at, expense_id")
          .eq("cash_session_id", current.id).order("created_at", { ascending: false }),
      ) as Movement[];
      const ids = movements.map((m) => m.expense_id).filter((x): x is string => !!x);
      if (ids.length) {
        const rows = unwrap(await sb.from("expenses").select("id, voided_at").in("id", ids)) as ExpenseRow[];
        expenses = Object.fromEntries(rows.map((r) => [r.id, r]));
      }
    }
    const categories = unwrap(
      await sb.from("expense_categories").select("id, name, active").eq("workspace_id", ws.id).order("name"),
    ) as Category[];
    return { sessions, current, summary, movements, categories, expenses };
  }, [ws.id, today]);

  const [openCash, setOpenCash] = useState(false);
  const [closeCash, setCloseCash] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [incomeOpen, setIncomeOpen] = useState(false);
  const [voiding, setVoiding] = useState<Movement | null>(null);

  if (!data && loading) return <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando caja…</div>;

  const current = data?.current ?? null;
  const summary = data?.summary ?? null;
  const isOpen = current !== null && !current.closed_at;
  const isPrevious = isOpen && current!.business_date !== today;
  const canOperate = isOpen && !isPrevious;

  return (
    <>
      <PageHeader
        title="Caja diaria"
        subtitle={current ? `Caja del ${formatDate(current.business_date)}` : `Hoy ${formatDate(today)}`}
        actions={
          <>
            {canOperate && <Button variant="secondary" onClick={() => setIncomeOpen(true)}>Otro ingreso</Button>}
            {canOperate && <Button variant="secondary" onClick={() => setExpenseOpen(true)}>Registrar salida / gasto</Button>}
            {isOpen && <Button onClick={() => setCloseCash(true)}>Cerrar caja</Button>}
            {!current && <Button onClick={() => setOpenCash(true)}>Abrir caja</Button>}
          </>
        }
      />
      <SyncNotice error={error} stale={stale} updatedAt={updatedAt} onRetry={reload} />

      {isPrevious && (
        <Alert tone="danger" className="mb-4">
          Esta caja es del <strong>{formatDate(current!.business_date)}</strong> y quedó sin cerrar. Cerrala para poder abrir la de hoy.
        </Alert>
      )}
      {current?.closed_at && (
        <Alert tone="info" className="mb-4">La caja de hoy ya está cerrada. Mañana se abre una nueva.</Alert>
      )}
      {!current && (
        <Alert tone="warn" className="mb-4">La caja de hoy no está abierta. Abrila para poder registrar cobros y gastos.</Alert>
      )}

      {summary && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Efectivo" className="lg:col-span-1">
            <dl className="flex flex-col gap-1.5 text-sm">
              <Row label="Apertura" value={formatMoney(summary.opening_cash)} />
              <Row label="+ Entradas en efectivo" value={formatMoney(summary.por_medio.efectivo.entradas)} />
              <Row label="− Salidas en efectivo" value={formatMoney(summary.por_medio.efectivo.salidas)} />
              <div className="my-1 border-t border-line" />
              <Row label="Efectivo esperado" value={formatMoney(summary.efectivo_esperado)} strong />
              {summary.closed_at && (
                <>
                  <Row label="Efectivo contado" value={formatMoney(summary.counted_cash)} />
                  <Row label="Diferencia" value={formatMoney(summary.difference)} strong tone={Number(summary.difference) === 0 ? undefined : "warn"} />
                  {summary.close_notes && <p className="text-xs text-muted">“{summary.close_notes}”</p>}
                  <p className="text-xs text-muted">Cerrada {formatDateTime(summary.closed_at, ws.timezone)}</p>
                </>
              )}
            </dl>
          </Card>
          <Card title="Otros medios (no son efectivo en caja)" className="lg:col-span-2">
            <div className="grid grid-cols-2 gap-3 text-sm">
              {(["transferencia", "tarjeta"] as const).map((m) => (
                <div key={m} className="rounded-lg bg-surface-2 p-3">
                  <div className="font-medium">{METHOD[m]}</div>
                  <div className="tabular mt-1 text-muted">Entradas {formatMoney(summary.por_medio[m].entradas)}</div>
                  <div className="tabular text-muted">Salidas {formatMoney(summary.por_medio[m].salidas)}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Movimientos" className="lg:col-span-3">
            {data!.movements.length === 0 ? (
              <EmptyState>Todavía no hay movimientos en esta caja.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr><th className="py-2 pr-3">Hora</th><th className="pr-3">Tipo</th><th className="pr-3">Concepto</th><th className="pr-3">Medio</th><th className="pr-3 text-right">Importe</th><th /></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data!.movements.map((m) => {
                      const voided = m.category === "gasto" && m.expense_id && data!.expenses[m.expense_id]?.voided_at;
                      return (
                        <tr key={m.id} className={voided ? "text-muted line-through" : ""}>
                          <td className="py-2 pr-3 tabular">{formatTime(m.created_at, ws.timezone)}</td>
                          <td className="pr-3">{CATEGORY[m.category] ?? m.category}</td>
                          <td className="pr-3">{m.concept}</td>
                          <td className="pr-3">{METHOD[m.method]}</td>
                          <td className={`pr-3 text-right tabular font-medium ${m.direction === "entrada" ? "text-ok" : "text-danger"}`}>
                            {m.direction === "entrada" ? "+" : "−"} {formatMoney(m.amount)}
                          </td>
                          <td className="text-right">
                            {isAdmin && canOperate && m.category === "gasto" && !voided && (
                              <button className="text-xs text-danger hover:underline" onClick={() => setVoiding(m)}>Anular</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {data && data.sessions.filter((s) => s.closed_at).length > 0 && (
        <Card title="Cierres anteriores" className="mt-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr><th className="py-2 pr-3">Fecha</th><th className="pr-3 text-right">Apertura</th><th className="pr-3 text-right">Esperado</th><th className="pr-3 text-right">Contado</th><th className="text-right">Diferencia</th></tr>
              </thead>
              <tbody className="divide-y divide-line tabular">
                {data.sessions.filter((s) => s.closed_at).map((s) => (
                  <tr key={s.id}>
                    <td className="py-2 pr-3">{formatDate(s.business_date)}</td>
                    <td className="pr-3 text-right">{formatMoney(s.opening_cash)}</td>
                    <td className="pr-3 text-right">{formatMoney(s.expected_cash)}</td>
                    <td className="pr-3 text-right">{formatMoney(s.counted_cash)}</td>
                    <td className={`text-right ${Number(s.difference) !== 0 ? "text-warn font-medium" : ""}`}>{formatMoney(s.difference)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <OpenCashModal open={openCash} workspaceId={ws.id} onClose={() => setOpenCash(false)} onDone={() => { setOpenCash(false); reload(); }} />
      <CloseCashModal open={closeCash} summary={summary} onClose={() => setCloseCash(false)} onDone={() => { setCloseCash(false); reload(); }} />
      <ExpenseModal open={expenseOpen} categories={data?.categories ?? []} today={today} onClose={() => setExpenseOpen(false)} onDone={() => { setExpenseOpen(false); reload(); }} />
      <IncomeModal open={incomeOpen} onClose={() => setIncomeOpen(false)} onDone={() => { setIncomeOpen(false); reload(); }} />
      <VoidExpense movement={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); reload(); }} />
    </>
  );
}

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: "warn" }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={`tabular ${strong ? "font-semibold" : ""} ${tone === "warn" ? "text-warn" : ""}`}>{value}</dd>
    </div>
  );
}

function MethodSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Medio de pago">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="efectivo">Efectivo</option>
        <option value="transferencia">Transferencia</option>
        <option value="tarjeta">Tarjeta</option>
      </Select>
    </Field>
  );
}

function ExpenseModal({ open, categories, today, onClose, onDone }: { open: boolean; categories: Category[]; today: string; onClose: () => void; onDone: () => void }) {
  const { ws } = useWorkspace();
  const [amount, setAmount] = useState("");
  const [concept, setConcept] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [method, setMethod] = useState("efectivo");
  const [supplier, setSupplier] = useState("");
  const [notes, setNotes] = useState("");
  const [spentOn, setSpentOn] = useState(today);
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setAmount(""); setConcept(""); setCategoryId(""); setMethod("efectivo"); setSupplier(""); setNotes(""); setSpentOn(today); setKey(newKey()); setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = parseMoney(amount);
    if (!value || value <= 0) return setError("Ingresá un importe válido.");
    if (!categoryId) return setError("Elegí una categoría.");
    setBusy(true);
    setError(null);
    // La misma clave en cada reintento: si la primera vez sí se guardó, no se duplica.
    const { error } = await getSupabase().rpc("register_expense", {
      p_workspace_id: ws.id, p_idempotency_key: key, p_amount: value, p_spent_on: spentOn, p_concept: concept,
      p_category_id: categoryId, p_method: method, p_supplier: supplier || null, p_notes: notes || null,
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    reset();
    onDone();
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} title="Registrar salida / gasto" busy={busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-xs text-muted">Solo gastos ya pagados. Si se pagó con transferencia o tarjeta, no se descuenta del efectivo de la caja.</p>
        <TextField label="Importe" inputMode="decimal" placeholder="Ej: 30.000" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        <TextField label="Concepto" value={concept} onChange={(e) => setConcept(e.target.value)} required minLength={2} maxLength={200} placeholder="Ej: Bolsas de residuo" />
        <Field label="Categoría">
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
            <option value="">Elegí…</option>
            {categories.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <MethodSelect value={method} onChange={setMethod} />
        <Field label="Fecha del gasto">
          <Input type="date" value={spentOn} max={today} onChange={(e) => setSpentOn(e.target.value)} required />
        </Field>
        <TextField label="Proveedor (opcional)" value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={120} />
        <Field label="Observaciones (opcional)"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} /></Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => { reset(); onClose(); }} disabled={busy}>Cancelar</Button>
          <Button type="submit" loading={busy}>Guardar gasto</Button>
        </div>
      </form>
    </Modal>
  );
}

function IncomeModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { ws } = useWorkspace();
  const [amount, setAmount] = useState("");
  const [concept, setConcept] = useState("");
  const [method, setMethod] = useState("efectivo");
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() { setAmount(""); setConcept(""); setMethod("efectivo"); setKey(newKey()); setError(null); }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = parseMoney(amount);
    if (!value || value <= 0) return setError("Ingresá un importe válido.");
    setBusy(true);
    setError(null);
    const { error } = await getSupabase().rpc("register_other_income", {
      p_workspace_id: ws.id, p_idempotency_key: key, p_amount: value, p_method: method, p_concept: concept,
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    reset();
    onDone();
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} title="Registrar otro ingreso" busy={busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-xs text-muted">Para ingresos que no son pagos de una reserva. Los cobros de reservas se registran desde la reserva.</p>
        <TextField label="Importe" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        <TextField label="Concepto" value={concept} onChange={(e) => setConcept(e.target.value)} required minLength={3} maxLength={200} />
        <MethodSelect value={method} onChange={setMethod} />
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => { reset(); onClose(); }} disabled={busy}>Cancelar</Button>
          <Button type="submit" loading={busy}>Guardar ingreso</Button>
        </div>
      </form>
    </Modal>
  );
}

function VoidExpense({ movement, onClose, onDone }: { movement: Movement | null; onClose: () => void; onDone: () => void }) {
  const { ws } = useWorkspace();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!movement?.expense_id) return;
    if (reason.trim().length < 3) return setError("Indicá el motivo.");
    setBusy(true);
    setError(null);
    const { error } = await getSupabase().rpc("void_expense", { p_workspace_id: ws.id, p_expense_id: movement.expense_id, p_reason: reason });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setReason("");
    onDone();
  }

  return (
    <ConfirmDialog
      open={movement !== null}
      title="Anular gasto"
      confirmLabel="Anular gasto"
      danger
      busy={busy}
      onCancel={() => { setReason(""); setError(null); onClose(); }}
      onConfirm={confirm}
      message={
        <div className="flex flex-col gap-3">
          <p>
            Se registra una anulación de <strong className="text-fg">{formatMoney(movement?.amount)}</strong> ({movement?.concept}). El gasto original no se borra:
            queda tachado y la caja lo compensa.
          </p>
          <TextField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} required />
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      }
    />
  );
}
