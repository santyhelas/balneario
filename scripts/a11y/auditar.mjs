// Auditoría automática de accesibilidad (axe-core, WCAG 2.1 A/AA) de las pantallas del sistema y de la web.
// La corre .github/workflows/accesibilidad.yml con datos de ejemplo; deja el resultado en la carpeta «accesibilidad».
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.DEMO_URL ?? "http://localhost:3000";
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL, KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const OUT = "accesibilidad"; mkdirSync(OUT, { recursive: true });

const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email: "e2e@prueba.com", password: "Prueba-e2e-123456" }) });
const session = await r.json();
const name = `sb-${new URL(SB).hostname.split(".")[0]}-auth-token`;
const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
const chunks = value.length <= 3180 ? [[name, value]] : value.match(/.{1,3180}/g).map((c, i) => [`${name}.${i}`, c]);
const res = await fetch(`${SB}/rest/v1/reservations?select=id&limit=1`, { headers: { apikey: KEY, Authorization: `Bearer ${session.access_token}` } });
const [una] = await res.json();

const PRIVADAS = ["/", "/mapa", "/disponibilidad", "/reservas", "/reservas/nueva", una ? `/reservas/${una.id}` : null, "/clientes", "/cobros", "/caja", "/gastos", "/tarifas", "/convenios", "/reportes", "/historial", "/copias", "/configuracion"].filter(Boolean);
const PUBLICAS = ["/inicio", "/login", "/guias", "/guias/como-organizar-reservas-de-carpas", "/quienes-somos", "/sistema-para-balnearios/villa-gesell"];
const VISTAS = [
  { id: "celular-claro", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "light" },
  { id: "celular-oscuro", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "dark" },
  { id: "compu-claro", viewport: { width: 1366, height: 860 }, colorScheme: "light" },
];
const browser = await chromium.launch();
const out = [];
for (const v of VISTAS) {
  for (const [lista, login] of [[PRIVADAS, true], [PUBLICAS, false]]) {
    const ctx = await browser.newContext({ ...v, locale: "es-AR", reducedMotion: "reduce" });
    if (login) await ctx.addCookies(chunks.map(([n, val]) => ({ name: n, value: val, domain: new URL(BASE).hostname, path: "/" })));
    const page = await ctx.newPage();
    for (const ruta of lista) {
      try {
        await page.goto(BASE + ruta, { waitUntil: "networkidle", timeout: 45000 });
        await page.waitForTimeout(1500);
        await page.keyboard.press("Escape").catch(() => {}); // cierra el aviso de apertura de caja si aparece
        // Captura para revisar el diseño a ojo (celular claro y compu clara, solo el sistema).
        if (login && v.id !== "celular-oscuro") { mkdirSync(`${OUT}/capturas`, { recursive: true }); await page.screenshot({ path: `${OUT}/capturas/${v.id}${ruta.replace(/\//g, "_").replace(/^_$/, "_panel").slice(0, 40)}.png`, fullPage: v.isMobile === true }).catch(() => {}); }
        const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        for (const x of r.violations) out.push({ vista: v.id, ruta, regla: x.id, impacto: x.impact, ayuda: x.help, nodos: x.nodes.slice(0, 6).map((n) => ({ selector: n.target.join(" "), html: n.html.slice(0, 220), detalle: n.failureSummary?.slice(0, 300) })), total: x.nodes.length });
        console.log(v.id, ruta, r.violations.length);
      } catch (e) { out.push({ vista: v.id, ruta, regla: "error-carga", impacto: "n/a", ayuda: e.message.slice(0, 200), nodos: [], total: 0 }); }
    }
    await ctx.close();
  }
}
await browser.close();
writeFileSync(`${OUT}/resultado.json`, JSON.stringify(out, null, 1));
// Resumen: por regla, cuántas pantallas y elementos.
const por = {};
for (const x of out) { const k = x.regla; por[k] ??= { impacto: x.impacto, ayuda: x.ayuda, pantallas: new Set(), elementos: 0 }; por[k].pantallas.add(`${x.vista} ${x.ruta}`); por[k].elementos += x.total; }
const md = ["# Accesibilidad (axe-core, WCAG 2.1 AA)", "", "| Regla | Impacto | Pantallas | Elementos | Qué pide |", "|---|---|---|---|---|",
  ...Object.entries(por).sort((a, b) => b[1].elementos - a[1].elementos).map(([k, x]) => `| ${k} | ${x.impacto} | ${x.pantallas.size} | ${x.elementos} | ${x.ayuda} |`)];
writeFileSync(`${OUT}/resumen.md`, md.join("\n") + "\n");
console.log(md.join("\n"));
