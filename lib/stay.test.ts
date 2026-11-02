import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSegments, candidatesFor, daysOf, indexGrid, splitDays, toRuns, type GridRow } from "./stay.ts";

// Carpa 17 ocupada desde el 4/1; carpa 24 libre todo; carpa 30 ocupada el 5/1.
const days = daysOf("2027-01-01", "2027-01-05");
const rows: GridRow[] = days.flatMap((d) => [
  { space_id: "c17", code: "17", kind: "carpa", day: d, free: d < "2027-01-04", reason: d < "2027-01-04" ? null : "ocupada" },
  { space_id: "c24", code: "24", kind: "carpa", day: d, free: true, reason: null },
  { space_id: "c30", code: "30", kind: "carpa", day: d, free: d !== "2027-01-05", reason: null },
]);
const idx = indexGrid(rows);

test("días inclusivos", () => {
  assert.deepEqual(daysOf("2027-01-30", "2027-02-02"), ["2027-01-30", "2027-01-31", "2027-02-01", "2027-02-02"]);
});

test("el ejemplo del pedido: 17 libre del 1 al 3, ocupada 4 y 5", () => {
  const s = splitDays(idx, "c17", days);
  assert.deepEqual(s.freeRuns, [{ start: "2027-01-01", end: "2027-01-03", days: 3 }]);
  assert.deepEqual(s.busyRuns, [{ start: "2027-01-04", end: "2027-01-05", days: 2 }]);
});

test("alternativas para los días ocupados: solo las libres en todo el tramo", () => {
  const c = candidatesFor(idx, [{ space_id: "c17", code: "17" }, { space_id: "c24", code: "24" }, { space_id: "c30", code: "30" }],
    { start: "2027-01-04", end: "2027-01-05", days: 2 }, "c17", "17");
  assert.deepEqual(c.map((x) => x.code), ["24"]);
});

test("una sola reserva con dos tramos contiguos", () => {
  const segs = buildSegments(days.map((d) => ({ day: d, space_id: d < "2027-01-04" ? "c17" : "c24" })));
  assert.deepEqual(segs, [
    { space_id: "c17", start_date: "2027-01-01", end_date: "2027-01-03" },
    { space_id: "c24", start_date: "2027-01-04", end_date: "2027-01-05" },
  ]);
});

test("tramos separados por un hueco quedan como tramos distintos", () => {
  assert.deepEqual(toRuns(["2027-01-01", "2027-01-02", "2027-01-05"]).map((r) => r.days), [2, 1]);
});
