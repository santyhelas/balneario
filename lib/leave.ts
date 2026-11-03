// Salidas a propósito (cerrar sesión, recargar después de restaurar): no hay que preguntar "¿salir del sitio?".
let allowed = false;
export function allowLeave() {
  allowed = true;
}
export function leaveAllowed() {
  return allowed;
}
