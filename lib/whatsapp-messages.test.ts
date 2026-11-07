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
  const m = quoteMessage({ firstName: "Ana", balneario: "Mi Balneario", places: "Carpa 17", start: "2027-01-05", end: "2027-01-20", total: 300000, cashTotal: 270000, discounts: [] });
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
  const m = renewalMessage({ firstName: "Juan", balneario: "Mi Balneario", places: "Carpa 17", lastSeason: "2025/2026", newSeason: "2026/2027" });
  assert.match(m, /temporada 2026\/2027/);
  assert.match(m, /Carpa 17/);
});

test("mensaje propio de deuda", () => {
  const t = { deuda_hoy: "Che {nombre}, hoy te vas de la {lugar} y debés {saldo}. {otro}" };
  const m = debtReminder({ ...base, today: "2027-01-07" }, t);
  assert.match(m, /^Che Juan, hoy te vas de la Carpa 17 y debés \$\s?50\.000\. \{otro\}$/);
  // los otros casos siguen con el mensaje de siempre
  assert.match(debtReminder({ ...base, today: "2027-01-06" }, t), /termina mañana/);
  // sin carpa no queda "(, reserva"
  assert.match(debtReminder({ ...base, places: "", today: "2027-01-07" }), /\(reserva #12\)/);
  assert.doesNotMatch(debtReminder({ ...base, places: "", today: "2027-01-07" }), /\(,/);
});

test("mensajes: datos nuevos (total, seña, apellido) y correo", async () => {
  const { debtVars, fillTemplate, mailMessage } = await import("./whatsapp-messages.ts");
  const d = { firstName: "Ana", lastName: "Gómez", email: "ana@x.com", phone: "123", balneario: "La Ola", number: 7, places: "Carpa 3",
    start: "2027-01-10", end: "2027-01-14", total: 150000, paid: 50000, due: 100000, today: "2027-01-12" };
  const v = debtVars(d);
  assert.equal(v.dias, "5");
  assert.equal(fillTemplate("{cliente}: total {total}, seña {sena}, saldo {saldo}", v).replace(/ /g, " "), "Ana Gómez: total $ 150.000, seña $ 50.000, saldo $ 100.000");
  const m = mailMessage(d, { mail_asunto: "Reserva {reserva}", mail_cuerpo: "Hola {nombre}" });
  assert.equal(m.subject, "Reserva 7");
  assert.equal(m.body, "Hola Ana");
  assert.match(mailMessage(d).subject, /#7 en La Ola/);
});

test("correo: abre el correo que usa el balneario", async () => {
  const { mailtoLink } = await import("./whatsapp-messages.ts");
  assert.match(mailtoLink("a@b.com", "Hola", "Texto"), /^https:\/\/mail\.google\.com\/mail\/\?view=cm&fs=1&to=a%40b\.com&su=Hola&body=Texto$/);
  assert.match(mailtoLink("a@b.com", "Hola", "Texto", "outlook"), /^https:\/\/outlook\.live\.com\/mail\/0\/deeplink\/compose\?to=a%40b\.com&subject=Hola&body=Texto$/);
  assert.match(mailtoLink("a@b.com", "Hola", "Texto", "app"), /^mailto:a%40b\.com\?subject=Hola&body=Texto$/);
  assert.match(mailtoLink("a@b.com", "Hola", "Texto", "gmail", "yo@gmail.com"), /^https:\/\/mail\.google\.com\/mail\/\?authuser=yo%40gmail\.com&view=cm/);
  assert.match(mailtoLink("a@b.com", "Hola que tal", "x"), /su=Hola%20que%20tal/);
  const { providerForEmail } = await import("./whatsapp-messages.ts");
  assert.equal(providerForEmail("x@gmail.com"), "gmail");
  assert.equal(providerForEmail("x@hotmail.com.ar"), "outlook");
  assert.equal(providerForEmail("x@outlook.com"), "outlook");
  assert.equal(providerForEmail("x@yahoo.com.ar"), "yahoo");
  assert.equal(providerForEmail("x@mibalneario.com.ar"), "app");
  assert.equal(providerForEmail(null), "gmail");
});
