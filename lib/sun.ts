// Posición del sol (aproximación astronómica, precisión de ~1°) y salida/puesta, calculadas localmente.
const rad = Math.PI / 180;

export function sunPosition(date: Date, lat: number, lon: number): { azimuth: number; elevation: number } {
  const d = date.getTime() / 86_400_000 - 10957.5; // días desde J2000
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = ((gmst * 15 + lon) * rad - ra);
  const phi = lat * rad;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { azimuth: ((az / rad) + 360) % 360, elevation: el / rad };
}

/** Salida y puesta del sol del día que contiene `date` (búsqueda minuto a minuto, en hora local del navegador). */
export function sunTimes(date: Date, lat: number, lon: number): { sunrise: Date | null; sunset: Date | null } {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  let sunrise: Date | null = null;
  let sunset: Date | null = null;
  let prev = sunPosition(start, lat, lon).elevation;
  for (let m = 5; m <= 1440; m += 5) {
    const t = new Date(start.getTime() + m * 60_000);
    const el = sunPosition(t, lat, lon).elevation;
    if (prev < -0.833 && el >= -0.833 && !sunrise) sunrise = t;
    if (prev >= -0.833 && el < -0.833 && sunrise) sunset = t;
    prev = el;
  }
  return { sunrise, sunset };
}

const POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
const NAMES: Record<string, string> = {
  N: "norte", NNE: "nornoreste", NE: "noreste", ENE: "estenoreste", E: "este", ESE: "estesudeste", SE: "sudeste", SSE: "sudsudeste",
  S: "sur", SSO: "sudsudoeste", SO: "sudoeste", OSO: "oestesudoeste", O: "oeste", ONO: "oestenoroeste", NO: "noroeste", NNO: "nornoroeste",
};
export function cardinal(deg: number): string {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}
export function cardinalName(deg: number): string {
  return NAMES[cardinal(deg)];
}
