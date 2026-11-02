import { json } from "@/lib/auth-server";
import { parseTiepre, unzipFirst, type Observacion } from "@/lib/smn";

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

// Mediciones reales del SMN (se publican cada hora). Se guardan 10 minutos.
let smnCache: { at: number; text: string } | null = null;
async function getSmnText(): Promise<string | null> {
  if (smnCache && Date.now() - smnCache.at < 10 * 60_000) return smnCache.text;
  try {
    const res = await fetch("https://ssl.smn.gob.ar/dpd/zipopendata.php?dato=tiepre", {
      headers: { "User-Agent": "BalnearioGestion/1.0" }, cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return smnCache?.text ?? null;
    const raw = unzipFirst(Buffer.from(await res.arrayBuffer()));
    if (!raw) return smnCache?.text ?? null;
    smnCache = { at: Date.now(), text: new TextDecoder("latin1").decode(raw) };
    return smnCache.text;
  } catch {
    return smnCache?.text ?? null;
  }
}

/** Estado del cielo del SMN → código de ícono (mismo formato que MET Norway). */
function skyToSymbol(cielo: string | null, hourLocal: number): string | null {
  if (!cielo) return null;
  const c = cielo.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const dn = hourLocal >= 7 && hourLocal < 20 ? "_day" : "_night";
  if (c.includes("tormenta")) return "rainandthunder";
  if (c.includes("chaparr")) return "rainshowers" + dn;
  if (c.includes("llovizna")) return "lightrain";
  if (c.includes("lluvia")) return "rain";
  if (c.includes("niebla") || c.includes("neblina")) return "fog";
  if (c.includes("despejado")) return "clearsky" + dn;
  if (c.includes("algo nublado")) return "fair" + dn;
  if (c.includes("parcialmente")) return "partlycloudy" + dn;
  if (c.includes("nublado") || c.includes("cubierto")) return "cloudy";
  return null;
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
  let medido: Observacion | null = null;
  try {
    const [forecast, smnText] = await Promise.all([getForecast(url), getSmnText()]);
    body = forecast;
    medido = smnText ? parseTiepre(smnText, lat, lon) : null;
    // Una medición de hace más de 3 horas ya no sirve como "ahora".
    if (medido && Date.now() - Date.parse(medido.hora) > 3 * 3600_000) medido = null;
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

  // Si hay medición real del SMN, manda para "ahora"; el pronóstico queda para lluvia y próximas horas.
  const fc = {
    temperatura: d.air_temperature ?? null,
    humedad: d.relative_humidity ?? null,
    viento_kmh: kmh(d.wind_speed),
    viento_desde: d.wind_from_direction ?? null,
    simbolo: n1?.summary.symbol_code ?? n6?.summary.symbol_code ?? null,
  };
  const hourLocal = medido ? Number(medido.hora.slice(11, 13)) : 12;
  const now_ = medido
    ? {
        temperatura: medido.temperatura ?? fc.temperatura,
        humedad: medido.humedad ?? fc.humedad,
        viento_kmh: medido.viento_kmh ?? fc.viento_kmh,
        viento_desde: medido.viento_kmh === 0 ? null : medido.viento_desde ?? fc.viento_desde,
        simbolo: skyToSymbol(medido.cielo, hourLocal) ?? fc.simbolo,
      }
    : fc;

  return json({
    medido: medido && { estacion: medido.estacion, hora: medido.hora, distancia_km: medido.distancia_km, cielo: medido.cielo },
    ...now_,
    fuente: "MET Norway",
    actualizado: body.properties.meta.updated_at,
    hora_dato: cur.time,
    // El SMN no informa ráfagas: con medición real no se mezclan ráfagas pronosticadas.
    rafagas_kmh: medido ? null : kmh(d.wind_speed_of_gust),
    lluvia_1h_mm: n1?.details.precipitation_amount ?? null,
    lluvia_1h_prob: n1?.details.probability_of_precipitation ?? null,
    lluvia_6h_mm: n6?.details.precipitation_amount ?? null,
    lluvia_6h_prob: n6?.details.probability_of_precipitation ?? null,
    proximas: next,
  });
}
