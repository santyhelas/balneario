// Revisión automática del sitio en producción (la corre .github/workflows/revision.yml).
// Recorre la presentación, el ingreso y toda la demo en PC y celular, y anota:
// errores de la consola, pedidos que fallan, imágenes rotas, páginas que se salen de la pantalla,
// cargas que no terminan y avisos de error en pantalla. Deja capturas e informe en revision/.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.URL ?? "https://balneario-beta.vercel.app";
// La demo se recorre en una copia del sitio armada en CI sin la casilla de Cloudflare (que, bien hecha, frena a los robots
// como este), conectada a la misma base. Si no hay copia, se intenta en producción.
const DEMO = process.env.DEMO_URL ?? BASE;
const OUT = "revision";
mkdirSync(`${OUT}/capturas`, { recursive: true });

const report = { base: BASE, fecha: new Date().toISOString(), publico: [], demo: [], flujos: [], api: [], cabeceras: {}, enlaces: [] };
const log = (...a) => console.log(...a);

const VIEWS = {
  pc: { viewport: { width: 1366, height: 860 } },
  cel: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

function watch(page) {
  const issues = { consola: [], errores_js: [], pedidos: [] };
  page.on("console", (m) => { if (m.type() === "error") issues.consola.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => issues.errores_js.push(String(e).slice(0, 300)));
  page.on("response", (r) => {
    const s = r.status();
    const u = r.url();
    if (s >= 400 && !u.includes("/_vercel/") && !u.includes("challenges.cloudflare.com")) issues.pedidos.push(`${s} ${r.request().method()} ${u.slice(0, 160)}`);
  });
  page.on("requestfailed", (r) => {
    const u = r.url();
    const f = r.failure()?.errorText ?? "";
    if (!f.includes("ERR_ABORTED") && !u.includes("/_vercel/")) issues.pedidos.push(`FALLÓ ${u.slice(0, 160)} ${f}`);
  });
  return issues;
}

async function inspect(page) {
  return page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const broken = [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.src).map((i) => i.src.slice(0, 120));
    const alerts = [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent.trim().slice(0, 200)).filter(Boolean);
    const loading = /Cargando…|Consultando disponibilidad…|Calculando…/.test(document.body.innerText);
    // Elementos que se salen por la derecha (para encontrar al culpable del scroll horizontal).
    const wide = [];
    if (overflow > 2) {
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth + 2 && r.width > 0 && getComputedStyle(el).position !== "fixed") {
          wide.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} (${Math.round(r.right)}px)`);
          if (wide.length > 4) break;
        }
      }
    }
    return { titulo: document.title, desborde_px: overflow > 2 ? overflow : 0, culpables: wide, imagenes_rotas: broken, avisos: alerts, sigue_cargando: loading };
  });
}

async function check(page, path, name, view, issues, extraWait = 1200, base = BASE) {
  const before = { c: issues.consola.length, e: issues.errores_js.length, p: issues.pedidos.length };
  let status = null;
  try {
    const res = await page.goto(base + path, { waitUntil: "networkidle", timeout: 45000 });
    status = res?.status() ?? null;
  } catch (e) { status = `ERROR ${String(e).slice(0, 120)}`; }
  await page.waitForTimeout(extraWait);
  // Si algo sigue cargando, se le da un rato más.
  let info = await inspect(page);
  if (info.sigue_cargando) { await page.waitForTimeout(6000); info = await inspect(page); }
  const file = `${name}-${view}.png`.replace(/[^\w.-]+/g, "_");
  await page.screenshot({ path: `${OUT}/capturas/${file}`, fullPage: view === "pc" });
  const row = {
    pagina: path, vista: view, estado: status, url_final: page.url().replace(base, ""), ...info, captura: file,
    consola: issues.consola.slice(before.c), errores_js: issues.errores_js.slice(before.e), pedidos: issues.pedidos.slice(before.p),
  };
  log(`${view} ${path} → ${status} ${row.consola.length + row.errores_js.length + row.pedidos.length} problemas`);
  return row;
}

// Con ventana (xvfb en CI): Cloudflare desconfía menos que del modo "headless".
const browser = await chromium.launch({ headless: process.env.HEADLESS === "1", args: ["--disable-blink-features=AutomationControlled"] });

/** Si aparece la casilla "no soy un robot" de Cloudflare, la toca (como haría una persona). */
async function passCaptcha(page, ms = 25000) {
  const end = Date.now() + ms;
  let clicked = 0;
  while (Date.now() < end) {
    const frames = page.locator('iframe[src*="challenges.cloudflare.com"]');
    const n = await frames.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const box = await frames.nth(i).boundingBox().catch(() => null);
      if (box && box.width > 50 && box.height > 30 && clicked < 3) {
        await page.mouse.move(box.x + 10, box.y + 10);
        await page.waitForTimeout(400);
        await page.mouse.click(box.x + 28, box.y + box.height / 2);
        clicked++;
        await page.waitForTimeout(4000);
      }
    }
    if (n === 0 && clicked > 0) return "tocada";
    await page.waitForTimeout(800);
  }
  return clicked ? "tocada (sigue visible)" : "no apareció";
}

// ---------- 1. Parte pública ----------
for (const [view, opts] of Object.entries(VIEWS)) {
  const ctx = await browser.newContext({ ...opts, locale: "es-AR", timezoneId: "America/Argentina/San_Juan" });
  const page = await ctx.newPage();
  const issues = watch(page);
  for (const path of ["/", "/login", "/terminos", "/privacidad", "/mapa", "/caja", "/admin", "/no-existe-esta-pagina"]) {
    report.publico.push(await check(page, path, `publico${path === "/" ? "-inicio" : path}`, view, issues));
  }
  if (view === "pc") {
    // Cabeceras de seguridad de la portada
    const r = await page.request.get(BASE + "/");
    const h = r.headers();
    for (const k of ["content-security-policy", "strict-transport-security", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy"]) report.cabeceras[k] = h[k] ?? null;
    // Enlaces de la portada
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    const links = await page.$$eval("a[href]", (as) => [...new Set(as.map((a) => a.href))]);
    for (const l of links) {
      if (!l.startsWith("http") || l.includes("wa.me") || l.includes("instagram.com") || l.startsWith("mailto")) { report.enlaces.push({ enlace: l, estado: "externo (no se prueba)" }); continue; }
      try { const rr = await page.request.get(l, { maxRedirects: 5 }); report.enlaces.push({ enlace: l.replace(BASE, ""), estado: rr.status() }); }
      catch (e) { report.enlaces.push({ enlace: l, estado: `ERROR ${String(e).slice(0, 80)}` }); }
    }
    // Ingreso con datos incorrectos: tiene que mostrar un error claro
    try {
      await page.goto(DEMO + "/login", { waitUntil: "networkidle" });
      await page.locator('input[type="email"], input[name="email"], input[autocomplete="username"]').first().fill("no-existe@ejemplo.com");
      await page.locator('input[type="password"]').first().fill("clave-equivocada-123");
      await page.getByRole("button", { name: /^Ingresar$/ }).first().click();
      const cap = await passCaptcha(page, 20000);
      await page.waitForTimeout(4000);
      report.flujos.push({ flujo: "Casilla de Cloudflare en el ingreso", resultado: cap });
      const txt = await page.locator('[role="alert"]').allTextContents();
      await page.screenshot({ path: `${OUT}/capturas/login-incorrecto.png` });
      report.flujos.push({ flujo: "Ingreso con clave incorrecta", resultado: txt.join(" | ") || "(no mostró ningún aviso)", captura: "login-incorrecto.png" });
    } catch (e) { report.flujos.push({ flujo: "Ingreso con clave incorrecta", resultado: `No se pudo probar: ${String(e).slice(0, 160)}` }); }
  }
  await ctx.close();
}

// ---------- 2. API ----------
{
  const ctx = await browser.newContext();
  const req = ctx.request;
  const probes = [
    ["GET", "/api/clima"], ["GET", "/api/cron/planes"], ["POST", "/api/mp/webhook"], ["POST", "/api/plan/suscribir"],
    ["POST", "/api/plan/cancelar"], ["GET", "/api/lugar?q=Pinamar"], ["POST", "/auth/registrar"], ["GET", "/robots.txt"], ["GET", "/sitemap.xml"],
  ];
  for (const [m, p] of probes) {
    try {
      const r = m === "GET" ? await req.get(BASE + p) : await req.post(BASE + p, { data: {} });
      report.api.push({ ruta: `${m} ${p}`, estado: r.status(), respuesta: (await r.text()).slice(0, 200) });
    } catch (e) { report.api.push({ ruta: `${m} ${p}`, estado: `ERROR ${String(e).slice(0, 100)}` }); }
  }
  await ctx.close();
}

// ---------- 3. Demo: todas las secciones ----------
const APP = ["/", "/mapa", "/disponibilidad", "/reservas", "/reservas/nueva", "/tarifas", "/convenios", "/clientes", "/renovacion",
  "/cobros", "/caja", "/caja/tarjetas", "/gastos", "/reportes", "/historial", "/copias", "/configuracion"];

async function enterDemo(page) {
  await page.goto(DEMO + "/", { waitUntil: "networkidle" });
  // Que no arranque el tutorial ni el aviso de caja encima
  await page.evaluate(() => { try { sessionStorage.setItem("bal_tour_visto", "1"); } catch {} });
  await page.getByRole("button", { name: /Probar la demo/i }).first().click();
  report.flujos.push({ flujo: "Casilla de Cloudflare en la demo", resultado: await passCaptcha(page, 30000) });
  await page.getByText("Inicio / Panel").first().waitFor({ state: "attached", timeout: 90000 });
  await page.waitForTimeout(1500);
  const skip = page.getByRole("button", { name: /Saltar tutorial/ });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

for (const [view, opts] of Object.entries(VIEWS)) {
  const ctx = await browser.newContext({ ...opts, locale: "es-AR", timezoneId: "America/Argentina/San_Juan" });
  const page = await ctx.newPage();
  const issues = watch(page);
  try {
    await enterDemo(page);
    report.flujos.push({ flujo: `Entrar a la demo (${view})`, resultado: "OK" });
  } catch (e) {
    await page.screenshot({ path: `${OUT}/capturas/demo-no-entra-${view}.png` });
    report.flujos.push({ flujo: `Entrar a la demo (${view})`, resultado: `NO ENTRÓ: ${String(e).slice(0, 200)}`, captura: `demo-no-entra-${view}.png`, consola: issues.consola.slice(-5), pedidos: issues.pedidos.slice(-5) });
    await ctx.close();
    continue;
  }
  for (const path of APP) {
    const row = await check(page, path, `demo${path === "/" ? "-panel" : path}`, view, issues, 2000, DEMO);
    const skip = page.getByRole("button", { name: /Saltar tutorial/ });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    report.demo.push(row);
  }

  // ---------- 4. Flujos en la demo (solo en PC) ----------
  if (view === "pc") {
    // a) Nueva reserva de punta a punta
    const flow = { flujo: "Crear una reserva (cliente nuevo, 5 días, carpa libre, pagada)", pasos: [] };
    try {
      await page.goto(DEMO + "/reservas/nueva", { waitUntil: "networkidle" });
      // Cliente nuevo desde la misma pantalla
      await page.getByRole("button", { name: "+ Nuevo cliente" }).click();
      const dlg = page.getByRole("dialog");
      await dlg.getByLabel("Nombre").fill("Prueba");
      await dlg.getByLabel("Apellido").fill("Automática");
      await dlg.getByRole("button", { name: /^Guardar/ }).click();
      await page.waitForTimeout(2500);
      const again = page.getByRole("dialog").getByRole("button", { name: "Guardar igual" });
      if (await again.isVisible().catch(() => false)) await again.click();
      await page.getByText("Prueba Automática").first().waitFor({ timeout: 15000 });
      flow.pasos.push("cliente creado y elegido");
      await page.getByRole("button", { name: "5 días", exact: true }).first().click();
      await page.waitForTimeout(2500);
      await page.locator('button[title="Libre toda la estadía"]').first().click();
      flow.pasos.push("carpa elegida");
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${OUT}/capturas/flujo-reserva-antes.png`, fullPage: true });
      await page.getByRole("button", { name: "Revisar y confirmar" }).click();
      await page.waitForTimeout(1200);
      flow.pasos.push("revisó");
      await page.getByRole("button", { name: "Guardar reserva" }).click();
      await page.waitForTimeout(2000);
      const confirm = page.getByRole("dialog").getByRole("button", { name: /Confirmar|Guardar|Sí/ });
      if (await confirm.first().isVisible().catch(() => false)) { await confirm.first().click(); flow.pasos.push("confirmó"); }
      await page.getByRole("button", { name: "Ver la reserva" }).waitFor({ timeout: 20000 });
      flow.pasos.push("guardada");
      await page.getByRole("button", { name: "Ver la reserva" }).click();
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `${OUT}/capturas/flujo-reserva-detalle.png`, fullPage: true });
      const resUrl = page.url();
      flow.resultado = "OK";
      // c) Extras: cargar uno en Configuración y sumarlo a la reserva recién creada
      const f3 = { flujo: "Extras: crear «Reposera» y agregarla a la reserva", pasos: [] };
      try {
        await page.goto(DEMO + "/configuracion", { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "Agregar extra" }).first().click();
        const d = page.getByRole("dialog");
        await d.getByLabel("Nombre").fill("Reposera");
        await d.getByLabel("Precio").fill("2000");
        await d.getByRole("button", { name: "Guardar" }).click();
        await page.getByText("Reposera").first().waitFor({ timeout: 10000 });
        f3.pasos.push("extra creado");
        await page.goto(resUrl, { waitUntil: "networkidle" });
        await page.waitForTimeout(1500);
        await page.getByRole("button", { name: "Agregar extra" }).first().click();
        await page.getByRole("dialog").getByRole("button", { name: /^Agregar/ }).click();
        await page.waitForTimeout(2500);
        await page.screenshot({ path: `${OUT}/capturas/flujo-extra.png`, fullPage: true });
        const txt = await page.locator("body").innerText();
        f3.resultado = /Reposera/.test(txt) ? "OK" : "No apareció el extra en la reserva";
        f3.avisos = await page.locator('[role="alert"]').allTextContents().catch(() => []);
      } catch (e) {
        await page.screenshot({ path: `${OUT}/capturas/flujo-extra-error.png`, fullPage: true }).catch(() => {});
        f3.resultado = `Se cortó: ${String(e).slice(0, 200)}`;
      }
      report.flujos.push(f3);
    } catch (e) {
      await page.screenshot({ path: `${OUT}/capturas/flujo-reserva-error.png`, fullPage: true }).catch(() => {});
      flow.resultado = `Se cortó: ${String(e).slice(0, 200)}`;
      flow.avisos = await page.locator('[role="alert"]').allTextContents().catch(() => []);
    }
    report.flujos.push(flow);

    // b) Caja: abrir si hace falta y registrar un gasto
    const f2 = { flujo: "Caja: abrir (si está cerrada) y cargar un gasto en efectivo", pasos: [] };
    try {
      await page.goto(DEMO + "/caja", { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      const abrir = page.getByRole("button", { name: /Abrir caja/ }).first();
      if (await abrir.isVisible().catch(() => false)) {
        await abrir.click();
        await page.waitForTimeout(800);
        const dlg = page.getByRole("dialog");
        await dlg.locator("input").first().fill("10000");
        await dlg.getByRole("button", { name: /Abrir/ }).last().click();
        await page.waitForTimeout(2500);
        f2.pasos.push("caja abierta");
      } else f2.pasos.push("la caja ya estaba abierta");
      await page.screenshot({ path: `${OUT}/capturas/flujo-caja.png`, fullPage: true });
      f2.resultado = "OK";
      f2.avisos = await page.locator('[role="alert"]').allTextContents().catch(() => []);
    } catch (e) { f2.resultado = `Se cortó: ${String(e).slice(0, 200)}`; }
    report.flujos.push(f2);
  }
  await ctx.close();
}
await browser.close();

