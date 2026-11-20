import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { APP_SECTIONS, isAppPath } from "./app-paths.ts";

test("todas las pantallas del sistema están en la lista", () => {
  const dirs = readdirSync(new URL("../app/(app)", import.meta.url), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
  for (const d of [...dirs, "dueno"]) assert.ok(APP_SECTIONS.includes(d), `falta «${d}» en APP_SECTIONS`);
});

test("reconoce pantallas y direcciones desconocidas", () => {
  assert.equal(isAppPath("/reservas/nueva"), true);
  assert.equal(isAppPath("/caja"), true);
  assert.equal(isAppPath("/cualquiercosa"), false);
  assert.equal(isAppPath("/reservasx"), false);
});
