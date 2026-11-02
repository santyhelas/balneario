"use client";
import { useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatMoney, parseMoney } from "@/lib/format";
import { Alert, Button, Modal, Textarea, TextField, Field } from "@/components/ui";

export type CashSummary = {
  session_id: string;
  business_date: string;
  opening_cash: number;
  opened_at: string;
  por_medio: Record<string, { entradas: number; salidas: number }>;
  efectivo_esperado: number;
  closed_at: string | null;
  counted_cash: number | null;
  difference: number | null;
  close_notes: string | null;
  version: number;
};

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
          <p className="text-xs text-muted">Una vez cerrada, la caja no se puede reabrir ni modificar.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
            <Button type="submit" loading={busy}>Confirmar cierre</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
