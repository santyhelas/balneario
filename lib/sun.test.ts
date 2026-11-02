import { test } from "node:test";
import assert from "node:assert/strict";
import { cardinal, sunPosition, sunTimes } from "./sun.ts";

test("puntos cardinales", () => {
  assert.equal(cardinal(0), "N");
  assert.equal(cardinal(45), "NE");
  assert.equal(cardinal(135), "SE");
  assert.equal(cardinal(270), "O");
  assert.equal(cardinal(359), "N");
});

test("sol en Villa Gesell al mediodía de enero: alto y hacia el norte", () => {
  // 16:00 UTC ≈ 13:00 en Argentina, cerca del mediodía solar (lon -57°).
  const p = sunPosition(new Date("2027-01-15T15:50:00Z"), -37.26, -56.97);
  assert.ok(p.elevation > 65 && p.elevation < 80, `elevación ${p.elevation}`);
  assert.ok(p.azimuth > 300 || p.azimuth < 60, `azimut ${p.azimuth}`);
});

test("salida del sol en Villa Gesell en enero: entre 08:30 y 09:15 UTC (05:30–06:15 hora argentina)", () => {
  const prevTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const { sunrise, sunset } = sunTimes(new Date("2027-01-15T12:00:00Z"), -37.26, -56.97);
  process.env.TZ = prevTZ;
  assert.ok(sunrise && sunset);
  const h = sunrise!.getUTCHours() + sunrise!.getUTCMinutes() / 60;
  assert.ok(h > 8.4 && h < 9.3, `salida ${sunrise!.toISOString()}`);
  const s = sunset!.getUTCHours() + sunset!.getUTCMinutes() / 60;
  assert.ok(s > 22.6 && s < 23.6, `puesta ${sunset!.toISOString()}`);
});
