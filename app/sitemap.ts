import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { ZONAS } from "@/lib/zonas";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: "weekly", priority: 1 },
    ...ZONAS.map((z) => ({ url: `${SITE_URL}/sistema-para-balnearios/${z.slug}`, changeFrequency: "monthly" as const, priority: 0.7 })),
    { url: `${SITE_URL}/terminos`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/privacidad`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
