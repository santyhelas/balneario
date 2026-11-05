// Capturas de la página de presentación (las usa .github/workflows/capturas.yml).
import { chromium } from "playwright";
const base = process.env.URL ?? "http://localhost:3000";
const browser = await chromium.launch();
for (const [name, opts] of [
  ["escritorio", { viewport: { width: 1366, height: 860 } }],
  ["celular", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
]) {
  const page = await browser.newPage({ ...opts, reducedMotion: "reduce" });
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `capturas/${name}-completa.png`, fullPage: true });
  await page.screenshot({ path: `capturas/${name}-arriba.png` });
  await page.getByRole("tab", { name: "En una semana" }).click();
  await page.screenshot({ path: `capturas/${name}-semana.png` });
  await page.locator("#tb-hora").fill("3");
  await page.locator("#un-dia").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `capturas/${name}-un-dia.png` });
  await page.locator("#funciones").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `capturas/${name}-funciones-1.png` });
  await page.getByRole("button", { name: "Siguiente" }).click();
  await page.getByRole("button", { name: "Siguiente" }).click();
  await page.getByRole("button", { name: "Siguiente" }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `capturas/${name}-funciones-4.png` });
  await page.close();
}
await browser.close();
