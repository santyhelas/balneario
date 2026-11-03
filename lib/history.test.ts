import { test } from "node:test";
import assert from "node:assert/strict";
import { actorName, describeAudit, seasonOf, type AuditRow, type Lookups } from "./history.ts";

const L: Lookups = {
  spaces: new Map([["s17", { code: "17", kind: "carpa" }]]),
  customers: new Map([["c1", "Ana Pérez"]]),
  reservations: new Map([["r1", { number: 12, customer_id: "c1" }]]),
};
const row = (p: Partial<AuditRow>): AuditRow => ({ id: 1, table_name: "", row_id: null, action: "alta", old_data: null, new_data: null, reason: null, actor_id: null, actor_email: null, at: "2026-11-02T12:00:00Z", ...p });

test("temporadas de julio a junio", () => {
  assert.equal(seasonOf("2027-01-10"), "2026/2027");
  assert.equal(seasonOf("2026-12-20"), "2026/2027");
  assert.equal(seasonOf("2026-06-30"), "2025/2026");
});

test("cambio de tarifa con precio anterior y nuevo", () => {
  const d = describeAudit(row({ table_name: "rates", action: "modificacion",
    old_data: { space_kind: "carpa", year: 2027, month: 1, half: 1, daily_price: 40000 },
    new_data: { space_kind: "carpa", year: 2027, month: 1, half: 1, daily_price: 45000 } }), L);
  assert.equal(d?.category, "tarifas");
  assert.equal(d?.title, "Tarifa cambiada: Carpas · enero 2027 · 1ª quincena");
  assert.match(d!.details[0], /^Precio por día: \$\s?40\.000 → \$\s?45\.000$/);
});

test("reserva creada y cancelada", () => {
  const n = { number: 12, customer_id: "c1", start_date: "2027-01-01", end_date: "2027-01-05", total_amount: 100000, status: "confirmada" };
  assert.equal(describeAudit(row({ table_name: "reservations", row_id: "r1", new_data: n }), L)?.title, "Reserva #12 (Ana Pérez) creada");
  const c = describeAudit(row({ table_name: "reservations", row_id: "r1", action: "modificacion", old_data: n, new_data: { ...n, status: "cancelada" }, reason: "Lluvia" }), L);
  assert.equal(c?.title, "Reserva #12 (Ana Pérez) cancelada");
  assert.deepEqual(c?.details, ["Motivo: Lluvia"]);
});

test("cambio de carpa", () => {
  const seg = { reservation_id: "r1", space_id: "s17", start_date: "2027-01-03", end_date: "2027-01-05", active: true };
  assert.equal(describeAudit(row({ table_name: "reservation_segments", new_data: seg }), L)?.title, "Reserva #12 (Ana Pérez): ocupa Carpa 17 del 03/01/2027 al 05/01/2027");
});

test("cambios internos no se muestran", () => {
  const n = { number: 12, customer_id: "c1", status: "confirmada", version: 1 };
  assert.equal(describeAudit(row({ table_name: "reservations", action: "modificacion", old_data: n, new_data: { ...n, version: 2 } }), L), null);
});

test("nombre de usuario", () => {
  assert.equal(actorName("santi@usuarios.balneario.invalid", new Map(), null), "santi");
  assert.equal(actorName(null, new Map([["u1", "Santiago"]]), "u1"), "Santiago");
});
