// Búsqueda de lugares con OpenStreetMap (Nominatim). Uso gratuito con mención de la fuente,
// identificándose y sin consultas automáticas mientras se escribe (por eso se busca al tocar «Buscar»).

export type Place = { label: string; lat: number; lon: number };

type NomItem = { lat: string; lon: string; display_name?: string; name?: string; address?: Record<string, string> };

/** Nombre corto y entendible: "Punta Mogotes, General Pueyrredón, Buenos Aires". */
export function placeLabel(it: NomItem): string {
  const a = it.address ?? {};
  const first = it.name || a.beach || a.suburb || a.neighbourhood || a.village || a.town || a.city || a.hamlet || "";
  const parts = [first, a.city ?? a.town ?? a.village ?? a.county, a.state].filter((x): x is string => !!x);
  const uniq = parts.filter((p, i) => parts.indexOf(p) === i);
  if (uniq.length) return uniq.join(", ");
  return (it.display_name ?? "").split(",").slice(0, 3).map((s) => s.trim()).join(", ");
}

export function parsePlaces(body: unknown): Place[] {
  if (!Array.isArray(body)) return [];
  return body
    .map((it: NomItem) => ({ label: placeLabel(it), lat: Number(it.lat), lon: Number(it.lon) }))
    .filter((p) => p.label && Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .map((p) => ({ ...p, lat: Math.round(p.lat * 1e5) / 1e5, lon: Math.round(p.lon * 1e5) / 1e5 }));
}
