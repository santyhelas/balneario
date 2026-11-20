import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { ZONAS_INDEXABLES } from "@/lib/zonas";
import { GUIAS } from "@/lib/guias";

// Fechas reales de la última modificación de cada página (Bing las usa para decidir cuándo volver a pasar).
// Al cambiar el texto de una página, actualizá su fecha acá (las guías la toman de lib/guias.ts).
const INICIO = "2026-11-20";
const ZONAS = "2026-11-20";
const QUIENES_SOMOS = "2026-11-20";
const TERMINOS = "2026-11-06";
const PRIVACIDAD = "2026-11-14";

export default function sitemap(): MetadataRoute.Sitemap {
  const guias = GUIAS.map((g) => g.actualizado).sort();
  return [
    { url: `${SITE_URL}/`, lastModified: INICIO, changeFrequency: "weekly", priority: 1 },
    ...ZONAS_INDEXABLES.map((z) => ({ url: `${SITE_URL}/sistema-para-balnearios/${z.slug}`, lastModified: ZONAS, changeFrequency: "monthly" as const, priority: 0.7 })),
    { url: `${SITE_URL}/guias`, lastModified: guias[guias.length - 1], changeFrequency: "monthly", priority: 0.6 },
    ...GUIAS.map((g) => ({ url: `${SITE_URL}/guias/${g.slug}`, lastModified: g.actualizado, changeFrequency: "monthly" as const, priority: 0.6 })),
    { url: `${SITE_URL}/quienes-somos`, lastModified: QUIENES_SOMOS, changeFrequency: "yearly", priority: 0.4 },
    { url: `${SITE_URL}/terminos`, lastModified: TERMINOS, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/privacidad`, lastModified: PRIVACIDAD, changeFrequency: "yearly", priority: 0.3 },
  ];
}
