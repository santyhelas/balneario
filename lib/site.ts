// Datos oficiales de la web.
export const SITE_EMAIL = "tubalnearioar@gmail.com";
export const SITE_INSTAGRAM = "tubalneario";
export const SITE_INSTAGRAM_URL = `https://www.instagram.com/${SITE_INSTAGRAM}/`;
/** Dirección pública de la web (para Google, el mapa del sitio y los links al compartir). */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://balneario-beta.vercel.app").replace(/\/$/, "");
