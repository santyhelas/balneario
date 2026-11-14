"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { newKey, unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatDateTime, formatMoney, formatTime, parseMoney, todayISO } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { useStatus } from "@/components/status";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Button, Card, ConfirmDialog, EmptyState, Field, Input, Modal, Select, Spinner, Textarea, TextField, cx } from "@/components/ui";
import { CashSeasonSwitch, CloseCashModal, ExpenseModal, IncomeModal, OpenCashModal, type CashSummary } from "@/components/cash";
import { METHOD_LABEL, PAYMENT_METHODS } from "@/lib/methods";

type Session = { id: string; business_date: string; opening_cash: number; closed_at: string | null; expected_cash: number | null; counted_cash: number | null; difference: number | null; version: number };
type Movement = { id: string; direction: "entrada" | "salida"; method: string; amount: number; category: string; concept: string; created_at: string; expense_id: string | null; voids_movement_id?: string | null };
type Category = { id: string; name: string; active: boolean };
type ExpenseRow = { id: string; voided_at: string | null };

type PageData = {
  sessions: Session[];
  current: Session | null;
  summary: CashSummary | null;
  movements: Movement[];
  categories: Category[];
  expenses: Record<string, ExpenseRow>;
  /** Límite de efectivo en caja (Configuración). undefined: falta la actualización 0033. */
  cashLimit: number | null | undefined;
};

const METHOD = METHOD_LABEL;
const CATEGORY: Record<string, string> = {
  cobro: "Cobro",
  devolucion: "Devolución",
  anulacion_cobro: "Anulación de cobro",
  anulacion_devolucion: "Anulación de devolución",
  gasto: "Gasto",
  anulacion_gasto: "Anulación de gasto",
  otro_ingreso: "Otro ingreso",
  deposito: "Depósito",
  anulacion_deposito: "Anulación de depósito",
};

