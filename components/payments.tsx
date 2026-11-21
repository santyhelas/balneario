"use client";
import { useEffect, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { newKey } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatMoney, parseMoney } from "@/lib/format";
import { COLLECT_METHODS } from "@/lib/methods";
import { featuresOf } from "@/lib/features";
import { DollarFields, type DollarValue } from "@/components/dollar";
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

/** Saldo pagando en efectivo cuando la reserva tiene precio en efectivo acordado (si no, null). */
export function useCashDue(reservationId: string, enabled: boolean, dep: unknown): number | null {
  const [v, setV] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    getSupabase().rpc("cash_due", { p_reservation_id: reservationId })
      .then(({ data, error }) => { if (alive) setV(!error && data != null ? Number(data) : null); });
    return () => { alive = false; };
  }, [reservationId, enabled, dep]);
  return v;
}

/** Lo mínimo que necesita la ventana de cobro: la reserva y su saldo. */
export type PayTarget = { r: { id: string; number?: number; group_id?: string | null }; balance: { due_amount: number } };

export function PaymentModal({ open, full, onClose, onDone }: { open: boolean; full: PayTarget; onClose: () => void; onDone: (t: string) => void }) {
  const { ws } = useWorkspace();
  const listDue = Number(full.balance.due_amount);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("efectivo");
  // Precio en efectivo acordado: en efectivo el saldo es el de lista menos la diferencia (lo calcula la base).
  const cashDue = useCashDue(full.r.id, open, listDue);
  const ownDue = method === "efectivo" && cashDue !== null ? cashDue : listDue;
  const [received, setReceived] = useState("");
  const [note, setNote] = useState("");
  const [key, setKey] = useState(newKey);
  const [usd, setUsd] = useState<DollarValue>({ usd: null, rate: null, ars: null });
  const a = useAction();
  // Reserva de grupo: se puede cobrar el saldo de todas las carpas del grupo en un solo cobro.
  const [allGroup, setAllGroup] = useState(false);
  const [groupInfo, setGroupInfo] = useState<{ due: number; reservas: number } | null>(null);
  useEffect(() => {
    if (!open || !full.r.group_id || method === "dolares") { setGroupInfo(null); return; }
    let alive = true;
    getSupabase().rpc("group_due", { p_group_id: full.r.group_id, p_method: method })
      .then(({ data, error }) => { if (alive) setGroupInfo(!error && data ? { due: Number(data.due), reservas: Number(data.reservas) } : null); });
    return () => { alive = false; };
  }, [open, full.r.group_id, method, listDue]);
  const groupMode = allGroup && groupInfo !== null && groupInfo.reservas > 1 && method !== "dolares";
  const due = groupMode ? groupInfo.due : ownDue;
  const value = amount === "" ? due : parseMoney(amount);
  const rec = parseMoney(received);
  const change = method === "efectivo" && rec !== null && value !== null ? rec - value : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (method === "dolares") {
      if (!usd.usd || !usd.rate || !usd.ars) return a.setError("Ingresá los dólares recibidos y la cotización.");
      const ars = Math.min(usd.ars, due);
      return a.run(
        () => getSupabase().rpc("register_payment_usd", { p_workspace_id: ws.id, p_reservation_id: full.r.id, p_usd: usd.usd, p_rate: usd.rate, p_idempotency_key: key, p_note: note || null }),
        () => { setKey(newKey()); setNote(""); onDone(`Pago de US$ ${usd.usd} (${formatMoney(ars)}) registrado.`); },
      );
    }
    if (!value || value <= 0) return a.setError("Ingresá un importe válido.");
    if (value > due) return a.setError(`El saldo ${groupMode ? "del grupo " : ""}es ${formatMoney(due)}.`);
    if (groupMode) {
      return a.run(
        () => getSupabase().rpc("register_group_payment", { p_workspace_id: ws.id, p_group_id: full.r.group_id, p_amount: value, p_method: method, p_idempotency_key: key, p_note: note || null }),
        () => { setKey(newKey()); setAmount(""); setReceived(""); setNote(""); setAllGroup(false); onDone(`Pago de ${formatMoney(value)} registrado y repartido entre las carpas del grupo.`); },
      );
    }
    a.run(
      () => getSupabase().rpc("register_payment", { p_workspace_id: ws.id, p_reservation_id: full.r.id, p_amount: value, p_method: method, p_idempotency_key: key, p_note: note || null }),
      () => { setKey(newKey()); setAmount(""); setReceived(""); setNote(""); onDone(`Pago de ${formatMoney(value)} registrado.`); },
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={`Registrar pago · saldo ${formatMoney(listDue)}`} busy={a.busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        {cashDue !== null && (
          <Alert tone="info">Tiene precio en efectivo: el saldo es {formatMoney(listDue)} con tarjeta o transferencia, o <strong>{formatMoney(cashDue)} en efectivo</strong>.</Alert>
        )}
        {groupInfo !== null && groupInfo.reservas > 1 && (
          <label className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 p-3 text-sm">
            <input type="checkbox" className="mt-0.5" checked={allGroup} onChange={(e) => { setAllGroup(e.target.checked); setAmount(""); }} />
            <span>Cobrar todo el grupo ({groupInfo.reservas} reservas · saldo {formatMoney(groupInfo.due)}). Se reparte en orden entre las carpas.</span>
          </label>
        )}
        <Field label="Medio de pago">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>{COLLECT_METHODS.filter((m) => m.value !== "dolares" || featuresOf(ws).dolares || method === "dolares").map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select>
        </Field>
        {method === "dolares" ? (
          <DollarFields due={due} onChange={setUsd} />
        ) : (
          <TextField label="Importe" inputMode="decimal" placeholder={String(due)} value={amount} onChange={(e) => setAmount(e.target.value)} hint="Vacío = cancela todo el saldo." />
        )}
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
          <Button type="submit" loading={a.busy}>Registrar {method === "dolares" ? (usd.usd ? `US$ ${usd.usd}` : "") : value ? formatMoney(value) : ""}</Button>
        </div>
      </form>
    </Modal>
  );
}

