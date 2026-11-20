// Datos oficiales de la web.
export const SITE_EMAIL = "mibalnearioarg@gmail.com";
export const SITE_INSTAGRAM = "mibalneario";
export const SITE_INSTAGRAM_URL = `https://www.instagram.com/${SITE_INSTAGRAM}/`;
/** Perfiles oficiales de Mi Balneario en otros sitios: Google los usa para confirmar que la marca es una sola.
 *  Cuando abras Facebook, LinkedIn o el perfil de empresa de Google, agregá acá su dirección. */
export const SITE_SAME_AS: string[] = [SITE_INSTAGRAM_URL];
/** Perfil personal del fundador (no es de la empresa: va en «Quiénes somos», no en SITE_SAME_AS). */
export const SITE_FOUNDER_LINKEDIN = "https://www.linkedin.com/in/santiago-helas-2773b3451/";
/** Clave pública de IndexNow (avisa a Bing y otros buscadores cuando cambian las páginas). No es secreta: se publica en /{clave}.txt. */
export const INDEXNOW_KEY = "dabd12de58689e255b396401ba71f4c1";
/** Dirección pública de la web (para Google, el mapa del sitio y los links al compartir). */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://mibalneario.com.ar").replace(/\/$/, "");
/** WhatsApp de contacto, con código de país y sin espacios (ej: 5492255123456). Se carga en Vercel como NEXT_PUBLIC_WHATSAPP. */
export const SITE_WHATSAPP = (process.env.NEXT_PUBLIC_WHATSAPP || "5492645857461").replace(/\D/g, "");
export const SITE_WHATSAPP_URL = SITE_WHATSAPP
  ? `https://wa.me/${SITE_WHATSAPP}?text=${encodeURIComponent("¡Hola! Quiero un presupuesto del sistema Mi Balneario.")}`
  : "";

/**
 * Enlace para escribir un mail que funciona aunque la compu no tenga un programa de correo:
 * abre la ventana de "Redactar" de Gmail en el navegador, con destinatario, asunto y texto.
 */
export function gmailCompose(to: string, subject = "", body = ""): string {
  let url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}`;
  if (subject) url += `&su=${encodeURIComponent(subject)}`;
  if (body) url += `&body=${encodeURIComponent(body)}`;
  return url;
}
