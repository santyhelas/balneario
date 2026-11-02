import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWindguru, spotOf, widgetDocument } from "./windguru.ts";

test("número de spot suelto", () => {
  const r = parseWindguru("48572");
  assert.ok("params" in r);
  assert.equal(spotOf((r as { params: string }).params), "48572");
  assert.match((r as { params: string }).params, /wj=kmh/);
});

test("dirección de la página del spot", () => {
  const r = parseWindguru("https://www.windguru.cz/48572") as { params: string };
  assert.equal(spotOf(r.params), "48572");
});

test("código del widget: respeta modelo y datos elegidos", () => {
  const code = `<script id="wg_fwdg_485028_3_1591210551148">(function (window, document) { var loader = function () {
    var arg = ["s=485028","m=3","uid=wg_fwdg_485028_3_1591210551148","wj=knots","tj=c","odh=0","doh=24","fhours=240","vt=forecasts","lng=es",
    "p=GUST,MWINDSPD,SMER,TMP,TMPE,WCHILL,FLHGT,CDC,TCDC,APCP1s,SLP,RH,RATING"]; ... </script>`;
  const r = parseWindguru(code) as { params: string };
  assert.equal(spotOf(r.params), "485028");
  assert.match(r.params, /wj=knots/);
  assert.match(r.params, /fhours=240/);
  assert.doesNotMatch(r.params, /uid=/);
});

test("rechaza texto sin spot y valores peligrosos", () => {
  assert.ok("error" in parseWindguru("hola"));
  const r = parseWindguru(`var arg = ["s=123","lng=es</script><script>alert(1)"]`) as { params: string };
  assert.doesNotMatch(r.params, /script/);
});

test("el documento del widget carga el script oficial", () => {
  const html = widgetDocument("s=48572&m=3&lng=es");
  assert.match(html, /https:\/\/www\.windguru\.cz\/js\/widget\.php\?/);
  assert.match(html, /"s=48572"/);
});
