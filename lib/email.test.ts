import { test } from "node:test";
import assert from "node:assert/strict";
import { EMAIL_RE, emailSuggestion } from "./email.ts";

test("formato", () => {
  assert.ok(EMAIL_RE.test("ana.perez@gmail.com"));
  assert.ok(!EMAIL_RE.test("ana.perez@gmail"));
  assert.ok(!EMAIL_RE.test("ana perez@gmail.com"));
});

test("sugiere correcciones de tipeo", () => {
  assert.equal(emailSuggestion("Ana@Gmial.com"), "ana@gmail.com");
  assert.equal(emailSuggestion("ana@gmail.com"), null);
});
