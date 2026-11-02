import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney, parseMoney, formatDate, parseDate, todayISO, addDays, inclusiveDays } from "./format.ts";

const norm = (s: string) => s.replace(/\s/g, " ");

test("formatMoney muestra pesos argentinos con separador de miles", () => {
  assert.equal(norm(formatMoney(150000)), "$ 150.000");
  assert.equal(norm(formatMoney("70000.50")), "$ 70.000,5");
  assert.equal(formatMoney(null), "—");
});

test("parseMoney entiende el formato argentino", () => {
  assert.equal(parseMoney("150.000"), 150000);
  assert.equal(parseMoney("150000"), 150000);
  assert.equal(parseMoney("1.234,56"), 1234.56);
  assert.equal(parseMoney("$ 50.000"), 50000);
  assert.equal(parseMoney("abc"), null);
  assert.equal(parseMoney("1,2,3"), null);
  assert.equal(parseMoney(""), null);
});

test("fechas DD/MM/AAAA sin corrimientos", () => {
  assert.equal(formatDate("2027-01-04"), "04/01/2027");
  assert.equal(parseDate("4/1/2027"), "2027-01-04");
  assert.equal(parseDate("31/02/2027"), null);
  assert.equal(parseDate("2027-01-04"), null);
});

test("hoy en San Juan aunque en UTC ya sea mañana", () => {
  // 2 de enero 02:00 UTC = 1 de enero 23:00 en Argentina
  assert.equal(todayISO("America/Argentina/San_Juan", new Date("2027-01-02T02:00:00Z")), "2027-01-01");
});

test("suma de días y días inclusivos", () => {
  assert.equal(addDays("2027-01-30", 3), "2027-02-02");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(inclusiveDays("2027-01-01", "2027-01-05"), 5);
  assert.equal(inclusiveDays("2027-01-01", "2027-01-01"), 1);
});
