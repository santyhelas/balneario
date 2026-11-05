import { test } from "node:test";
import assert from "node:assert/strict";
import { debtReminder, quoteMessage, receiptMessage, renewalMessage } from "./whatsapp-messages.ts";

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

test("presupuesto con precio en efectivo", () => {
  const m = quoteMessage({ firstName: "Ana", balneario: "Tu Balneario", places: "Carpa 17", start: "2027-01-05", end: "2027-01-20", total: 300000, cashTotal: 270000, discounts: [] });
  assert.match(m, /Hola Ana!/);
  assert.match(m, /16 días/);
  assert.match(m, /Total: \$\s?300\.000/);
  assert.match(m, /efectivo: \$\s?270\.000/);
  const sin = quoteMessage({ firstName: null, balneario: "X", places: "Sombrilla 2", start: "2027-01-05", end: "2027-01-05", total: 1000, cashTotal: 1000, discounts: ["Convenio Parque Bonito"] });
  assert.match(sin, /^Hola! /);
  assert.match(sin, /1 día\)/);
  assert.doesNotMatch(sin, /efectivo/);
  assert.match(sin, /Incluye: Convenio Parque Bonito/);
});

test("renovación de temporada", () => {
  const m = renewalMessage({ firstName: "Juan", balneario: "Tu Balneario", places: "Carpa 17", lastSeason: "2025/2026", newSeason: "2026/2027" });
  assert.match(m, /temporada 2026\/2027/);
  assert.match(m, /Carpa 17/);
});
