/** Reglas de contraseña de Mi Balneario (en el navegador y en el servidor). */
export const PASSWORD_HINT = "(mínimo 8 caracteres, una mayúscula y un número)";

export function passwordWeak(p: string): string | null {
  if (p.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
  if (p.length > 72) return "La contraseña puede tener hasta 72 caracteres.";
  if (!/[A-ZÁÉÍÓÚÑ]/.test(p)) return "La contraseña tiene que tener al menos una mayúscula.";
  if (!/[0-9]/.test(p)) return "La contraseña tiene que tener al menos un número.";
  return null;
}
