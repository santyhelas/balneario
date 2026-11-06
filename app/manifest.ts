import type { MetadataRoute } from "next";

// Permite instalar el sistema como app en Android (Chrome) e iPhone (Safari → Agregar a inicio).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Mi Balneario",
    short_name: "Mi Balneario",
    description: "Mi Balneario: reservas, mapa, caja y clientes de tu balneario.",
    lang: "es-AR",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f6f3ec",
    theme_color: "#0b6a87",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Nueva reserva", url: "/reservas/nueva", icons: [{ src: "/icon-192.png", sizes: "192x192" }] },
      { name: "Mapa", url: "/mapa", icons: [{ src: "/icon-192.png", sizes: "192x192" }] },
      { name: "Caja", url: "/caja", icons: [{ src: "/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
