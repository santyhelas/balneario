// Capturas de pantalla para el reel «3 cosas que te ahorran plata» (las corre .github/workflows/capturas-video.yml).
// Celular 390×844 a 2x, con datos de ejemplo cargados por scripts/video/datos.sql.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const DEMO = process.env.DEMO_URL ?? "http://localhost:3000";
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL, KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const OUT = "capturas-video";
mkdirSync(OUT, { recursive: true });

const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email: "e2e@prueba.com", password: "Prueba-e2e-123456" }) });
const session = await r.json();
const name = `sb-${new URL(SB).hostname.split(".")[0]}-auth-token`;
const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
const chunks = value.length <= 3180 ? [[name, value]] : value.match(/.{1,3180}/g).map((c, i) => [`${name}.${i}`, c]);

const browser = await chromium.launch();
async function run(theme) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: "es-AR", colorScheme: theme });
  await ctx.addCookies(chunks.map(([n, v]) => ({ name: n, value: v, domain: new URL(DEMO).hostname, path: "/" })));
  const page = await ctx.newPage();
  const shot = async (f, full = false) => { await page.waitForTimeout(900); await page.screenshot({ path: `${OUT}/${theme}-${f}.png`, fullPage: full }); console.log(theme, f); };

  // 1) Ficha con dos precios (lista y efectivo)
  const res = await fetch(`${SB}/rest/v1/reservations?select=id,customers!inner(first_name)&customers.first_name=eq.Paula`, { headers: { apikey: KEY, Authorization: `Bearer ${session.access_token}` } });
  const [paula] = await res.json();
  await page.goto(`${DEMO}/reservas/${paula.id}`, { waitUntil: "networkidle" });
  await page.getByText("Pagando en efectivo").first().waitFor({ timeout: 20000 }).catch(() => console.log("sin línea de efectivo"));
  await shot("1-ficha", true);
  const precio = page.getByRole("heading", { name: "Precio" }).first();
  await precio.scrollIntoViewIfNeeded().catch(() => {});
  await shot("1-ficha-precio");

  // 2) Avisos: deudas que se acercan
  await page.goto(`${DEMO}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await shot("2-panel");
  await page.locator('button[aria-label^="Avisos"]:visible').first().click();
  await shot("2-avisos");
  await page.goto(`${DEMO}/cobros`, { waitUntil: "networkidle" });
  await shot("2-cobros");

  // 3) Caja: efectivo esperado y cierre
  await page.goto(`${DEMO}/caja`, { waitUntil: "networkidle" });
  await shot("3-caja");
  await shot("3-caja-larga", true);
  await page.getByRole("button", { name: "Cerrar caja" }).first().click();
  await page.waitForTimeout(800);
  const field = page.getByLabel("Efectivo contado");
  const expected = await page.evaluate(() => {
    const m = document.body.innerText.match(/Efectivo esperado\s*\$\s*([\d.]+)/);
    return m ? m[1].replace(/\./g, "") : "220000";
  });
  await field.fill(expected);
  await shot("3-cierre");

  // Extra: mapa y nueva reserva
  await page.keyboard.press("Escape");
  await page.goto(`${DEMO}/mapa`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await shot("4-mapa");
  await ctx.close();
}
await run("light");
await run("dark");
await browser.close();