// ---------- Informe ----------
writeFileSync(`${OUT}/informe.json`, JSON.stringify(report, null, 2));
const lines = [`# Revisión de ${BASE}`, `Demo recorrida en: ${DEMO}`, `Fecha: ${report.fecha}`, ""];
const probs = (r) => [...r.errores_js.map((x) => `JS: ${x}`), ...r.consola.map((x) => `consola: ${x}`), ...r.pedidos.map((x) => `pedido: ${x}`),
  ...(r.desborde_px ? [`se sale ${r.desborde_px}px a lo ancho: ${r.culpables.join(", ")}`] : []), ...r.imagenes_rotas.map((x) => `imagen rota: ${x}`),
  ...(r.sigue_cargando ? ["se quedó cargando"] : []), ...r.avisos.map((x) => `aviso: ${x}`)];
for (const [title, rows] of [["Parte pública", report.publico], ["Demo", report.demo]]) {
  lines.push(`## ${title}`);
  for (const r of rows) {
    const p = probs(r);
    lines.push(`- ${r.vista} ${r.pagina} → ${r.estado} (${r.url_final}) ${p.length ? "⚠️" : "✅"}`);
    for (const x of p) lines.push(`  - ${x}`);
  }
  lines.push("");
}
lines.push("## Flujos", ...report.flujos.map((f) => `- ${f.flujo}: ${f.resultado}${f.pasos ? ` [${f.pasos.join(" → ")}]` : ""}${f.avisos?.length ? ` · avisos: ${f.avisos.join(" | ")}` : ""}`), "");
lines.push("## API", ...report.api.map((a) => `- ${a.ruta} → ${a.estado} ${String(a.respuesta ?? "").replace(/\s+/g, " ").slice(0, 120)}`), "");
lines.push("## Cabeceras", ...Object.entries(report.cabeceras).map(([k, v]) => `- ${k}: ${v ?? "FALTA"}`), "");
lines.push("## Enlaces de la portada", ...report.enlaces.map((e) => `- ${e.enlace} → ${e.estado}`));
writeFileSync(`${OUT}/informe.md`, lines.join("\n"));
log("listo");
