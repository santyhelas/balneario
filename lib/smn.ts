// Observaciones reales del Servicio Meteorológico Nacional (SMN, Argentina):
// "Estado del tiempo presente", último registro horario de cada estación.
// Archivo: https://ssl.smn.gob.ar/dpd/zipopendata.php?dato=tiepre (zip con un .txt, separado por ";").
// Cada renglón: estación; fecha; hora; estado del cielo; visibilidad; temperatura; sensación térmica;
// humedad; viento (dirección y km/h, o "Calma"); presión.
// Si el formato cambia, el parser devuelve null y la página sigue con el pronóstico (nunca inventa datos).

import { inflateRawSync } from "node:zlib";

export type Observacion = {
  estacion: string;
  hora: string; // ISO con zona horaria argentina
  cielo: string | null;
  temperatura: number | null;
  sensacion: number | null;
  humedad: number | null;
  viento_kmh: number | null;
  viento_desde: number | null; // grados, de dónde viene
  presion: number | null;
  distancia_km: number;
};

/** Estaciones del SMN cercanas a la costa bonaerense (nombre para buscar en el archivo y ubicación aproximada). */
export const STATIONS: { key: string; lat: number; lon: number }[] = [
  { key: "villa gesell", lat: -37.235, lon: -57.029 },
  { key: "mar del plata", lat: -37.934, lon: -57.573 },
  { key: "dolores", lat: -36.351, lon: -57.734 },
  { key: "punta indio", lat: -35.37, lon: -57.28 },
  { key: "tandil", lat: -37.237, lon: -59.228 },
  { key: "necochea", lat: -38.57, lon: -58.73 },
  { key: "benito juarez", lat: -37.71, lon: -59.79 },
  { key: "azul", lat: -36.837, lon: -59.88 },
  { key: "la plata", lat: -34.968, lon: -57.895 },
  { key: "aeroparque", lat: -34.558, lon: -58.416 },
  { key: "ezeiza", lat: -34.822, lon: -58.536 },
  { key: "bahia blanca", lat: -38.733, lon: -62.167 },
];

const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

const DIRS: Record<string, number> = {
  norte: 0, nornoreste: 22.5, noreste: 45, estenoreste: 67.5, este: 90, estesudeste: 112.5, sudeste: 135, sudsudeste: 157.5,
  sur: 180, sudsudoeste: 202.5, sudoeste: 225, oestesudoeste: 247.5, oeste: 270, oestenoroeste: 292.5, noroeste: 315, nornoroeste: 337.5,
};

const MONTHS: Record<string, number> = {
  ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12,
};

function num(t: string | undefined): number | null {
  if (!t) return null;
  const m = /-?\d+(?:[.,]\d+)?/.exec(t);
  return m ? Number(m[0].replace(",", ".")) : null;
}

export function parseWind(t: string): { kmh: number | null; from: number | null } {
  const s = norm(t);
  if (!s) return { kmh: null, from: null };
  if (s.startsWith("calma")) return { kmh: 0, from: null };
  const m = /^([a-z]+)\s+(\d+)/.exec(s);
  if (!m || !(m[1] in DIRS)) return { kmh: num(s), from: null };
  return { kmh: Number(m[2]), from: DIRS[m[1]] };
}

/** "02-Nov-2026" + "13:00" → "2026-11-02T13:00:00-03:00" */
export function parseWhen(date: string, time: string): string | null {
  const d = /^(\d{1,2})[-/ ]([A-Za-z]{3})[a-z]*[-/ ](\d{4})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})/.exec(time.trim());
  if (!d || !t) return null;
  const mo = MONTHS[d[2].toLowerCase()];
  if (!mo) return null;
  return `${d[3]}-${String(mo).padStart(2, "0")}-${d[1].padStart(2, "0")}T${t[1].padStart(2, "0")}:${t[2]}:00-03:00`;
}

function distKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const x = (bLon - aLon) * r * Math.cos(((aLat + bLat) / 2) * r);
  const y = (bLat - aLat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}

/** Busca en el texto del SMN la estación más cercana (hasta 100 km) y lee su último registro. */
export function parseTiepre(text: string, lat: number, lon: number): Observacion | null {
  const lines = text.split(/\r?\n/).map((l) => l.split(";").map((c) => c.trim())).filter((c) => c.length >= 9);
  const candidates = STATIONS
    .map((s) => ({ ...s, d: distKm(lat, lon, s.lat, s.lon) }))
    .filter((s) => s.d <= 100)
    .sort((a, b) => a.d - b.d);
  for (const st of candidates) {
    const row = lines.find((c) => norm(c[0]).includes(st.key));
    if (!row) continue;
    const hora = parseWhen(row[1], row[2]);
    const temperatura = num(row[5]);
    if (!hora || temperatura === null || temperatura < -30 || temperatura > 50) continue;
    const wind = parseWind(row[8] ?? "");
    return {
      estacion: row[0].replace(/\s+/g, " "),
      hora,
      cielo: row[3] || null,
      temperatura,
      sensacion: num(row[6]),
      humedad: num(row[7]),
      viento_kmh: wind.kmh,
      viento_desde: wind.from,
      presion: num(row[9]),
      distancia_km: Math.round(st.d),
    };
  }
  return null;
}

/** Saca el primer archivo de un .zip (sin dependencias). */
export function unzipFirst(buf: Buffer): Buffer | null {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) return null;
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
  const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
  const data = buf.subarray(start, start + compSize);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return inflateRawSync(data);
  return null;
}
