import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { parseTiepre, parseWhen, parseWind, unzipFirst } from "./smn.ts";

const SAMPLE = [
  "Aeroparque Buenos Aires;02-Nov-2026;13:00;Despejado;15 km;  24.1;No se calcula;  40;Norte  15;1012.0 /",
  "Mar del Plata Aero;02-Nov-2026;13:00;Algo nublado;20 km;  19.5;No se calcula;  60;Sudeste  22;1014.2 /",
  "Villa Gesell Aero;02-Nov-2026;13:00;Parcialmente nublado;20 km;  20.3;No se calcula;  58;Noreste  18;1013.8 /",
].join("\n");

test("toma la estación más cercana al balneario", () => {
  const o = parseTiepre(SAMPLE, -37.2639, -56.9731);
  assert.equal(o?.estacion, "Villa Gesell Aero");
  assert.equal(o?.temperatura, 20.3);
  assert.equal(o?.humedad, 58);
  assert.equal(o?.viento_kmh, 18);
  assert.equal(o?.viento_desde, 45);
  assert.equal(o?.hora, "2026-11-02T13:00:00-03:00");
});

test("si falta la estación cercana usa la siguiente (hasta 100 km)", () => {
  const sinGesell = SAMPLE.split("\n").filter((l) => !l.startsWith("Villa")).join("\n");
  assert.equal(parseTiepre(sinGesell, -37.2639, -56.9731)?.estacion, "Mar del Plata Aero");
});

test("si no entiende el archivo no inventa datos", () => {
  assert.equal(parseTiepre("algo raro", -37.2639, -56.9731), null);
  assert.equal(parseTiepre(SAMPLE, -24.8, -65.4), null); // Salta: ninguna estación cerca
});

test("viento y fecha", () => {
  assert.deepEqual(parseWind("Calma"), { kmh: 0, from: null });
  assert.deepEqual(parseWind("Oestenoroeste  9"), { kmh: 9, from: 292.5 });
  assert.equal(parseWhen("2-Ene-2027", "9:00"), "2027-01-02T09:00:00-03:00");
});

test("descomprime el zip", () => {
  const content = Buffer.from(SAMPLE, "latin1");
  const comp = deflateRawSync(content);
  const name = Buffer.from("tiepre.txt");
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(comp.length, 20); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const cdOffset = 30 + name.length + comp.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt32LE(cdOffset, 16);
  const zip = Buffer.concat([local, name, comp, cd, name, eocd]);
  assert.equal(unzipFirst(zip)?.toString("latin1"), SAMPLE);
});
