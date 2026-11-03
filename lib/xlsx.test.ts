import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { buildXlsx, crc32 } from "./xlsx.ts";

test("crc32 conocido", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("arma un .xlsx (zip) con las hojas", () => {
  const bytes = buildXlsx([
    { name: "Alquileres", header: ["Cliente", "Teléfono", "Total"], rows: [["Pérez, Ana", "+54 9 2255 45-1234", 150000.5], ["<raro> & \"comillas\"", null, 0]], money: [2], widths: [20, 18, 12] },
    { name: "Clientes", header: ["Nombre"], rows: [["Juan"]] },
  ]);
  assert.equal(bytes[0], 0x50); // "PK"
  assert.equal(bytes[1], 0x4b);
  if (process.env.XLSX_OUT) writeFileSync(process.env.XLSX_OUT, bytes);
});
