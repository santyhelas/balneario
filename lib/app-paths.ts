// Primeras partes de las direcciones de las pantallas del sistema (las que piden sesión).
// Sin sesión, estas llevan a la presentación; cualquier otra dirección desconocida da «página no encontrada» (404),
// así Google no toma direcciones inventadas como copias del inicio.
// Si se agrega una pantalla nueva, sumarla acá (lo controla lib/app-paths.test.ts).
export const APP_SECTIONS = [
  "admin", "caja", "clientes", "cobros", "configuracion", "convenios", "copias", "disponibilidad",
  "gastos", "historial", "mapa", "renovacion", "reportes", "reservas", "tarifas", "dueno",
];

export function isAppPath(path: string): boolean {
  const first = path.split("/")[1] ?? "";
  return APP_SECTIONS.includes(first);
}
