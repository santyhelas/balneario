// Validación de correos: formato, errores de tipeo comunes y (en el servidor) que el dominio reciba correo.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

const TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmal.com": "gmail.com", "gamil.com": "gmail.com", "gmail.co": "gmail.com",
  "gmail.com.ar": "gmail.com", "gnail.com": "gmail.com", "gmaill.com": "gmail.com",
  "hotmial.com": "hotmail.com", "hotmai.com": "hotmail.com", "hotmal.com": "hotmail.com", "hotmail.co": "hotmail.com", "hotmil.com": "hotmail.com",
  "hotmial.com.ar": "hotmail.com.ar", "hotmal.com.ar": "hotmail.com.ar",
  "yaho.com": "yahoo.com", "yahoo.co": "yahoo.com", "yahooo.com": "yahoo.com", "yaho.com.ar": "yahoo.com.ar",
  "outlok.com": "outlook.com", "outllok.com": "outlook.com", "outlook.co": "outlook.com",
  "icloud.co": "icloud.com", "iclod.com": "icloud.com",
};

/** Si el dominio parece mal escrito, devuelve el correo corregido. */
export function emailSuggestion(email: string): string | null {
  const m = /^(.+)@(.+)$/.exec(email.trim().toLowerCase());
  if (!m) return null;
  const fix = TYPOS[m[2]];
  return fix ? `${m[1]}@${fix}` : null;
}
