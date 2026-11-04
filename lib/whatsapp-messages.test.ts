import { test } from "node:test";
import assert from "node:assert/strict";
import { debtReminder, receiptMessage } from "./whatsapp-messages.ts";

const base = { firstName: "Juan", balneario: "Parador Eólico", number: 12, places: "Carpa 17", start: "2027-01-01", end: "2027-01-07", due: 50000 };

test("recordatorio según el día", () => {
  assert.match(debtReminder({ ...base, today: "2027-01-06" }), /termina mañana, 07\/01/);
  assert.match(debtReminder({ ...base, today: "2027-01-07" }), /Hoy es el último día/);
  assert.match(debtReminder({ ...base, today: "2027-01-10" }), /terminó el 07\/01/);
  assert.match(debtReminder({ ...base, today: "2026-12-20" }), /Te recordamos tu reserva del 01\/01 al 07\/01/);
  assert.match(debtReminder({ ...base, today: "2027-01-03" }), /\$\s?50\.000/);
});

test("comprobante con pagos y saldo", () => {
  const m = receiptMessage({ balneario: "Parador Eólico", number: 12, customer: "Juan Pérez", places: "Carpa 17", start: "2027-01-01", end: "2027-01-07",
    total: 150000, paid: 100000, due: 50000, courtesy: false,
    payments: [{ date: "2026-12-20", kind: "cobro", method: "Efectivo", amount: 100000, voided: false }, { date: "2026-12-21", kind: "cobro", method: "Transferencia", amount: 5000, voided: true }] });
  assert.match(m, /7 días/);
  assert.match(m, /Pago Efectivo/);
  assert.doesNotMatch(m, /Transferencia/);
  assert.match(m, /Saldo pendiente/);
});
