import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPhone, parsePhone, phoneProblem } from "./phone.ts";

test("celular argentino con el 9", () => {
  assert.equal(formatPhone({ dial: "54", mobile: true, area: "11", number: "45554165" }), "+54 9 11 4555-4165");
  assert.equal(formatPhone({ dial: "54", mobile: false, area: "223", number: "4551234" }), "+54 223 455-1234");
});

test("limpia el 0 del área y el 15 del celular", () => {
  assert.equal(formatPhone({ dial: "54", mobile: true, area: "0223", number: "15 455-1234" }), "+54 9 223 455-1234");
  assert.equal(phoneProblem({ dial: "54", mobile: true, area: "011", number: "1545554165" }), null);
});

test("valida la cantidad de dígitos en Argentina", () => {
  assert.match(phoneProblem({ dial: "54", mobile: true, area: "11", number: "4555416" }) ?? "", /10 dígitos/);
  assert.match(phoneProblem({ dial: "54", mobile: true, area: "", number: "45554165" }) ?? "", /código de área/);
  assert.equal(phoneProblem({ dial: "54", mobile: true, area: "", number: "" }), null);
});

test("otros países", () => {
  assert.equal(formatPhone({ dial: "598", mobile: true, area: "99", number: "123456" }), "+598 99 12-3456");
});

test("lee teléfonos guardados", () => {
  assert.deepEqual(parsePhone("+54 9 11 4555-4165"), { dial: "54", mobile: true, area: "11", number: "45554165" });
  assert.deepEqual(parsePhone("+54 223 455-1234"), { dial: "54", mobile: false, area: "223", number: "4551234" });
  assert.deepEqual(parsePhone("11 4555-4165"), { dial: "54", mobile: true, area: "11", number: "45554165" });
  assert.deepEqual(parsePhone(null), { dial: "54", mobile: true, area: "", number: "" });
});

import { phoneFromText, splitArgentine } from "./phone.ts";

test("un solo campo: separa el código de área", () => {
  assert.deepEqual(splitArgentine("2255 45-1234"), { area: "2255", number: "451234" });
  assert.deepEqual(splitArgentine("011 15 4555-4165"), { area: "11", number: "45554165" });
  assert.deepEqual(splitArgentine("+54 9 223 455-1234"), { area: "223", number: "4551234" });
  assert.deepEqual(splitArgentine("02255 15 451234"), { area: "2255", number: "451234" });
  assert.deepEqual(splitArgentine("1145554165"), { area: "11", number: "45554165" });
  assert.equal(formatPhone(phoneFromText("54", true, "2255 451234")), "+54 9 2255 45-1234");
  assert.equal(formatPhone(phoneFromText("598", true, "99 123 456")), "+598 9912-3456");
});