export default function CajaPage() {
  const { ws, isAdmin } = useWorkspace();
  const status = useStatus();
  const sb = getSupabase();
  const router = useRouter();
  const today = todayISO(ws.timezone);

  const { data, error, loading, reload, stale, updatedAt } = useLoader<PageData>(async () => {
    const sessions = unwrap(
      await sb.from("cash_sessions").select("id, business_date, opening_cash, closed_at, expected_cash, counted_cash, difference, version")
        .eq("workspace_id", ws.id).order("business_date", { ascending: false }).limit(30),
    ) as Session[];
    const current = sessions.find((s) => !s.closed_at) ?? sessions.find((s) => s.business_date === today) ?? null;
    let summary: CashSummary | null = null;
    let movements: Movement[] = [];
    let expenses: Record<string, ExpenseRow> = {};
    if (current) {
      summary = unwrap(await sb.rpc("cash_session_summary", { p_session_id: current.id })) as CashSummary;
      let mv = await sb.from("cash_movements").select("id, direction, method, amount, category, concept, created_at, expense_id, voids_movement_id")
        .eq("cash_session_id", current.id).order("created_at", { ascending: false });
      if (mv.error?.code === "42703") {
        mv = (await sb.from("cash_movements").select("id, direction, method, amount, category, concept, created_at, expense_id")
          .eq("cash_session_id", current.id).order("created_at", { ascending: false })) as typeof mv;
      }
      movements = unwrap(mv) as Movement[];
      const ids = movements.map((m) => m.expense_id).filter((x): x is string => !!x);
      if (ids.length) {
        const rows = unwrap(await sb.from("expenses").select("id, voided_at").in("id", ids)) as ExpenseRow[];
        expenses = Object.fromEntries(rows.map((r) => [r.id, r]));
      }
    }
    const categories = unwrap(
      await sb.from("expense_categories").select("id, name, active").eq("workspace_id", ws.id).order("name"),
    ) as Category[];
    const lim = await sb.from("workspaces").select("cash_limit").eq("id", ws.id).single();
    const cashLimit = lim.error ? undefined : ((lim.data as { cash_limit: number | null }).cash_limit ?? null);
    return { sessions, current, summary, movements, categories, expenses, cashLimit };
  }, [ws.id, today]);

  const [openCash, setOpenCash] = useState(false);
  const [closeCash, setCloseCash] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [incomeOpen, setIncomeOpen] = useState(false);
  const [voiding, setVoiding] = useState<Movement | null>(null);
  const [depositOpen, setDepositOpen] = useState(false);
  const [voidingDeposit, setVoidingDeposit] = useState<Movement | null>(null);
  const [reopening, setReopening] = useState(false);

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
            {current && <Button variant="secondary" onClick={() => router.push(`/caja/tarjetas?sesion=${current.id}`)}>Cierre de tarjetas</Button>}
            {canOperate && <Button variant="secondary" onClick={() => setIncomeOpen(true)}>Otro ingreso</Button>}
            {canOperate && <Button variant="secondary" onClick={() => setExpenseOpen(true)}>Registrar salida / gasto</Button>}
            {canOperate && data?.cashLimit !== undefined && <Button variant="secondary" onClick={() => setDepositOpen(true)}>Depósito de efectivo</Button>}
            {isOpen && <Button onClick={() => setCloseCash(true)}>Cerrar caja</Button>}
            {!current && <Button onClick={() => setOpenCash(true)}>Abrir caja</Button>}
          </>
        }
      />
      <SyncNotice error={error} stale={stale} updatedAt={updatedAt} onRetry={reload} />
      {isAdmin && !isOpen && (
        <div className={cx("mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 text-sm", status.cashPrompts ? "border-line" : "border-warn/40 bg-warn-soft")}>
          <span>
            {status.cashPrompts
              ? <>¿Fuera de temporada? Apagá la caja y deja de pedirse al entrar y de avisar «Caja sin abrir».</>
              : <><strong>La caja está apagada (fuera de temporada).</strong> No se pide abrirla ni se avisa. Si hace falta cobrar en efectivo, podés abrirla igual con «Abrir caja».</>}
          </span>
          <CashSeasonSwitch workspaceId={ws.id} on={status.cashPrompts} onChanged={() => status.reload()} />
        </div>
      )}

      {isPrevious && (
        <Alert tone="danger" className="mb-4">
          Esta caja es del <strong>{formatDate(current!.business_date)}</strong> y quedó sin cerrar. Cerrala para poder abrir la de hoy.
        </Alert>
      )}
      {current?.closed_at && (
        <Alert tone="info" className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <span>La caja de hoy ya está cerrada. Mañana se abre una nueva.{current.business_date === today && !isAdmin ? " Si se cerró por error, pedile al propietario que la reabra." : ""}</span>
          {current.business_date === today && isAdmin && <Button variant="secondary" onClick={() => setReopening(true)}>Reabrir caja</Button>}
        </Alert>
      )}
      {!current && (
        <Alert tone="warn" className="mb-4">La caja de hoy no está abierta. Abrila para poder registrar cobros y gastos.</Alert>
      )}

      {summary && canOperate && data?.cashLimit && Number(summary.efectivo_esperado) > Number(data.cashLimit) && (
        <Alert tone="warn" className="mb-4">
          <strong>Hay mucho efectivo en la caja:</strong> {formatMoney(summary.efectivo_esperado)}, más que el límite de {formatMoney(data.cashLimit)}.
          Conviene hacer un depósito.{" "}
          <button className="font-semibold underline" onClick={() => setDepositOpen(true)}>Registrar depósito</button>
        </Alert>
      )}

      {summary && (
        <div data-tour="caja" className="grid gap-4 lg:grid-cols-3">
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
          {summary.dolares && (Number(summary.dolares.entradas) > 0 || Number(summary.dolares.salidas) > 0) && (
            <Card title="Dólares en caja" className="lg:col-span-3">
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                <Row label="Recibidos" value={`US$ ${Number(summary.dolares.entradas).toLocaleString("es-AR")}`} />
                <Row label="Salidas / anulaciones" value={`US$ ${Number(summary.dolares.salidas).toLocaleString("es-AR")}`} />
                <Row label="Dólares que tiene que haber" value={`US$ ${Number(summary.dolares.esperado).toLocaleString("es-AR")}`} strong />
              </dl>
              <p className="mt-2 text-xs text-muted">
                Equivalen a {formatMoney(Number(summary.por_medio.dolares?.entradas ?? 0) - Number(summary.por_medio.dolares?.salidas ?? 0))} según la cotización de cada cobro.
                Se cuentan aparte: no se suman al efectivo en pesos.
              </p>
            </Card>
          )}
          <Card title="Otros medios (no son efectivo en caja)" className="lg:col-span-2">
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              {Object.keys(summary.por_medio).filter((m) => m !== "efectivo" && m !== "dolares" && (m !== "tarjeta" || summary.por_medio[m].entradas > 0 || summary.por_medio[m].salidas > 0)).map((m) => (
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
                      const voided = (m.category === "gasto" && m.expense_id && data!.expenses[m.expense_id]?.voided_at)
                        || (m.category === "deposito" && data!.movements.some((x) => x.voids_movement_id === m.id));
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
                            {isAdmin && canOperate && m.category === "deposito" && !voided && (
                              <button className="text-xs text-danger hover:underline" onClick={() => setVoidingDeposit(m)}>Anular</button>
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
                <tr><th className="py-2 pr-3">Fecha</th><th className="pr-3 text-right">Apertura</th><th className="pr-3 text-right">Esperado</th><th className="pr-3 text-right">Contado</th><th className="pr-3 text-right">Diferencia</th><th /></tr>
              </thead>
              <tbody className="divide-y divide-line tabular">
                {data.sessions.filter((s) => s.closed_at).map((s) => (
                  <tr key={s.id}>
                    <td className="py-2 pr-3">{formatDate(s.business_date)}</td>
                    <td className="pr-3 text-right">{formatMoney(s.opening_cash)}</td>
                    <td className="pr-3 text-right">{formatMoney(s.expected_cash)}</td>
                    <td className="pr-3 text-right">{formatMoney(s.counted_cash)}</td>
                    <td className={`pr-3 text-right ${Number(s.difference) !== 0 ? "text-warn font-medium" : ""}`}>{formatMoney(s.difference)}</td>
                    <td className="text-right"><Link href={`/caja/tarjetas?sesion=${s.id}`} className="text-xs text-accent hover:underline">Tarjetas</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <OpenCashModal open={openCash} workspaceId={ws.id} onClose={() => setOpenCash(false)} onDone={() => { setOpenCash(false); reload(); status.reload(); }} />
      <CloseCashModal open={closeCash} summary={summary} onClose={() => setCloseCash(false)} onDone={() => { setCloseCash(false); reload(); status.reload(); }} />
      <ExpenseModal open={expenseOpen} categories={data?.categories ?? []} today={today} onClose={() => setExpenseOpen(false)} onDone={() => { setExpenseOpen(false); reload(); status.reload(); }} />
      <IncomeModal open={incomeOpen} onClose={() => setIncomeOpen(false)} onDone={() => { setIncomeOpen(false); reload(); status.reload(); }} />
      {depositOpen && summary && (
        <DepositModal expected={Number(summary.efectivo_esperado)} limit={data?.cashLimit ?? null}
          onClose={() => setDepositOpen(false)} onDone={() => { setDepositOpen(false); reload(); status.reload(); }} />
      )}
      <VoidDeposit movement={voidingDeposit} onClose={() => setVoidingDeposit(null)} onDone={() => { setVoidingDeposit(null); reload(); status.reload(); }} />
      {reopening && current?.closed_at && (
        <ReopenCash session={current} onClose={() => setReopening(false)} onDone={() => { setReopening(false); reload(); status.reload(); }} />
      )}
      <VoidExpense movement={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); reload(); status.reload(); }} />
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

/** Reabrir la caja de hoy si se cerró por error: el cierre anterior queda guardado y en el historial. */
function ReopenCash({ session, onClose, onDone }: { session: Session; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    if (reason.trim().length < 3) return setError("Escribí el motivo.");
    setBusy(true);
    setError(null);
    const { error: e } = await getSupabase().rpc("reopen_cash_session", { p_session_id: session.id, p_expected_version: session.version, p_reason: reason.trim() });
    setBusy(false);
    if (e) return setError(e.code === "PGRST202" ? "Para reabrir la caja hay que aplicar la actualización 0041 de la base de datos." : friendlyError(e));
    onDone();
  }
  return (
    <ConfirmDialog
      open
      title="Reabrir la caja de hoy"
      confirmLabel="Reabrir caja"
      busy={busy}
      onCancel={onClose}
      onConfirm={confirm}
      message={
        <div className="flex flex-col gap-3">
          <p>La caja vuelve a quedar abierta para seguir cobrando y cargando gastos. Al final del día la cerrás de nuevo, contando la plata.</p>
          <p className="text-xs text-muted">
            El cierre anterior (contado {formatMoney(session.counted_cash)}, diferencia {formatMoney(session.difference)}) no se borra: queda guardado con el motivo, quién la reabrió y a qué hora.
          </p>
          <TextField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={300} placeholder="Ej: la cerré por error, faltaba cobrar" />
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      }
    />
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

/** Depósito: sacar efectivo de la caja para llevarlo al banco (no es un gasto). */
function DepositModal({ expected, limit, onClose, onDone }: { expected: number; limit: number | null; onClose: () => void; onDone: () => void }) {
  const { ws } = useWorkspace();
  const [amount, setAmount] = useState(limit && expected > limit ? String(Math.floor(expected - limit)) : "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(newKey);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const a = parseMoney(amount);
    if (a == null || a <= 0) return setError("Poné el importe que depositás.");
    if (a > expected) return setError(`No puede ser más que el efectivo de la caja (${formatMoney(expected)}).`);
    setBusy(true);
    setError(null);
    const { error: err } = await getSupabase().rpc("register_cash_deposit", { p_workspace_id: ws.id, p_idempotency_key: key, p_amount: a, p_note: note.trim() || null });
    setBusy(false);
    if (err) return setError(friendlyError(err));
    onDone();
  }
  return (
    <Modal open onClose={onClose} busy={busy} title="Depósito de efectivo"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button type="submit" form="deposit-form" loading={busy}>Registrar depósito</Button></>}>
      <form id="deposit-form" onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Sacás efectivo de la caja para llevarlo al banco o guardarlo aparte. Baja el efectivo esperado, pero <strong>no es un gasto</strong>: no aparece en los gastos ni en el resultado.
        </p>
        <p className="text-sm">Efectivo en caja ahora: <strong className="tabular">{formatMoney(expected)}</strong>{limit ? <> · límite {formatMoney(limit)}</> : null}</p>
        <TextField label="Importe" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus />
        <TextField label="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={150} placeholder="Ej: Banco Nación, cuenta del balneario" />
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Modal>
  );
}

function VoidDeposit({ movement, onClose, onDone }: { movement: Movement | null; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);
  async function confirm() {
    if (!movement) return;
    setBusy(true);
    setError(null);
    const { error: err } = await getSupabase().rpc("void_cash_deposit", { p_movement_id: movement.id, p_idempotency_key: key });
    setBusy(false);
    if (err) return setError(friendlyError(err));
    setKey(newKey());
    onDone();
  }
  return (
    <ConfirmDialog open={movement !== null} title="Anular depósito" confirmLabel="Anular depósito" danger busy={busy}
      onCancel={() => { setError(null); onClose(); }} onConfirm={confirm}
      message={<div className="flex flex-col gap-3"><p>El efectivo ({formatMoney(movement?.amount)}) vuelve a contarse en la caja. El depósito no se borra: queda tachado y se registra la anulación.</p>{error && <Alert tone="danger">{error}</Alert>}</div>} />
  );
}
