import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Le dice a Google qué puede mirar: la presentación sí; el sistema y las funciones internas no.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/", "/inicio"], disallow: ["/api/", "/auth/"] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
