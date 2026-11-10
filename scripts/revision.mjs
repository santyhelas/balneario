// Revisión automática del sitio en producción (la corre .github/workflows/revision.yml).
// Recorre la presentación, el ingreso y toda la demo en PC y celular, y anota:
// errores de la consola, pedidos que fallan, imágenes rotas, páginas que se salen de la pantalla,
// cargas que no terminan y avisos de error en pantalla. Deja capturas e informe en revision/.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.URL ?? "https://mibalneario.com.ar";
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
  // Panel del dueño (con la cuenta de prueba, que es dueña de la plataforma en la base local)
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
    const f9 = { flujo: `Panel del dueño (${view})`, pasos: [] };
    const ctx3 = await browser.newContext({ ...opts, locale: "es-AR" });
    try {
      const SB = process.env.NEXT_PUBLIC_SUPABASE_URL, KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email: "e2e@prueba.com", password: "Prueba-e2e-123456" }) });
      const session = await r.json();
      f9.pasos.push(`sesión: ${session.access_token ? "ok" : JSON.stringify(session).slice(0, 120)}`);
      const name = `sb-${new URL(SB).hostname.split(".")[0]}-auth-token`;
      const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
      const chunks = value.length <= 3180 ? [[name, value]] : value.match(/.{1,3180}/g).map((c, i) => [`${name}.${i}`, c]);
      const host = new URL(DEMO).hostname;
      await ctx3.addCookies(chunks.map(([n, v]) => ({ name: n, value: v, domain: host, path: "/" })));
      const p3 = await ctx3.newPage();
      const errs = [];
      p3.on("pageerror", (e) => errs.push(String(e)));
      await p3.goto(DEMO + "/admin", { waitUntil: "networkidle" });
      await p3.getByRole("tab", { name: /Balnearios/ }).waitFor({ timeout: 15000 });
      // La caja del día pide abrirse: se deja para después.
      await p3.getByRole("button", { name: "Ahora no" }).click({ timeout: 4000 }).catch(() => {});
      await p3.waitForTimeout(800);
      await p3.screenshot({ path: `${OUT}/capturas/admin-${view}.png`, fullPage: true });
      const cards = await p3.locator("h3").count();
      // ¿Algo se sale de la pantalla?
      const overflow = await p3.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
      await p3.getByRole("tab", { name: /Altas/ }).click();
      await p3.waitForTimeout(500);
      await p3.screenshot({ path: `${OUT}/capturas/admin-altas-${view}.png`, fullPage: true });
      f9.pasos.push(`fichas: ${cards}`, overflow ? "se sale de la pantalla" : "entra en la pantalla", ...errs.map((e) => `error: ${e}`));
      f9.resultado = cards > 0 && !overflow && !errs.length ? "OK" : "Revisar";
    } catch (e) {
      f9.resultado = `Se cortó: ${String(e).slice(0, 160)}`;
      const pg = ctx3.pages()[0];
      if (pg) { f9.pasos.push(`url: ${pg.url()}`); await pg.screenshot({ path: `${OUT}/capturas/admin-error-${view}.png` }).catch(() => {}); }
    }
    await ctx3.close();
    report.flujos.push(f9);
  }
  // Portada con animaciones, como la ve una persona (sin la marca de navegador automático)
  if (view === "pc") {
    const ctx2 = await browser.newContext({ ...opts, locale: "es-AR" });
    await ctx2.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
    const p2 = await ctx2.newPage();
    const errs = [];
    p2.on("pageerror", (e) => errs.push(String(e)));
    try {
      await p2.goto(BASE + "/", { waitUntil: "networkidle" });
      await p2.waitForTimeout(400);
      await p2.screenshot({ path: `${OUT}/capturas/anim-0-entrada.png` });
      const hidden0 = await p2.locator("[data-reveal]:not(.is-in)").count();
      const total = await p2.locator("[data-reveal]").count();
      const H = await p2.evaluate(() => document.body.scrollHeight);
      for (let y = 0, k = 1; y < H; y += 500, k++) {
        await p2.mouse.wheel(0, 500);
        await p2.waitForTimeout(350);
        if (k === 4 || k === 8) await p2.screenshot({ path: `${OUT}/capturas/anim-${k}.png` });
      }
      await p2.waitForTimeout(1000);
      const hidden1 = await p2.locator("[data-reveal]:not(.is-in)").count();
      report.flujos.push({ flujo: "Portada: animaciones al bajar", pasos: [`elementos animados: ${total}`, `escondidos al entrar: ${hidden0}`, `escondidos al llegar abajo: ${hidden1}`, ...errs.map((e) => `error: ${e}`)],
        resultado: total > 10 && hidden0 > 0 && hidden1 === 0 && !errs.length ? "OK" : "Revisar" });
    } catch (e) { report.flujos.push({ flujo: "Portada: animaciones al bajar", pasos: [], resultado: `Se cortó: ${String(e).slice(0, 160)}` }); }
    await ctx2.close();
  }
  // Portada en modo oscuro (con el botón luna)
  try {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Pasar a modo oscuro" }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/capturas/publico-inicio-oscuro-${view}.png`, fullPage: true });
    await page.reload({ waitUntil: "networkidle" });
    const kept = await page.evaluate(() => document.documentElement.getAttribute("data-tb"));
    report.flujos.push({ flujo: `Portada en modo oscuro (${view})`, pasos: [], resultado: kept === "oscuro" ? "OK" : "no se recordó el modo" });
    await page.getByRole("button", { name: "Pasar a modo claro" }).click();
  } catch (e) { report.flujos.push({ flujo: `Portada en modo oscuro (${view})`, pasos: [], resultado: `Se cortó: ${String(e).slice(0, 160)}` }); }
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
        await page.goto(DEMO + "/reservas/nueva", { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "+ Nuevo extra" }).first().click();
        const d = page.getByRole("dialog");
        await d.getByLabel("Nombre").fill("Reposera de prueba");
        await d.getByLabel("Precio").fill("2000");
        await d.getByRole("button", { name: "Guardar" }).click();
        await page.getByText("Reposera de prueba").first().waitFor({ timeout: 10000 });
        f3.pasos.push("extra creado");
        await page.goto(resUrl, { waitUntil: "networkidle" });
        await page.waitForTimeout(1500);
        await page.getByRole("button", { name: "Agregar extra" }).first().click();
        const dlg = page.getByRole("dialog");
        const sel = dlg.locator("select").first();
        if (await sel.count()) await sel.selectOption({ label: await sel.locator("option", { hasText: "Reposera de prueba" }).first().textContent() });
        await dlg.getByRole("button", { name: /^Agregar/ }).click();
        await page.waitForTimeout(2500);
        await page.screenshot({ path: `${OUT}/capturas/flujo-extra.png`, fullPage: true });
        const txt = await page.locator("body").innerText();
        f3.resultado = /Reposera de prueba/.test(txt) ? "OK" : "No apareció el extra en la reserva";
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

    // d) Límite de efectivo: se configura bajo, aparece el aviso y se registra un depósito
    const f4 = { flujo: "Límite de efectivo y depósito", pasos: [] };
    try {
      await page.goto(DEMO + "/configuracion#reglas", { waitUntil: "networkidle" });
      await page.getByLabel("Límite de efectivo en caja").fill("1000");
      await page.getByRole("button", { name: "Guardar" }).filter({ hasText: /^Guardar$/ }).last().click();
      await page.waitForTimeout(2000);
      f4.pasos.push("límite guardado");
      await page.goto(DEMO + "/caja", { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      const alerta = await page.getByText("Hay mucho efectivo en la caja").isVisible().catch(() => false);
      f4.pasos.push(alerta ? "aviso visible" : "SIN AVISO");
      await page.getByRole("button", { name: "Depósito de efectivo" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Registrar depósito" }).click();
      await page.waitForTimeout(2500);
      await page.screenshot({ path: `${OUT}/capturas/flujo-deposito.png`, fullPage: true });
      const ok = await page.getByText("Depósito de efectivo").first().isVisible().catch(() => false);
      f4.resultado = alerta && ok ? "OK" : `Revisar (aviso: ${alerta}, depósito en la lista: ${ok})`;
      f4.avisos = await page.locator('[role="alert"]').allTextContents().catch(() => []);
    } catch (e) {
      await page.screenshot({ path: `${OUT}/capturas/flujo-deposito-error.png`, fullPage: true }).catch(() => {});
      f4.resultado = `Se cortó: ${String(e).slice(0, 200)}`;
    }
    report.flujos.push(f4);

    // f) Cómo sale impreso un reporte (sin colores ni recuadros, con encabezado)
    try {
      await page.goto(DEMO + "/reportes", { waitUntil: "networkidle" });
      await page.waitForTimeout(2000);
      await page.emulateMedia({ media: "print" });
      await page.screenshot({ path: `${OUT}/capturas/impresion-reportes.png`, fullPage: true });
      await page.goto(DEMO + "/caja", { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${OUT}/capturas/impresion-caja.png`, fullPage: true });
      await page.emulateMedia({ media: "screen" });
      report.flujos.push({ flujo: "Vista de impresión (reportes y caja)", resultado: "captura tomada" });
    } catch (e) { report.flujos.push({ flujo: "Vista de impresión", resultado: `Se cortó: ${String(e).slice(0, 160)}` }); }

    // e) Agrandar el plano
    const f5 = { flujo: "Agrandar el plano", pasos: [] };
    try {
      await page.goto(DEMO + "/mapa", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Editar plano" }).click();
      await page.getByRole("button", { name: "Agrandar", exact: true }).click();
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `${OUT}/capturas/flujo-plano.png`, fullPage: true });
      f5.resultado = (await page.getByText("el plano es más grande").count()) ? "OK" : "Revisar: no apareció el aviso";
    } catch (e) { f5.resultado = `Se cortó: ${String(e).slice(0, 200)}`; }
    report.flujos.push(f5);

    // f) Elegir varias carpas con un recuadro, moverlas juntas, copiar y pegar
    const f6 = { flujo: "Plano: varias a la vez, mover y copiar/pegar", pasos: [] };
    try {
      await page.goto(DEMO + "/mapa", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Editar plano" }).click();
      const svg = page.locator('svg[aria-label="Plano del balneario"]');
      const tents = svg.locator('g[role="button"]');
      const pos = async (i) => { const b = await tents.nth(i).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
      const a0 = await pos(0), a1 = await pos(1);
      // Recuadro que encierra las dos primeras (empezando sobre la arena, un poco afuera).
      const x0 = Math.min(a0.x, a1.x) - 30, y0 = Math.min(a0.y, a1.y) - 30, x1 = Math.max(a0.x, a1.x) + 30, y1 = Math.max(a0.y, a1.y) + 30;
      await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 5 }); await page.mouse.move(x1, y1, { steps: 5 }); await page.mouse.up();
      const chosen = await page.getByText(/\d+ elegidas/).textContent({ timeout: 4000 }).catch(() => null);
      f6.pasos.push(chosen ? `recuadro: ${chosen.trim()}` : "recuadro: no eligió nada");
      // Mover el grupo (se mide de nuevo: el plano pudo correrse)
      await page.waitForTimeout(500);
      const before = await pos(0);
      const t0 = await tents.nth(0).getAttribute("transform");
      const b0 = before;
      await page.mouse.move(b0.x, b0.y); await page.mouse.down(); await page.mouse.move(b0.x + 20, b0.y + 20, { steps: 6 }); await page.mouse.move(b0.x + 40, b0.y + 25, { steps: 6 }); await page.mouse.up();
      await page.waitForTimeout(2500);
      const after = await pos(0);
      const moved1 = Math.abs((await pos(1)).x - a1.x) > 5;
      f6.pasos.push(Math.abs(after.x - before.x) > 5 ? `se movió la primera${moved1 ? " y la segunda junto con ella" : " (la segunda NO)"}` : "no se movió");
      // Copiar y pegar: las carpas NO se duplican (solo se mueven)
      const n0 = await tents.count();
      await page.keyboard.press("Control+c");
      await page.keyboard.press("Control+v");
      await page.waitForTimeout(2500);
      const n1 = await tents.count();
      f6.pasos.push(`Ctrl+C/V con carpas: ${n0} → ${n1} espacios`);
      // Límite para achicar
      await page.getByRole("button", { name: "Ver límite" }).click().catch(() => {});
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${OUT}/capturas/flujo-plano-varias.png`, fullPage: true });
      const lim = await svg.getByText("Límite si achicás").count();
      f6.pasos.push(lim ? "límite visible" : "sin límite");
      // Deshacer todo lo editado: la primera vuelve a su lugar
      await page.getByRole("button", { name: "Deshacer todo lo editado" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Dejar como estaba" }).click();
      await page.getByText("quedó como estaba").waitFor({ timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const t1 = await tents.nth(0).getAttribute("transform");
      const restored = t0 === t1;
      f6.pasos.push(restored ? "deshacer: volvió a su lugar" : `deshacer: NO volvió (${t0} → ${t1})`);
      await page.getByRole("button", { name: "Terminar edición" }).click();
      f6.resultado = chosen && Math.abs(after.x - before.x) > 5 && moved1 && n1 === n0 && lim && restored ? "OK" : "Revisar";
    } catch (e) { f6.resultado = `Se cortó: ${String(e).slice(0, 200)}`; }
    report.flujos.push(f6);

    // f2) Tocar una carpa: ventana en el medio; cambiar de lugar y traer a alguien a una libre
    const f6b = { flujo: "Mapa: ficha centrada, cambiar de lugar y traer a alguien", pasos: [] };
    try {
      await page.goto(DEMO + "/mapa", { waitUntil: "networkidle" });
      const svg = page.locator('svg[aria-label="Plano del balneario"]');
      // Pantalla completa: el plano ocupa toda la pantalla
      await page.getByRole("button", { name: "Pantalla completa" }).click();
      await page.waitForTimeout(500);
      const fb = await svg.boundingBox();
      const vp = page.viewportSize();
      f6b.pasos.push(fb && fb.height > vp.height * 0.85 ? "pantalla completa" : `pantalla completa NO (${Math.round(fb?.height ?? 0)}px de ${vp.height})`);
      await page.screenshot({ path: `${OUT}/capturas/mapa-pantalla-completa.png` });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      await svg.locator('g[data-state="ocupada"]').first().click();
      const dlg = page.getByRole("dialog");
      await dlg.waitFor({ timeout: 8000 });
      const bb = await dlg.boundingBox();
      const vw = page.viewportSize();
      const centered = bb && Math.abs(bb.x + bb.width / 2 - vw.width / 2) < 40;
      f6b.pasos.push(centered ? "ventana centrada" : "ventana NO centrada");
      const hasMove = await dlg.getByRole("button", { name: "Cambiar de lugar" }).isVisible();
      const noRotate = !(await dlg.getByRole("button", { name: "Girar 90°" }).count());
      f6b.pasos.push(`cambiar de lugar: ${hasMove ? "sí" : "no"} · girar fuera de edición: ${noRotate ? "no está" : "SIGUE"}`);
      await page.screenshot({ path: `${OUT}/capturas/mapa-ficha-centrada.png` });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      await svg.locator('g[data-state="disponible"]').first().click();
      await dlg.getByRole("button", { name: "Traer a alguien de otra carpa" }).click();
      await dlg.locator("ul button").first().click();
      await page.getByRole("dialog", { name: "Cambiar de carpa" }).waitFor({ timeout: 15000 });
      const preset = await page.getByRole("dialog", { name: "Cambiar de carpa" }).locator("button.bg-accent").count();
      f6b.pasos.push(preset ? "destino ya elegido" : "destino sin elegir");
      await page.screenshot({ path: `${OUT}/capturas/mapa-traer-cliente.png` });
      await page.getByRole("dialog", { name: "Cambiar de carpa" }).getByRole("button", { name: "Confirmar cambio" }).click();
      const okMsg = await page.getByText(/Cambio por el|Cambio desde/).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
      f6b.pasos.push(okMsg ? "cambio registrado" : "sin confirmación");
      f6b.resultado = centered && hasMove && noRotate && preset && okMsg ? "OK" : "Revisar";
    } catch (e) { f6b.resultado = `Se cortó: ${String(e).slice(0, 200)}`; }
    report.flujos.push(f6b);

    // g) Tutorial de novedades: cada paso encuentra lo que explica
    const f7 = { flujo: "Tutorial de novedades", pasos: [] };
    try {
      await page.goto(DEMO + "/", { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      await page.locator("button:visible", { hasText: /^Novedades$/ }).first().click();
      const dlg = page.locator('[role="dialog"][aria-labelledby="tour-titulo"]');
      await page.locator("#tour-titulo").waitFor({ timeout: 8000 }); // el contenedor no tiene tamaño propio
      const total = Number((await dlg.getByText(/Paso \d+ de \d+/).textContent()).match(/de (\d+)/)[1]);
      const sinMarca = [];
      for (let i = 0; i < total; i++) {
        await page.waitForTimeout(2200);
        const title = (await page.locator("#tour-titulo").textContent())?.trim();
        const marked = await dlg.locator(".ring-4").count();
        f7.pasos.push(`${i + 1}. ${title}${marked ? "" : " (sin resaltar)"}`);
        if (!marked) sinMarca.push(title);
        if (i === 2 || i === 3) await page.screenshot({ path: `${OUT}/capturas/novedades-${i + 1}.png` });
        if (i < total - 1) await dlg.getByRole("button", { name: "Siguiente" }).click();
        else await dlg.getByRole("button", { name: /Terminar|Empezar/ }).click();
      }
      // El primero y el último no resaltan nada a propósito.
      const esperado = sinMarca.filter((t) => !/^Novedades de|^¡Eso es todo/.test(t));
      f7.resultado = esperado.length ? `Revisar: ${esperado.join(", ")}` : "OK";
    } catch (e) { f7.resultado = `Se cortó: ${String(e).slice(0, 200)}`; await page.screenshot({ path: `${OUT}/capturas/novedades-error.png` }); }
    report.flujos.push(f7);

    // h) Configuración: marcar el punto exacto en el mapa
    const f8 = { flujo: "Ubicación: mapa para marcar el punto", pasos: [] };
    try {
      await page.goto(DEMO + "/configuracion#balneario", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Marcar el punto exacto en el mapa" }).click();
      const box = page.locator('[aria-label="Mapa para marcar la ubicación del balneario"]');
      await box.waitFor({ timeout: 15000 });
      await page.waitForTimeout(3000);
      const tiles = await box.locator("img.leaflet-tile-loaded").count();
      f8.pasos.push(`mosaicos cargados: ${tiles}`);
      await box.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      const bb = await box.boundingBox();
      await page.mouse.click(bb.x + bb.width * 0.3, bb.y + bb.height * 0.4);
      await page.waitForTimeout(1500);
      const coords = await page.locator("text=/\\(-?\\d+\\.\\d+, -?\\d+\\.\\d+\\)/").first().textContent().catch(() => null);
      f8.pasos.push(`ubicación: ${coords ?? "—"}`);
      await box.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${OUT}/capturas/ubicacion-mapa.png` });
      f8.resultado = tiles > 0 && coords ? "OK" : "Revisar";
    } catch (e) { f8.resultado = `Se cortó: ${String(e).slice(0, 200)}`; }
    report.flujos.push(f8);

    // i) Consultas: se puede escribir en el cuadro de texto (antes el foco saltaba al primer campo)
    const f9 = { flujo: "Consultas: escribir la consulta", pasos: [] };
    try {
      await page.goto(DEMO + "/", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: /Consultas/ }).first().click();
      const d = page.getByRole("dialog", { name: "Consultas" });
      await d.waitFor({ timeout: 10000 });
      const ta = d.locator("textarea");
      await ta.click();
      await page.keyboard.type("Hola, esto es una prueba de consulta");
      const val = await ta.inputValue();
      f9.pasos.push(`texto: «${val}»`);
      const href = await d.getByRole("link", { name: "Enviar por mail" }).getAttribute("href");
      f9.pasos.push(href && href.includes("mibalnearioarg") ? "mail a mibalnearioarg" : `enlace: ${href}`);
      await page.screenshot({ path: `${OUT}/capturas/consultas.png` });
      f9.resultado = val === "Hola, esto es una prueba de consulta" ? "OK" : "Revisar";
      await page.keyboard.press("Escape");
    } catch (e) { f9.resultado = `Se cortó: ${String(e).slice(0, 200)}`; }
    report.flujos.push(f9);

    // j) Campanita: al abrirla se apaga el número; se puede eliminar un aviso
    const f10 = { flujo: "Avisos: abrir apaga el número y se pueden eliminar", pasos: [] };
    try {
      await page.goto(DEMO + "/", { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      const bell = page.locator('button[aria-label^="Avisos"]:visible').first();
      f10.pasos.push(`antes: ${await bell.getAttribute("aria-label")}`);
      await bell.click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${OUT}/capturas/avisos-abiertos.png` });
      const items = page.locator('button[aria-label^="Eliminar aviso"]');
      const n0 = await items.count();
      if (n0) { await items.first().click(); await page.waitForTimeout(500); }
      const n1 = await items.count();
      f10.pasos.push(`avisos: ${n0} → ${n1}`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      const after = await bell.getAttribute("aria-label");
      f10.pasos.push(`después: ${after}`);
      f10.resultado = after === "Avisos" && (n0 === 0 || n1 === n0 - 1) ? "OK" : "Revisar";
    } catch (e) { f10.resultado = `Se cortó: ${String(e).slice(0, 200)}`; }
    report.flujos.push(f10);

    // k) Configuración en apartados desplegables
    const f11 = { flujo: "Configuración: apartados desplegables", pasos: [] };
    try {
      await page.goto(DEMO + "/configuracion", { waitUntil: "networkidle" });
      const n = await page.locator("details").count();
      f11.pasos.push(`apartados: ${n}`);
      await page.screenshot({ path: `${OUT}/capturas/config-cerrada.png`, fullPage: true });
      await page.locator("details#perfil summary").click();
      await page.waitForTimeout(500);
      const tema = await page.locator("details#perfil").getByText("Tema", { exact: true }).isVisible().catch(() => false);
      f11.pasos.push(tema ? "perfil abierto con «Tema»" : "no se ve «Tema»");
      await page.screenshot({ path: `${OUT}/capturas/config-perfil.png`, fullPage: true });
      f11.resultado = n >= 4 && tema ? "OK" : "Revisar";
    } catch (e) { f11.resultado = `Se cortó: ${String(e).slice(0, 200)}`; }
    report.flujos.push(f11);

    // k2) Caja: cerrarla y reabrirla (por si se cerró por error)
    const f14 = { flujo: "Caja: cerrar y reabrir", pasos: [] };
    try {
      await page.goto(DEMO + "/caja", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Cerrar caja" }).first().click();
      const d = page.getByRole("dialog");
      await d.getByLabel("Efectivo contado").fill("1000");
      await d.getByRole("button", { name: /Cerrar caja|Confirmar/ }).last().click();
      await page.getByText("La caja de hoy ya está cerrada").waitFor({ timeout: 15000 });
      f14.pasos.push("cerrada");
      await page.getByRole("button", { name: "Reabrir caja" }).click();
      await page.getByRole("dialog").getByLabel("Motivo").fill("La cerré por error");
      await page.getByRole("dialog").getByRole("button", { name: "Reabrir caja" }).click();
      const reopened = await page.getByRole("button", { name: "Cerrar caja" }).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
      f14.pasos.push(reopened ? "reabierta" : "no se reabrió");
      await page.screenshot({ path: `${OUT}/capturas/caja-reabierta.png`, fullPage: true });
      f14.resultado = reopened ? "OK" : "Revisar";
    } catch (e) { f14.resultado = `Se cortó: ${String(e).slice(0, 200)}`; }
    report.flujos.push(f14);
  }
  await ctx.close();
}

// l) Ingreso: a la tercera contraseña incorrecta aparece el aviso de recuperarla
{
  const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const p2 = await ctx2.newPage();
  const f12 = { flujo: "Ingreso: aviso tras 3 contraseñas incorrectas", pasos: [] };
  try {
    await p2.goto(DEMO + "/login", { waitUntil: "networkidle" });
    for (let i = 0; i < 3; i++) {
      await p2.getByLabel("Usuario").fill("no-existe@ejemplo.com");
      await p2.locator("#pw").fill("incorrecta" + i);
      await p2.getByRole("button", { name: /Ingresar/ }).first().click({ timeout: 40000 });
      await passCaptcha(p2, 20000);
      await p2.waitForTimeout(4000);
    }
    const shown = await p2.getByText("¿Te olvidaste la contraseña?").isVisible().catch(() => false);
    f12.pasos.push(shown ? "aviso visible" : `sin aviso: ${(await p2.locator('[role="alert"]').allInnerTexts()).join(" | ").slice(0, 160)}`);
    await p2.screenshot({ path: `${OUT}/capturas/login-tres-intentos.png` });
    f12.resultado = shown ? "OK" : "Revisar";
  } catch (e) { f12.resultado = `Se cortó: ${String(e).slice(0, 200)}`; }
  report.flujos.push(f12);
  // m) Página de bienvenida sin enlace válido: muestra el error, no se rompe
  const f13 = { flujo: "Bienvenida sin invitación válida", pasos: [] };
  try {
    await p2.goto(DEMO + "/auth/bienvenida", { waitUntil: "networkidle" });
    await p2.waitForTimeout(1500);
    const t = await p2.locator("main").innerText();
    f13.pasos.push(t.replace(/\s+/g, " ").slice(0, 120));
    f13.resultado = /venció|usado/.test(t) ? "OK" : "Revisar";
  } catch (e) { f13.resultado = `Se cortó: ${String(e).slice(0, 200)}`; }
  report.flujos.push(f13);
  await ctx2.close();
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
