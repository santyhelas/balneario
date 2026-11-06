// Datos oficiales de la web.
export const SITE_EMAIL = "mibalnearioarg@gmail.com";
export const SITE_INSTAGRAM = "tubalneario";
export const SITE_INSTAGRAM_URL = `https://www.instagram.com/${SITE_INSTAGRAM}/`;
/** Dirección pública de la web (para Google, el mapa del sitio y los links al compartir). */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://balneario-beta.vercel.app").replace(/\/$/, "");
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
  const p = new URLSearchParams({ view: "cm", fs: "1", to });
  if (subject) p.set("su", subject);
  if (body) p.set("body", body);
  return `https://mail.google.com/mail/?${p.toString()}`;
}
