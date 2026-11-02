// Formatos regionales: Argentina, pesos, DD/MM/AAAA, zona San Juan.
export const TIMEZONE = "America/Argentina/San_Juan";

const ars = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** $ 150.000 — acepta number o string (PostgreSQL devuelve numeric como texto o número). */
export function formatMoney(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return ars.format(n);
}

/** Convierte lo que escribe el usuario ("150.000", "150000,50", "$ 1.200") a número, o null si es inválido. */
export function parseMoney(input: string): number | null {
  const clean = input.replace(/[$\s]/g, "");
  if (clean === "") return null;
  // Formato argentino: punto = miles, coma = decimales.
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(clean)) return null;
  const n = Number(clean.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** "2027-01-04" → "04/01/2027". Trabaja con la fecha como texto para no mover el día por zona horaria. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "—";
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** "04/01/2027" → "2027-01-04", o null si no es una fecha real. */
export function parseDate(input: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input.trim());
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Fecha de hoy (AAAA-MM-DD) en la zona horaria del balneario. */
export function todayISO(timeZone: string = TIMEZONE, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts; // en-CA ya da AAAA-MM-DD
}

/** Suma días a una fecha AAAA-MM-DD sin problemas de horario de verano. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** Días entre dos fechas inclusive (1 al 5 = 5 días). */
export function inclusiveDays(fromISO: string, toISO: string): number {
  const a = Date.parse(fromISO + "T00:00:00Z");
  const b = Date.parse(toISO + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Hora local "14:05" de un timestamp. */
export function formatTime(ts: string | null | undefined, timeZone: string = TIMEZONE): string {
  if (!ts) return "—";
  return new Intl.DateTimeFormat("es-AR", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(ts),
  );
}

export function formatDateTime(ts: string | null | undefined, timeZone: string = TIMEZONE): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const date = new Intl.DateTimeFormat("es-AR", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
  return `${date} ${formatTime(ts, timeZone)}`;
}

export function formatTemperature(celsius: number, unit: "C" | "F"): string {
  const v = unit === "F" ? celsius * 9 / 5 + 32 : celsius;
  return `${Math.round(v)}°${unit}`;
}
