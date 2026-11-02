"use client";
import { useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { newKey } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatMoney, parseMoney } from "@/lib/format";
import { PAYMENT_METHODS } from "@/lib/methods";
import { useWorkspace } from "@/components/workspace";
import { Alert, Button, Field, Modal, Select, TextField } from "@/components/ui";

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => PromiseLike<{ error: unknown }>, onOk: () => void) {
    setBusy(true);
    setError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) return setError(friendlyError(error));
    onOk();
  }
  return { busy, error, setError, run };
}

/** Lo mínimo que necesita la ventana de cobro: la reserva y su saldo. */
export type PayTarget = { r: { id: string; number?: number }; balance: { due_amount: number } };

export function PaymentModal({ open, full, onClose, onDone }: { open: boolean; full: PayTarget; onClose: () => void; onDone: (t: string) => void }) {
  const { ws } = useWorkspace();
  const due = Number(full.balance.due_amount);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("efectivo");
  const [received, setReceived] = useState("");
  const [note, setNote] = useState("");
  const [key, setKey] = useState(newKey);
  const a = useAction();
  const value = amount === "" ? due : parseMoney(amount);
  const rec = parseMoney(received);
  const change = method === "efectivo" && rec !== null && value !== null ? rec - value : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!value || value <= 0) return a.setError("Ingresá un importe válido.");
    if (value > due) return a.setError(`El saldo es ${formatMoney(due)}.`);
    a.run(
      () => getSupabase().rpc("register_payment", { p_workspace_id: ws.id, p_reservation_id: full.r.id, p_amount: value, p_method: method, p_idempotency_key: key, p_note: note || null }),
      () => { setKey(newKey()); setAmount(""); setReceived(""); setNote(""); onDone(`Pago de ${formatMoney(value)} registrado.`); },
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={`Registrar pago · saldo ${formatMoney(due)}`} busy={a.busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <TextField label="Importe" inputMode="decimal" placeholder={String(due)} value={amount} onChange={(e) => setAmount(e.target.value)} hint="Vacío = cancela todo el saldo." />
        <Field label="Medio de pago">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>{PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select>
        </Field>
        {method === "efectivo" && (
          <>
            <TextField label="Recibe (para calcular el vuelto)" inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} />
            {change !== null && <Alert tone={change < 0 ? "danger" : "info"}>{change < 0 ? `Faltan ${formatMoney(-change)}` : `Vuelto: ${formatMoney(change)}`}</Alert>}
          </>
        )}
        <TextField label="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        {a.error && <Alert tone="danger">{a.error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={a.busy}>Cancelar</Button>
          <Button type="submit" loading={a.busy}>Registrar {value ? formatMoney(value) : ""}</Button>
        </div>
      </form>
    </Modal>
  );
}

