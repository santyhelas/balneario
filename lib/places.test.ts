import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaces, placeLabel } from "./places.ts";

test("nombre corto del lugar", () => {
  assert.equal(placeLabel({ lat: "0", lon: "0", name: "Punta Mogotes", address: { city: "Mar del Plata", state: "Buenos Aires" } }), "Punta Mogotes, Mar del Plata, Buenos Aires");
  assert.equal(placeLabel({ lat: "0", lon: "0", address: { town: "Pinamar", state: "Buenos Aires" } }), "Pinamar, Buenos Aires");
  assert.equal(placeLabel({ lat: "0", lon: "0", display_name: "A, B, C, D, E" }), "A, B, C");
});

test("lista de resultados", () => {
  const r = parsePlaces([{ lat: "-38.0912345", lon: "-57.5512345", name: "Punta Mogotes", address: { state: "Buenos Aires" } }, { lat: "x", lon: "1", name: "Mal" }]);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { label: "Punta Mogotes, Buenos Aires", lat: -38.09123, lon: -57.55123 });
  assert.deepEqual(parsePlaces({ error: "x" }), []);
});
