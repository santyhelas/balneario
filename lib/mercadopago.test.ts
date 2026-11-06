import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { arDate, paymentOutcome, recurringFor, verifyMpSignature } from "./mercadopago-core.ts";

const secret = "secreto-de-prueba";
const sign = (manifest: string) => createHmac("sha256", secret).update(manifest).digest("hex");

test("acepta un aviso bien firmado y rechaza uno falso", () => {
  const ts = "1762430000";
  const v1 = sign(`id:abc123;request-id:req-1;ts:${ts};`);
  assert.equal(verifyMpSignature({ signature: `ts=${ts},v1=${v1}`, requestId: "req-1", dataId: "ABC123", secret }), true);
  assert.equal(verifyMpSignature({ signature: `ts=${ts},v1=${v1}`, requestId: "req-2", dataId: "ABC123", secret }), false);
  assert.equal(verifyMpSignature({ signature: `ts=${ts},v1=${v1}`, requestId: "req-1", dataId: "ABC123", secret: "otro" }), false);
  assert.equal(verifyMpSignature({ signature: null, requestId: "req-1", dataId: "x", secret }), false);
  assert.equal(verifyMpSignature({ signature: "basura", requestId: "req-1", dataId: "x", secret }), false);
});

test("no acepta avisos viejos si se pide", () => {
  const ts = "1762430000";
  const v1 = sign(`id:1;ts:${ts};`);
  assert.equal(verifyMpSignature({ signature: `ts=${ts},v1=${v1}`, requestId: null, dataId: "1", secret, maxAgeSec: 600, now: 1762430000_000 + 60_000 }), true);
  assert.equal(verifyMpSignature({ signature: `ts=${ts},v1=${v1}`, requestId: null, dataId: "1", secret, maxAgeSec: 600, now: 1762430000_000 + 3_600_000 }), false);
});

test("fecha argentina de un cobro", () => {
  assert.equal(arDate("2026-12-01T02:00:00.000Z"), "2026-11-30");
  assert.equal(arDate("2026-12-01T13:00:00.000-03:00"), "2026-12-01");
  assert.equal(arDate(null), null);
});

test("resultado de un cobro", () => {
  assert.equal(paymentOutcome({ status: "processed", payment: { status: "approved" } }), "approved");
  assert.equal(paymentOutcome({ status: "recycling", payment: { status: "rejected" } }), "rejected");
  assert.equal(paymentOutcome({ status: "scheduled" }), null);
});

test("débito: mensual ya; temporada desde el 1/12", () => {
  assert.equal(recurringFor("mensual", 15000, "2026-12-01", "2026-11-06").frequency, 1);
  const t = recurringFor("temporada", 120000, "2026-12-01", "2026-11-06");
  assert.equal(t.frequency, 12);
  assert.equal((t as { start_date?: string }).start_date, "2026-12-01T10:00:00.000-03:00");
  assert.equal((recurringFor("temporada", 120000, "2026-12-01", "2026-12-01") as { start_date?: string }).start_date, undefined);
});
