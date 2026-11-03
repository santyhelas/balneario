import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalizeName } from "./names.ts";

test("pone mayúscula inicial al nombre y apellido", () => {
  assert.equal(capitalizeName("juan pablo"), "Juan Pablo");
  assert.equal(capitalizeName("  maría   josé "), "María José");
  assert.equal(capitalizeName("ñandú"), "Ñandú");
  assert.equal(capitalizeName("garcía-lópez"), "García-López");
  assert.equal(capitalizeName("de la torre"), "De la Torre");
  assert.equal(capitalizeName("o'connor"), "O'Connor");
});

test("respeta lo que ya tiene mayúsculas", () => {
  assert.equal(capitalizeName("McDonald"), "McDonald");
  assert.equal(capitalizeName("PEREZ"), "PEREZ");
});
