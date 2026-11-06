import { json } from "@/lib/auth-server";
import { parseOw, type Ahora, type OwCurrent } from "@/lib/openweather";

// Clima de la ubicación del balneario, desde MET Norway (Instituto Meteorológico de Noruega).
// Datos abiertos (licencia CC BY 4.0, uso comercial permitido con mención de la fuente).
// Se consulta desde el servidor con identificación propia y se guarda 10 minutos, como piden sus condiciones.

type Series = {
  time: string;
  data: {
    instant: { details: Record<string, number> };
    next_1_hours?: { summary: { symbol_code: string }; details: Record<string, number> };
    next_6_hours?: { summary: { symbol_code: string }; details: Record<string, number> };
  };
};

type MetBody = { properties: { meta: { updated_at: string }; timeseries: Series[] } };

// La página consulta cada 2 minutos. MET Norway pide no volver a preguntar antes de la hora
// que indica en "Expires" y usar "If-Modified-Since": así se obtiene el dato nuevo apenas lo
// publican, sin que bloqueen el acceso por consultas de más.
const cache = new Map<string, { body: MetBody; expires: number; lastModified: string | null }>();

async function getForecast(url: string): Promise<MetBody> {
  const hit = cache.get(url);
  if (hit && Date.now() < hit.expires) return hit.body;
  const headers: Record<string, string> = { "User-Agent": "BalnearioGestion/1.0 github.com/santyhelas/balneario", Accept: "application/json" };
  if (hit?.lastModified) headers["If-Modified-Since"] = hit.lastModified;
  let res: Response;
  try {
    res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch {
    if (hit) return hit.body; // sin conexión: se muestra el último dato con su hora real
    throw new Error("El servicio del clima no responde en este momento.");
  }
  const expiresHeader = Date.parse(res.headers.get("expires") ?? "");
  const expires = Number.isFinite(expiresHeader) ? Math.max(expiresHeader, Date.now() + 60_000) : Date.now() + 120_000;
  if (res.status === 304 && hit) {
    hit.expires = expires;
    return hit.body;
  }
  if (!res.ok) {
    if (hit) return hit.body;
    throw new Error(`El servicio del clima respondió con error ${res.status}.`);
  }
  const body = (await res.json()) as MetBody;
  cache.set(url, { body, expires, lastModified: res.headers.get("last-modified") });
  return body;
}


// OpenWeather: clima actual cada ~10 minutos. Se consulta como máximo una vez por minuto.
const owCache = new Map<string, { at: number; data: Ahora | null }>();
/** Estado de OpenWeather para mostrar en pantalla (sin datos sensibles). */
let owStatus: "sin_clave" | "clave_no_activa" | "error" | "ok" = "sin_clave";
async function getOpenWeather(lat: number, lon: number): Promise<Ahora | null> {
  const key = process.env.OPENWEATHER_API_KEY?.trim();
  if (!key) { owStatus = "sin_clave"; return null; }
  const k = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = owCache.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  try {
    const res = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&units=metric&lang=es&appid=${encodeURIComponent(key)}`,
      { cache: "no-store", signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) {
      owStatus = res.status === 401 ? "clave_no_activa" : "error";
      return hit?.data ?? null;
    }
    owStatus = "ok";
    const data = parseOw((await res.json()) as OwCurrent);
    owCache.set(k, { at: Date.now(), data });
    return data;
  } catch {
    owStatus = "error";
    return hit?.data ?? null;
  }
}

// OpenWeather a veces deja el viento "congelado" (mismo valor durante horas aunque cambie la temperatura).
// Se recuerda desde cuándo informa exactamente el mismo viento para no mostrarlo como si fuera actual.
const owWindSeen = new Map<string, { sig: string; since: number }>();
function owWindStuck(k: string, a: Ahora): boolean {
  const sig = `${a.viento_kmh}|${a.viento_desde}|${a.rafagas_kmh}`;
  const prev = owWindSeen.get(k);
  if (!prev || prev.sig !== sig) { owWindSeen.set(k, { sig, since: Date.now() }); return false; }
  return Date.now() - prev.since > 2 * 3600_000;
}


export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return json({ error: "Ubicación inválida. Cargala en Configuración." }, 400);
  }
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  let body: MetBody;
  let ow: Ahora | null = null;
  try {
    const [forecast, owData] = await Promise.all([getForecast(url), getOpenWeather(lat, lon)]);
    body = forecast;
    ow = owData && Date.now() - Date.parse(owData.hora) < 60 * 60_000 ? owData : null;
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "El servicio del clima no responde en este momento." }, 502);
  }
  const series = body.properties?.timeseries ?? [];
  if (series.length === 0) return json({ error: "El servicio del clima no devolvió datos." }, 502);

  // Dato vigente: la última hora que ya empezó.
  const now = Date.now();
  let i = 0;
  while (i + 1 < series.length && Date.parse(series[i + 1].time) <= now) i++;
  const cur = series[i];
  const d = cur.data.instant.details;
  const n1 = cur.data.next_1_hours;
  const n6 = cur.data.next_6_hours;
  const kmh = (ms: number | undefined) => (ms === undefined ? null : Math.round(ms * 3.6));

  // Próximas 12 horas (lluvia y viento) para el resto del día.
  const next = series.slice(i, i + 12).filter((s) => s.data.next_1_hours).map((s) => ({
    time: s.time,
    temp: s.data.instant.details.air_temperature ?? null,
    wind: kmh(s.data.instant.details.wind_speed),
    gust: kmh(s.data.instant.details.wind_speed_of_gust),
    precip: s.data.next_1_hours!.details.precipitation_amount ?? null,
    prob: s.data.next_1_hours!.details.probability_of_precipitation ?? null,
    symbol: s.data.next_1_hours!.summary.symbol_code,
  }));

  // Resumen por día (hora argentina) para los próximos días: máxima, mínima, lluvia, viento e ícono del mediodía.
  const dayOf = (iso: string) => new Date(Date.parse(iso) - 3 * 3600_000).toISOString().slice(0, 10);
  const byDay = new Map<string, { tmax: number; tmin: number; rain: number; wind: number; prob: number | null; symbol: string | null; symHour: number }>();
  for (const s of series) {
    const day = dayOf(s.time);
    const hour = new Date(Date.parse(s.time) - 3 * 3600_000).getUTCHours();
    const t = s.data.instant.details.air_temperature;
    const w = kmh(s.data.instant.details.wind_speed) ?? 0;
    const cur0 = byDay.get(day) ?? { tmax: -99, tmin: 99, rain: 0, wind: 0, prob: null, symbol: null, symHour: 99 };
    if (typeof t === "number") { cur0.tmax = Math.max(cur0.tmax, t); cur0.tmin = Math.min(cur0.tmin, t); }
    cur0.wind = Math.max(cur0.wind, w);
    // Lluvia: por hora si hay dato horario; si no, por bloques de 6 horas (sin contar dos veces).
    if (s.data.next_1_hours) cur0.rain += s.data.next_1_hours.details.precipitation_amount ?? 0;
    else if (s.data.next_6_hours && hour % 6 === 0) cur0.rain += s.data.next_6_hours.details.precipitation_amount ?? 0;
    const pr = s.data.next_1_hours?.details.probability_of_precipitation ?? s.data.next_6_hours?.details.probability_of_precipitation;
    if (typeof pr === "number") cur0.prob = Math.max(cur0.prob ?? 0, pr);
    const sym = s.data.next_1_hours?.summary.symbol_code ?? s.data.next_6_hours?.summary.symbol_code ?? null;
    if (sym && Math.abs(hour - 13) < Math.abs(cur0.symHour - 13)) { cur0.symbol = sym; cur0.symHour = hour; }
    byDay.set(day, cur0);
  }
  const dias = [...byDay.entries()].slice(0, 8).map(([fecha, v]) => ({
    fecha, tmax: v.tmax > -99 ? Math.round(v.tmax) : null, tmin: v.tmin < 99 ? Math.round(v.tmin) : null,
    lluvia_mm: Math.round(v.rain * 10) / 10, prob: v.prob, viento_max: v.wind, simbolo: v.symbol,
  }));

  // "Ahora": OpenWeather si hay dato reciente; si no, el pronóstico. El pronóstico queda para lluvia y próximas horas.
  const fc = {
    temperatura: d.air_temperature ?? null,
    humedad: d.relative_humidity ?? null,
    viento_kmh: kmh(d.wind_speed),
    viento_desde: d.wind_from_direction ?? null,
    simbolo: n1?.summary.symbol_code ?? n6?.summary.symbol_code ?? null,
  };
  const now_ = ow
    ? {
        temperatura: ow.temperatura,
        humedad: ow.humedad ?? fc.humedad,
        viento_kmh: ow.viento_kmh ?? fc.viento_kmh,
        viento_desde: ow.viento_kmh === 0 ? null : ow.viento_desde ?? fc.viento_desde,
        simbolo: ow.simbolo ?? fc.simbolo,
      }
    : fc;

  // Viento: OpenWeather (salvo que su viento esté congelado); si no, el pronóstico.
  const owWindOk = ow && ow.viento_kmh != null && !owWindStuck(`${lat.toFixed(3)},${lon.toFixed(3)}`, ow);
  const wind = owWindOk
    ? { viento_kmh: ow!.viento_kmh, viento_desde: ow!.viento_kmh === 0 ? null : ow!.viento_desde, rafagas_kmh: ow!.rafagas_kmh,
        viento_fuente: { fuente: "OpenWeather", hora: ow!.hora, lugar: ow!.lugar, distancia_km: 0 } }
    : { viento_kmh: fc.viento_kmh, viento_desde: fc.viento_desde, rafagas_kmh: kmh(d.wind_speed_of_gust),
        viento_fuente: { fuente: "Pronóstico", hora: cur.time, lugar: null, distancia_km: 0 } };

  return json({
    openweather: owStatus,
    medido: ow
      ? { fuente: "OpenWeather", estacion: ow.lugar ?? "la zona del balneario", hora: ow.hora, distancia_km: 0, cielo: ow.cielo }
      : null,
    ...now_,
    fuente: "MET Norway",
    actualizado: body.properties.meta.updated_at,
    hora_dato: cur.time,
    ...wind,
    lluvia_1h_mm: n1?.details.precipitation_amount ?? null,
    lluvia_1h_prob: n1?.details.probability_of_precipitation ?? null,
    lluvia_6h_mm: n6?.details.precipitation_amount ?? null,
    lluvia_6h_prob: n6?.details.probability_of_precipitation ?? null,
    proximas: next,
    dias,
  });
}
