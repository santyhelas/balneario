import { test } from "node:test";
import assert from "node:assert/strict";
import { owSymbol, parseOw } from "./openweather.ts";

test("lee el clima actual", () => {
  const a = parseOw({ dt: 1793640000, name: "Villa Gesell", main: { temp: 23.04, humidity: 70, feels_like: 22.8 },
    wind: { speed: 1.39, deg: 120, gust: 3.1 }, weather: [{ id: 801, description: "algo de nubes", icon: "02d" }] });
  assert.equal(a?.temperatura, 23);
  assert.equal(a?.viento_kmh, 5);
  assert.equal(a?.rafagas_kmh, 11);
  assert.equal(a?.viento_desde, 120);
  assert.equal(a?.simbolo, "fair_day");
  assert.equal(a?.cielo, "Algo de nubes");
  assert.equal(a?.hora, new Date(1793640000 * 1000).toISOString());
});

test("sin datos no inventa", () => {
  assert.equal(parseOw({ dt: 1 } as never), null);
});

test("íconos", () => {
  assert.equal(owSymbol(800, "01n"), "clearsky_night");
  assert.equal(owSymbol(741, "50d"), "fog");
  assert.equal(owSymbol(211, "11d"), "rainandthunder");
});
