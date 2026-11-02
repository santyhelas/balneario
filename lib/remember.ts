// "Mantener la sesión iniciada".
// Si está desactivado, las cookies de sesión no tienen vencimiento propio:
// el navegador las borra al cerrarse y hay que volver a ingresar.
export const REMEMBER_COOKIE = "bal_recordar";
export const REMEMBER_MAX_AGE = 60 * 60 * 24 * 400;

type Opts = { maxAge?: number; expires?: Date } & Record<string, unknown>;

export function applyRemember<T extends Opts>(options: T | undefined, remember: boolean): T {
  const o = (options ?? {}) as T;
  // Nunca tocar el borrado de una cookie (maxAge 0).
  if (remember || o.maxAge === 0) return o;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { maxAge, expires, ...rest } = o;
  return rest as T;
}

/** Correo técnico para cuentas creadas solo con usuario (nunca recibe mensajes). */
export const USER_EMAIL_DOMAIN = "usuarios.balneario.invalid";
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
export const normalizeUsername = (u: string) => u.trim().toLowerCase();
