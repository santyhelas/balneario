import { json } from "@/lib/auth-server";
import { parseBnaHtml, type Cotizacion } from "@/lib/dolar";

// Cotización del dólar (billetes) del Banco Nación. Se consulta desde el servidor
// y se guarda 5 minutos. Si la página del banco no responde, se usa DolarApi
// (que publica la cotización oficial del Banco Nación). Si ninguna responde,
// se informa el error: nunca se inventa una cotización.

async function fromBna(): Promise<Cotizacion | null> {
  const res = await fetch("https://www.bna.com.ar/Personas", {
    headers: { "User-Agent": "Mozilla/5.0 (BalnearioGestion)", Accept: "text/html" },
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return parseBnaHtml(await res.text());
}

async function fromDolarApi(): Promise<Cotizacion | null> {
  const res = await fetch("https://dolarapi.com/v1/dolares/oficial", {
    headers: { Accept: "application/json" },
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const d = (await res.json()) as { compra?: number; venta?: number; fechaActualizacion?: string };
  if (!(Number(d.compra) > 0) || !(Number(d.venta) > 0)) return null;
  return { compra: Number(d.compra), venta: Number(d.venta), fecha: d.fechaActualizacion?.slice(0, 10) ?? null, fuente: "Banco Nación (vía DolarApi)" };
}

export async function GET() {
  for (const source of [fromBna, fromDolarApi]) {
    try {
      const c = await source();
      if (c) return json({ ...c, consultado: new Date().toISOString() });
    } catch {
      /* se prueba la siguiente fuente */
    }
  }
  return json({ error: "No se pudo obtener la cotización del Banco Nación. Podés cargarla a mano." }, 502);
}
