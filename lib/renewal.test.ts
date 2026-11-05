import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRenewals, nextYear, seasonRange, shiftSeason } from "./renewal.ts";

test("temporadas y fechas", () => {
  assert.deepEqual(seasonRange("2025/2026"), { from: "2025-07-01", to: "2026-06-30" });
  assert.equal(shiftSeason("2026/2027", -1), "2025/2026");
  assert.equal(nextYear("2028-02-29"), "2029-02-28");
  assert.equal(nextYear("2026-01-05"), "2027-01-05");
});

const people = [
  { id: "ana", first_name: "Ana", last_name: "Gómez", phone: "2255 123456" },
  { id: "juan", first_name: "Juan", last_name: null, phone: null },
  { id: "luis", first_name: "Luis", last_name: "Paz", phone: null },
];

test("lugar habitual, estado y lugar tomado", () => {
  const prev = [
    // Ana: 10 días en la 17 y 2 en la 20 (cambio) → su lugar es la 17
    { reservation_id: "r1", customer_id: "ana", space_id: "s17", code: "17", kind: "carpa" as const, start_date: "2026-01-01", end_date: "2026-01-10" },
    { reservation_id: "r1", customer_id: "ana", space_id: "s20", code: "20", kind: "carpa" as const, start_date: "2026-01-11", end_date: "2026-01-12" },
    { reservation_id: "r2", customer_id: "juan", space_id: "s3", code: "3", kind: "carpa" as const, start_date: "2026-02-01", end_date: "2026-02-15" },
    { reservation_id: "r3", customer_id: "luis", space_id: "u1", code: "S1", kind: "sombrilla" as const, start_date: "2026-01-20", end_date: "2026-01-25" },
  ];
  const next = [
    // Juan ya reservó; otro cliente tiene la 17 en enero de 2027
    { reservation_id: "n1", number: 40, customer_id: "juan", space_id: "s3", start_date: "2027-02-01", end_date: "2027-02-15" },
    { reservation_id: "n2", number: 41, customer_id: "otro", space_id: "s17", start_date: "2027-01-08", end_date: "2027-01-09" },
  ];
  const marks = [{ customer_id: "luis", status: "no_vuelve" as const, contacted_at: null }];
  const list = buildRenewals(prev, people, next, marks);
  assert.deepEqual(list.map((r) => r.customer.id), ["juan", "ana", "luis"]);
  const ana = list.find((r) => r.customer.id === "ana")!;
  assert.equal(ana.main.code, "17");
  assert.deepEqual(ana.others, ["20"]);
  assert.equal(ana.totalDays, 12);
  assert.equal(ana.stays, 1);
  assert.equal(ana.proposeFrom, "2027-01-01");
  assert.equal(ana.proposeTo, "2027-01-12");
  assert.equal(ana.status, "pendiente");
  assert.equal(ana.takenBy?.number, 41);
  const juan = list.find((r) => r.customer.id === "juan")!;
  assert.equal(juan.status, "ya_reservo");
  assert.equal(juan.newReservations[0].number, 40);
  assert.equal(juan.takenBy, null);
  assert.equal(list.find((r) => r.customer.id === "luis")!.status, "no_vuelve");

  // Dos estadías: se propone la más larga
  const two = buildRenewals([
    { reservation_id: "a", customer_id: "ana", space_id: "s1", code: "1", kind: "carpa", start_date: "2026-01-02", end_date: "2026-01-04" },
    { reservation_id: "b", customer_id: "ana", space_id: "s1", code: "1", kind: "carpa", start_date: "2026-02-10", end_date: "2026-02-20" },
  ], people, [], []);
  assert.equal(two[0].stays, 2);
  assert.equal(two[0].proposeFrom, "2027-02-10");
  assert.equal(two[0].first, "2026-01-02");
});
