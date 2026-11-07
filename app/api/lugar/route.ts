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
      const body = await nominatim(`search?format=jsonv2&addressdetails=1&limit=6&countrycodes=ar,uy&q=${encodeURIComponent(q)}`);
      return json({ lugares: parsePlaces(body) });
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
