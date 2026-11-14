// Convierte los errores técnicos en mensajes claros en español.
// Los mensajes de las reglas de negocio ya vienen en español desde la base.

type MaybeError = { message?: string; code?: string; hint?: string | null; details?: string | null } | null | undefined;

export function friendlyError(err: unknown): string {
  const e = err as MaybeError;
  const msg = e?.message ?? (err instanceof Error ? err.message : String(err ?? ""));

  if (/failed to fetch|networkerror|load failed|fetch failed/i.test(msg)) {
    return "No hay conexión con el servidor. Revisá internet: la operación NO se guardó.";
  }
  if (e?.code === "40001" || e?.hint === "CONFLICTO_VERSION") {
    return "Este dato fue modificado desde otro dispositivo. Se recargó la información: revisala e intentá de nuevo.";
  }
  if (e?.code === "42501" && /permission denied|row-level security/i.test(msg)) {
    return "No tenés permiso para realizar esta operación.";
  }
  if (e?.code === "23505") {
    return "Ya existe un registro con ese mismo dato (por ejemplo, un código de carpa repetido).";
  }
  if (e?.code === "23P01" && /exclusion constraint/i.test(msg)) {
    return "Ese espacio ya está ocupado en esas fechas.";
  }
  if (/JWT|not authenticated|Tenés que iniciar sesión/i.test(msg)) {
    return "Tu sesión venció. Volvé a iniciar sesión.";
  }
  if (/invalid login credentials/i.test(msg)) return "Correo o contraseña incorrectos.";
  if (/email not confirmed/i.test(msg)) return "Todavía no confirmaste tu correo. Revisá tu bandeja de entrada.";
  if (/user already registered/i.test(msg)) return "Ya existe una cuenta con ese correo. Iniciá sesión.";
  if (/password should be at least/i.test(msg)) return "La contraseña debe tener al menos 8 caracteres.";
  if (/different from the old password/i.test(msg)) return "Esa contraseña es la que ya tenías. Elegí una distinta.";
  if (/rate limit/i.test(msg)) return "Demasiados intentos seguidos. Esperá unos minutos.";
  return msg || "Ocurrió un error inesperado. La operación no se guardó.";
}

export function isVersionConflict(err: unknown): boolean {
  const e = err as MaybeError;
  return e?.code === "40001" || e?.hint === "CONFLICTO_VERSION";
}
