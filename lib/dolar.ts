// Cotización del dólar del Banco Nación (billetes, compra y venta).

export type Cotizacion = { compra: number; venta: number; fecha: string | null; fuente: string };

/** "1.405,50" o "1405,5000" → 1405.5 */
export function parseArNumber(t: string): number | null {
  const clean = t.trim().replace(/\./g, "").replace(",", ".");
  const n = Number(clean);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Lee la página de Personas del Banco Nación. La primera tabla es la de billetes
 * ("Dolar U.S.A", compra, venta) y su encabezado trae la fecha.
 */
export function parseBnaHtml(html: string): Cotizacion | null {
  const i = html.search(/Dolar\s+U\.?S\.?A/i);
  if (i < 0) return null;
  const nums = [...html.slice(i, i + 600).matchAll(/<td[^>]*>\s*([\d.]+,\d+)\s*<\/td>/gi)].map((m) => parseArNumber(m[1]));
  const [compra, venta] = nums;
  if (!compra || !venta || venta < compra || venta > compra * 1.5) return null;
  const head = html.slice(Math.max(0, i - 1500), i);
  const fm = [...head.matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g)].pop();
  const fecha = fm ? `${fm[3]}-${fm[2].padStart(2, "0")}-${fm[1].padStart(2, "0")}` : null;
  return { compra, venta, fecha, fuente: "Banco Nación" };
}

/**
 * Pesos que equivalen a un monto en dólares, redondeado al centavo igual que la base de datos
 * (se calcula con enteros para evitar errores de coma flotante).
 */
export function usdToArs(usd: number, rate: number): number {
  const cents = Math.round(usd * 100); // dólares en centavos
  const r = Math.round(rate * 10000); // cotización con 4 decimales
  return Math.round((cents * r) / 10000) / 100;
}
