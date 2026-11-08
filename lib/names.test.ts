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

test("capitalizeTyping: mayúscula mientras se escribe", async () => {
  const { capitalizeTyping } = await import("./names.ts");
  assert.equal(capitalizeTyping("j"), "J");
  assert.equal(capitalizeTyping("juan"), "Juan");
  assert.equal(capitalizeTyping("juan p"), "Juan p");
  assert.equal(capitalizeTyping("juan pablo "), "Juan Pablo ");
  assert.equal(capitalizeTyping("de la torre"), "De la torre");
  assert.equal(capitalizeTyping("maría de la torre "), "María de la Torre ");
  assert.equal(capitalizeTyping("McDonald"), "McDonald");
  assert.equal(capitalizeTyping("garcía-lópez "), "García-López ");
});
