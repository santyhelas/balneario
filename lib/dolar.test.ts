import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArNumber, parseBnaHtml, usdToArs } from "./dolar.ts";

const SAMPLE = `<div id="billetes"><table class="table cotizacion"><thead><tr><th class="fechaCot">2/11/2026</th><th>Compra</th><th>Venta</th></tr></thead>
<tbody><tr><td class="tit">Dolar U.S.A</td><td>1.405,00</td><td>1.455,00</td></tr><tr><td class="tit">Euro</td><td>1600,00</td><td>1700,00</td></tr></tbody></table></div>`;

test("lee la cotización de billetes del Banco Nación", () => {
  assert.deepEqual(parseBnaHtml(SAMPLE), { compra: 1405, venta: 1455, fecha: "2026-11-02", fuente: "Banco Nación" });
});

test("si la página cambia, no inventa una cotización", () => {
  assert.equal(parseBnaHtml("<html>sin datos</html>"), null);
  assert.equal(parseBnaHtml("<td>Dolar U.S.A</td><td>abc</td>"), null);
});

test("números con formato argentino", () => {
  assert.equal(parseArNumber("1.405,50"), 1405.5);
  assert.equal(parseArNumber("1405,5000"), 1405.5);
  assert.equal(parseArNumber("x"), null);
});

test("conversión a pesos", () => {
  assert.equal(usdToArs(100, 1405), 140500);
  assert.equal(usdToArs(33.33, 1405.5), 46845.32);
});
