import { json } from "@/lib/auth-server";
import { parsePlaces, placeLabel } from "@/lib/places";
import { SITE_EMAIL } from "@/lib/site";

export const runtime = "nodejs";

// Buscar un lugar por nombre (?q=) o ponerle nombre a una ubicación (?lat=&lon=).
// Solo para usuarios con sesión (lo controla el middleware). Se guarda en memoria un día.
const cache = new Map<string, { at: number; body: unknown }>();
const UA = `MiBalneario/1.0 (${SITE_EMAIL})`;

async function nominatim(path: string): Promise<unknown> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.body;
  const res = await fetch(`https://nominatim.openstreetmap.org/${path}`, {
    headers: { "User-Agent": UA, "Accept-Language": "es" }, cache: "no-store", signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = await res.json();
  cache.set(path, { at: Date.now(), body });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return body;
}

type OmItem = { name: string; latitude: number; longitude: number; admin1?: string; admin2?: string; country_code?: string };
async function openMeteo(q: string) {
  const out: { label: string; lat: number; lon: number }[] = [];
  for (const cc of ["AR", "UY"]) {
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=es&format=json&countryCode=${cc}`,
        { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const b = (await r.json()) as { results?: OmItem[] };
      for (const it of b.results ?? []) {
        const parts = [it.name, it.admin2, it.admin1].filter((x): x is string => !!x).filter((x, i, a) => a.indexOf(x) === i);
        out.push({ label: parts.join(", "), lat: Math.round(it.latitude * 1e5) / 1e5, lon: Math.round(it.longitude * 1e5) / 1e5 });
      }
    } catch { /* sin respaldo */ }
    if (out.length >= 6) break;
  }
  return out.slice(0, 6);
}

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const q = p.get("q")?.trim() ?? "";
  // Ubicación aproximada de la conexión (la da Vercel): para cuando el navegador no puede ubicarse.
  if (p.get("ip") === "1") {
    const h = req.headers;
    const lat = Number(h.get("x-vercel-ip-latitude"));
    const lon = Number(h.get("x-vercel-ip-longitude"));
    if (!h.get("x-vercel-ip-latitude") || !Number.isFinite(lat) || !Number.isFinite(lon)) return json({ lat: null, lon: null, ciudad: null });
    let ciudad: string | null = null;
    try { ciudad = decodeURIComponent(h.get("x-vercel-ip-city") ?? "") || null; } catch { ciudad = null; }
    // Nombre completo («Rivadavia, San Juan») a partir del punto.
    try {
      const body = (await nominatim(`reverse?format=jsonv2&addressdetails=1&zoom=10&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`)) as { error?: string };
      if (body && !body.error) ciudad = placeLabel(body as never) || ciudad;
    } catch { /* queda la ciudad que dio Vercel */ }
    return json({ lat, lon, ciudad });
  }
  try {
    if (q) {
      if (q.length < 3 || q.length > 120) return json({ error: "Escribí al menos 3 letras." }, 400);
      // OpenStreetMap a veces rechaza las consultas desde servidores en la nube: si falla o no encuentra,
      // se busca la ciudad en Open-Meteo (el mismo servicio del clima) y después se afina en el mapa.
      let lugares: ReturnType<typeof parsePlaces> = [];
      try {
        lugares = parsePlaces(await nominatim(`search?format=jsonv2&addressdetails=1&limit=6&countrycodes=ar,uy&q=${encodeURIComponent(q)}`));
      } catch { /* se prueba el respaldo */ }
      if (lugares.length === 0) lugares = await openMeteo(q);
      return json({ lugares });
    }
    const lat = Number(p.get("lat"));
    const lon = Number(p.get("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: "Ubicación inválida." }, 400);
    const body = (await nominatim(`reverse?format=jsonv2&addressdetails=1&zoom=14&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`)) as { lat?: string; error?: string };
    if (!body || body.error) return json({ nombre: null });
    return json({ nombre: placeLabel(body as never) });
  } catch {
    return json({ error: "No se pudo buscar el lugar en este momento. Probá de nuevo en un rato." }, 502);
  }
}
