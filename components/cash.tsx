"use client";
import { useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatMoney, parseMoney } from "@/lib/format";
import { newKey } from "@/lib/data";
import { PAYMENT_METHODS } from "@/lib/methods";
import { useWorkspace } from "@/components/workspace";
import { Alert, Button, Field, Input, Modal, Select, Textarea, TextField } from "@/components/ui";

export type CashSummary = {
  session_id: string;
  business_date: string;
  opening_cash: number;
  opened_at: string;
  por_medio: Record<string, { entradas: number; salidas: number }>;
  efectivo_esperado: number;
  /** Dólares en efectivo (desde la actualización 0016): se cuentan aparte de los pesos. */
  dolares?: { entradas: number; salidas: number; esperado: number };
  closed_at: string | null;
  counted_cash: number | null;
  difference: number | null;
  close_notes: string | null;
  version: number;
};

export type ExpenseCategory = { id: string; name: string; active: boolean };

/** Apertura de caja: pide el efectivo inicial (no es un ingreso). */
export function OpenCashModal({ open, workspaceId, onClose, onDone }: { open: boolean; workspaceId: string; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = parseMoney(amount);
    if (value === null || value < 0) return setError("Ingresá el efectivo inicial (puede ser 0).");
    setBusy(true);
    setError(null);
    const { error } = await getSupabase().rpc("open_cash_session", { p_workspace_id: workspaceId, p_opening_cash: value, p_notes: notes || null });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setAmount("");
    setNotes("");
    onDone();
  }

  return (
    <Modal open={open} onClose={onClose} title="Abrir la caja de hoy" busy={busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <TextField
          label="Efectivo inicial en la caja"
          inputMode="decimal"
          placeholder="Ej: 50.000"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          hint="Es el dinero con el que arranca el día. No se cuenta como ingreso."
          required
        />
        <Field label="Observaciones (opcional)">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Ahora no</Button>
          <Button type="submit" loading={busy}>Abrir caja</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Cierre de caja: compara el efectivo contado con el esperado. Nunca toca los movimientos. */
export function CloseCashModal({ open, summary, onClose, onDone }: { open: boolean; summary: CashSummary | null; onClose: () => void; onDone: () => void }) {
  const [counted, setCounted] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const countedValue = parseMoney(counted);
  const diff = summary && countedValue !== null ? countedValue - Number(summary.efectivo_esperado) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!summary) return;
    if (countedValue === null || countedValue < 0) return setError("Ingresá el efectivo que contaste.");
    setBusy(true);
    setError(null);
    const { error } = await getSupabase().rpc("close_cash_session", {
      p_session_id: summary.session_id,
      p_counted_cash: countedValue,
      p_expected_version: summary.version,
      p_notes: notes || null,
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setCounted("");
    setNotes("");
    onDone();
  }

  return (
    <Modal open={open} onClose={onClose} title={summary ? `Cerrar caja del ${formatDate(summary.business_date)}` : "Cerrar caja"} busy={busy}>
      {summary && (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="rounded-lg bg-surface-2 p-3 text-sm">
            <div className="flex justify-between"><span className="text-muted">Efectivo esperado</span><strong className="tabular">{formatMoney(summary.efectivo_esperado)}</strong></div>
            {summary.dolares && Number(summary.dolares.esperado) !== 0 && (
              <p className="text-xs text-muted">Contá solo los pesos. Aparte tiene que haber <strong>US$ {Number(summary.dolares.esperado).toLocaleString("es-AR")}</strong> en dólares.</p>
            )}
            <p className="mt-1 text-xs text-muted">Apertura + cobros en efectivo − salidas en efectivo. Transferencias, tarjetas y Mercado Pago no se cuentan.</p>
          </div>
          <TextField label="Efectivo contado" inputMode="decimal" placeholder="Ej: 220.000" value={counted} onChange={(e) => setCounted(e.target.value)} required />
          {diff !== null && (
            <Alert tone={diff === 0 ? "ok" : "warn"}>
              Diferencia: <strong className="tabular">{formatMoney(diff)}</strong>
              {diff === 0 ? " — la caja cierra justa." : diff > 0 ? " — sobra dinero." : " — falta dinero."}
            </Alert>
          )}
          <Field label="Observaciones">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} placeholder={diff ? "Explicá la diferencia si la conocés" : ""} />
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <p className="text-xs text-muted">Los movimientos no se pueden modificar. Si la cerrás por error, el propietario o un administrador la puede reabrir hoy mismo (queda registrado).</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
            <Button type="submit" loading={busy}>Confirmar cierre</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function MethodSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Medio de pago">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </Select>
    </Field>
  );
}


export function ExpenseModal({ open, categories, today, onClose, onDone }: { open: boolean; categories: ExpenseCategory[]; today: string; onClose: () => void; onDone: () => void }) {
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


export function IncomeModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
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

