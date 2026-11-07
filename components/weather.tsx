"use client";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cardinal, cardinalName, sunPosition, sunTimes } from "@/lib/sun";
import { formatTemperature } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { cx } from "@/components/ui";

export type Weather = {
  /** Estado de la conexión con OpenWeather. */
  openweather?: "sin_clave" | "clave_no_activa" | "error" | "ok";
  /** Clima actual de OpenWeather (si hay un dato reciente). */
  medido?: { fuente?: "OpenWeather"; estacion: string; hora: string; distancia_km: number; cielo: string | null } | null;
  fuente: string;
  actualizado: string;
  hora_dato: string;
  temperatura: number | null;
  humedad: number | null;
  viento_kmh: number | null;
  rafagas_kmh: number | null;
  viento_desde: number | null;
  /** De dónde sale el viento que se muestra y de qué hora es. */
  viento_fuente?: { fuente: "OpenWeather" | "Pronóstico"; hora: string; lugar: string | null; distancia_km: number };
  simbolo: string | null;
  lluvia_1h_mm: number | null;
  lluvia_1h_prob: number | null;
  lluvia_6h_mm: number | null;
  lluvia_6h_prob: number | null;
  /** Resumen de los próximos días (pronóstico). */
  dias?: { fecha: string; tmax: number | null; tmin: number | null; lluvia_mm: number; prob: number | null; viento_max: number; simbolo: string | null }[];
  proximas: { time: string; temp: number | null; wind: number | null; gust: number | null; precip: number | null; prob: number | null; symbol: string }[];
};

type Ctx = { data: Weather | null; error: string | null; loading: boolean; fetchedAt: Date | null; reload: () => void; noLocation: boolean };
const WeatherCtx = createContext<Ctx | null>(null);

export const WIND_ALERT_KMH = 25;

/** Consulta el clima una vez para toda la aplicación y lo actualiza cada 10 minutos. */
export function WeatherProvider({ children }: { children: ReactNode }) {
  const { ws } = useWorkspace();
  const [data, setData] = useState<Weather | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);
  const lat = ws.latitude;
  const lon = ws.longitude;
  const noLocation = lat === null || lon === null || lat === undefined || lon === undefined;

  useEffect(() => {
    if (noLocation) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/clima?lat=${lat}&lon=${lon}`, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((body as { error?: string }).error ?? "No se pudo obtener el clima.");
        return body as Weather;
      })
      .then((w) => { if (!cancelled) { setData(w); setError(null); setFetchedAt(new Date()); } })
      .catch((e: Error) => { if (!cancelled) setError(/fetch/i.test(e.message) ? "Sin conexión para consultar el clima." : e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [lat, lon, noLocation, tick]);

  // El clima se consulta cada 10 minutos, y solo si la pantalla se está mirando.
  // Al volver a la pestaña, si pasaron más de 10 minutos, se actualiza enseguida.
  const lastAsk = useRef(Date.now());
  useEffect(() => {
    const EVERY = 10 * 60_000;
    const ask = () => { lastAsk.current = Date.now(); setTick((t) => t + 1); };
    const id = window.setInterval(() => { if (document.visibilityState === "visible") ask(); }, EVERY);
    const onShow = () => { if (document.visibilityState === "visible" && Date.now() - lastAsk.current >= EVERY) ask(); };
    document.addEventListener("visibilitychange", onShow);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", onShow); };
  }, []);

  return <WeatherCtx.Provider value={{ data, error, loading, fetchedAt, reload: () => setTick((t) => t + 1), noLocation }}>{children}</WeatherCtx.Provider>;
}

export function useWeather(): Ctx {
  const c = useContext(WeatherCtx);
  if (!c) throw new Error("useWeather fuera de WeatherProvider");
  return c;
}

export type IconKind = "sun" | "moon" | "fair" | "fairnight" | "partly" | "cloud" | "fog" | "drizzle" | "rain" | "heavyrain" | "thunder" | "snow" | "unknown";

/** Descripción e ícono a partir del código de MET Norway (ej. "lightrain", "partlycloudy_day"). */
export function describeSymbol(code: string | null): { text: string; icon: IconKind } {
  if (!code) return { text: "—", icon: "unknown" };
  const c = code.replace(/_(day|night|polartwilight)$/, "");
  const night = code.endsWith("_night");
  if (c.includes("thunder")) return { text: "Tormenta eléctrica", icon: "thunder" };
  if (c.includes("snow") || c.includes("sleet")) return { text: c.includes("sleet") ? "Aguanieve" : "Nieve", icon: "snow" };
  if (c.includes("heavyrain")) return { text: c.includes("showers") ? "Chaparrones fuertes" : "Lluvia fuerte", icon: "heavyrain" };
  if (c.includes("lightrain")) return { text: c.includes("showers") ? "Chaparrones débiles" : "Llovizna", icon: "drizzle" };
  if (c.includes("rain")) return { text: c.includes("showers") ? "Chaparrones" : "Lluvia", icon: "rain" };
  if (c === "fog") return { text: "Niebla", icon: "fog" };
  if (c === "cloudy") return { text: "Nublado", icon: "cloud" };
  if (c === "partlycloudy") return { text: "Parcialmente nublado", icon: night ? "cloud" : "partly" };
  if (c === "fair") return { text: "Mayormente despejado", icon: night ? "fairnight" : "fair" };
  if (c === "clearsky") return { text: "Despejado", icon: night ? "moon" : "sun" };
  return { text: code, icon: "unknown" };
}

/** Íconos del clima dibujados con contorno: se distinguen en tema claro y oscuro. */
export function WeatherIcon({ kind, className = "h-14 w-14" }: { kind: IconKind; className?: string }) {
  const SUN = "#f6b73c";
  const SUN_EDGE = "#c98a12";
  const CLOUD = "#e8eef3";
  const CLOUD_EDGE = "#6b7f8e";
  const DROP = "#3b8fd9";
  const sun = (cx: number, cy: number, r: number) => (
    <g>
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        return <line key={i} x1={cx + Math.cos(a) * (r + 4)} y1={cy + Math.sin(a) * (r + 4)} x2={cx + Math.cos(a) * (r + 9)} y2={cy + Math.sin(a) * (r + 9)} stroke={SUN} strokeWidth={3.5} strokeLinecap="round" />;
      })}
      <circle cx={cx} cy={cy} r={r} fill={SUN} stroke={SUN_EDGE} strokeWidth={2} />
    </g>
  );
  const moon = (cx: number, cy: number) => (
    <path d={`M${cx + 6} ${cy - 15} a16 16 0 1 0 12 22 a13 13 0 0 1 -12 -22z`} fill="#f3d27a" stroke={SUN_EDGE} strokeWidth={2} />
  );
  const cloud = (dx = 0, dy = 0, fill = CLOUD) => (
    <path transform={`translate(${dx} ${dy})`} d="M18 48 h30 a11 11 0 0 0 0 -22 a15 15 0 0 0 -28 -4 a12 12 0 0 0 -2 26z" fill={fill} stroke={CLOUD_EDGE} strokeWidth={2.5} strokeLinejoin="round" />
  );
  const drops = (n: number, heavy = false) => (
    <g stroke={DROP} strokeWidth={heavy ? 4 : 3} strokeLinecap="round">
      {Array.from({ length: n }, (_, i) => {
        const x = 20 + i * (28 / Math.max(1, n - 1));
        return <line key={i} x1={x} y1={52} x2={x - 3} y2={heavy ? 62 : 59} />;
      })}
    </g>
  );
  let body: ReactNode;
  switch (kind) {
    case "sun": body = sun(32, 32, 12); break;
    case "moon": body = moon(30, 30); break;
    case "fair": body = <>{sun(24, 22, 9)}{cloud(2, 10)}</>; break;
    case "fairnight": body = <>{moon(22, 20)}{cloud(2, 10)}</>; break;
    case "partly": body = <>{sun(22, 20, 10)}{cloud(4, 4)}</>; break;
    case "cloud": body = <>{cloud(-6, -6, "#cfd9e1")}{cloud(4, 4)}</>; break;
    case "fog": body = (
      <>
        {cloud(0, -6)}
        <g stroke={CLOUD_EDGE} strokeWidth={3.5} strokeLinecap="round">
          <line x1="10" y1="50" x2="54" y2="50" /><line x1="16" y1="57" x2="48" y2="57" /><line x1="12" y1="43" x2="22" y2="43" />
        </g>
      </>
    ); break;
    case "drizzle": body = <>{sun(44, 16, 7)}{cloud(-2, -4)}{drops(3)}</>; break;
    case "rain": body = <>{cloud(0, -4)}{drops(4)}</>; break;
    case "heavyrain": body = <>{cloud(0, -4, "#b9c6d1")}{drops(5, true)}</>; break;
    case "thunder": body = <>{cloud(0, -6, "#b9c6d1")}<path d="M34 40 l-8 12 h7 l-4 10 l12 -15 h-7 l5 -7z" fill={SUN} stroke={SUN_EDGE} strokeWidth={1.5} strokeLinejoin="round" /></>; break;
    case "snow": body = <>{cloud(0, -4)}<g fill="#fff" stroke={DROP} strokeWidth={1.5}><circle cx="22" cy="55" r="3" /><circle cx="33" cy="59" r="3" /><circle cx="44" cy="55" r="3" /></g></>; break;
    default: body = <path d="M28 10 v30 a8 8 0 1 0 8 0 v-30 a4 4 0 0 0 -8 0z" fill="#fff" stroke={CLOUD_EDGE} strokeWidth={2.5} />;
  }
  return <svg viewBox="0 0 64 64" className={className} aria-hidden>{body}</svg>;
}

function hhmm(d: Date | string | null | undefined, tz?: string) {
  if (!d) return "—";
  return new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(typeof d === "string" ? new Date(d) : d);
}

/** Barra con el clima actual: temperatura, viento (de dónde viene y hacia dónde va), lluvia y sol. */
export function WeatherStrip({ className }: { className?: string }) {
  const { ws, tempUnit } = useWorkspace();
  const w = useWeather();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const sun = useMemo(() => {
    if (ws.latitude == null || ws.longitude == null) return null;
    return { ...sunTimes(now, Number(ws.latitude), Number(ws.longitude)), pos: sunPosition(now, Number(ws.latitude), Number(ws.longitude)) };
  }, [now, ws.latitude, ws.longitude]);

  if (w.noLocation) {
    return <div className={cx("rounded-xl border border-dashed border-line px-3 py-2 text-sm text-muted", className)}>Para ver el clima, cargá la ubicación del balneario en Configuración.</div>;
  }
  if (!w.data) {
    return (
      <div className={cx("rounded-xl border border-line bg-surface px-3 py-2 text-sm text-muted", className)}>
        {w.error ? <>Clima no disponible: {w.error} <button className="text-accent underline" onClick={w.reload}>Reintentar</button></> : "Consultando el clima…"}
      </div>
    );
  }
  const d = w.data;
  const sym = describeSymbol(d.simbolo);
  const windy = (d.viento_kmh ?? 0) > WIND_ALERT_KMH || (d.rafagas_kmh ?? 0) > WIND_ALERT_KMH;
  const rainToday = d.proximas.reduce((s, p) => s + (p.precip ?? 0), 0);
  const maxProb = d.proximas.reduce<number | null>((m, p) => (p.prob == null ? m : Math.max(m ?? 0, p.prob)), null);
  const stale = w.error !== null;

  return (
    <div className={cx("flex flex-col gap-2", className)}>
      {windy && (
        <div role="alert" className="rounded-xl border border-warn/50 bg-warn-soft px-3 py-2 text-sm font-medium">
          Viento fuerte ({d.viento_kmh} km/h{d.rafagas_kmh ? `, ráfagas de ${d.rafagas_kmh}` : ""}): revisá amarres de carpas y cerrá sombrillas.
        </div>
      )}
      <div className="flex flex-wrap items-stretch gap-x-6 gap-y-2 rounded-2xl border border-line bg-surface px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-sky-100 dark:bg-slate-700"><WeatherIcon kind={sym.icon} className="h-14 w-14" /></span>
          <div>
            <div className="tabular text-3xl font-extrabold leading-none">{d.temperatura == null ? "—" : formatTemperature(d.temperatura, tempUnit)}</div>
            <div className="text-xs text-muted">{sym.text}</div>
          </div>
        </div>
        <Metric label="Humedad">
          <span className="tabular font-bold">{d.humedad != null ? `${Math.round(d.humedad)}%` : "—"}</span>
          <span className="text-xs text-muted">{d.humedad == null ? "Sin dato" : d.humedad >= 85 ? "Muy húmedo" : d.humedad >= 65 ? "Húmedo" : d.humedad >= 35 ? "Normal" : "Seco"}</span>
        </Metric>
        <Metric label="Viento">
          <span className="flex items-center gap-2">
            {d.viento_desde != null && (
              <svg viewBox="0 0 24 24" className="h-6 w-6 text-accent" style={{ transform: `rotate(${(d.viento_desde + 180) % 360}deg)` }} aria-hidden>
                <path d="M12 2l5 9h-3.5v11h-3V11H7z" fill="currentColor" />
              </svg>
            )}
            <span className={cx("tabular font-bold", windy && "text-warn")}>{d.viento_kmh ?? "—"} km/h</span>
          </span>
          <span className="text-xs text-muted">
            {d.viento_desde != null ? `Sopla hacia el ${cardinalName((d.viento_desde + 180) % 360)} (viene del ${cardinal(d.viento_desde)})` : d.viento_kmh === 0 ? "Calma" : ""}
            {d.rafagas_kmh != null ? ` · Ráfagas ${d.rafagas_kmh} km/h` : ""}
          </span>
          {d.viento_fuente && <span className="text-[11px] text-muted">{windSourceText(d.viento_fuente, ws.timezone)}</span>}
        </Metric>
        <Metric label="Lluvia">
          <span className="tabular font-bold">{d.lluvia_1h_mm != null ? `${d.lluvia_1h_mm} mm` : "—"} <span className="text-xs font-normal text-muted">próxima hora</span></span>
          <span className="text-xs text-muted">
            {d.lluvia_1h_prob != null ? `Probabilidad ${Math.round(d.lluvia_1h_prob)}% · ` : ""}
            Próximas 12 h: {Math.round(rainToday * 10) / 10} mm{maxProb != null ? ` (hasta ${Math.round(maxProb)}%)` : ""}
          </span>
        </Metric>
        {sun && (
          <Metric label="Sol">
            <span className="tabular font-bold">☀ {hhmm(sun.sunrise, ws.timezone)} · ☾ {hhmm(sun.sunset, ws.timezone)}</span>
            <span className="text-xs text-muted">
              {sun.pos.elevation > 0
                ? `Ahora desde el ${cardinal(sun.pos.azimuth)}, ${Math.round(sun.pos.elevation)}° de altura`
                : "Ya se puso"}
            </span>
          </Metric>
        )}
        <div className="ml-auto flex flex-col justify-center text-right text-[11px] text-muted">
          <span className={cx(stale && "text-danger")}>
            {stale ? "No se pudo actualizar · " : ""}
            {d.medido
              ? `Clima actual de las ${hhmm(d.medido.hora, ws.timezone)}`
              : `Pronóstico para las ${hhmm(d.hora_dato, ws.timezone)} (calculado ${hhmm(d.actualizado, ws.timezone)})`}
            {w.fetchedAt ? ` · revisado ${hhmm(w.fetchedAt.toISOString(), ws.timezone)}` : ""}
          </span>
          {d.openweather === "clave_no_activa" && <span className="text-warn">OpenWeather: la clave todavía no está activa (puede tardar hasta 2 horas)</span>}
          {d.openweather === "sin_clave" && <span>OpenWeather: falta cargar la clave en Vercel</span>}
          {d.openweather === "error" && <span className="text-warn">OpenWeather no responde; se muestra el pronóstico</span>}
          <span>
            {d.medido && <><a href="https://openweathermap.org/" target="_blank" rel="noopener noreferrer" className="hover:underline">Weather data © OpenWeather</a> · </>}
            <a href="https://www.met.no/en" target="_blank" rel="noopener noreferrer" className="hover:underline">{d.medido ? "Pronóstico" : "Datos"}: MET Norway (CC BY 4.0)</a>
          </span>
        </div>
      </div>
    </div>
  );
}

function windSourceText(f: NonNullable<Weather["viento_fuente"]>, tz: string) {
  if (f.fuente === "OpenWeather") return `Viento de las ${hhmm(f.hora, tz)} · OpenWeather`;
  return `Viento pronosticado para las ${hhmm(f.hora, tz)} · MET Norway`;
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col justify-center">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      {children}
    </div>
  );
}

/**
 * Brújula sobre el plano, con el Norte arriba (igual que la flecha del pronóstico):
 * solo los puntos cardinales, el sol donde está ahora y la flecha de hacia dónde va el viento.
 */
export function WindCompass({ seaSide }: { seaSide: "top" | "bottom" | "left" | "right" }) {
  const { ws } = useWorkspace();
  const w = useWeather();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  void seaSide;
  // Norte arriba, como toda brújula (y como la flecha del pronóstico).
  const screen = (bearing: number) => ((bearing % 360) + 360) % 360;
  const toward = w.data?.viento_desde != null ? (w.data.viento_desde + 180) % 360 : null;
  const sun = ws.latitude != null && ws.longitude != null ? sunPosition(now, Number(ws.latitude), Number(ws.longitude)) : null;

  if (w.noLocation) return null;
  return (
    <div className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1.5 rounded-xl bg-surface/90 p-1.5 shadow-md backdrop-blur sm:bottom-3 sm:right-3 sm:gap-3 sm:rounded-2xl sm:p-3 print:hidden" aria-label="Orientación, viento y sol">
      <svg viewBox="-50 -50 100 100" className="h-12 w-12 sm:h-28 sm:w-28 lg:h-40 lg:w-40">
        <circle r="46" fill="none" stroke="var(--line)" strokeWidth="2" />

        {["N", "E", "S", "O"].map((l, i) => {
          const a = (screen(i * 90) * Math.PI) / 180;
          return <text key={l} x={Math.sin(a) * 37} y={-Math.cos(a) * 37} textAnchor="middle" dominantBaseline="middle" fontSize="12" fontWeight={l === "N" ? 800 : 600} fill={l === "N" ? "var(--danger)" : "var(--muted)"}>{l}</text>;
        })}
        {toward != null && (
          <g transform={`rotate(${screen(toward)})`}>
            <line x1="0" y1="22" x2="0" y2="-18" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" />
            <path d="M0 -30 L9 -14 L-9 -14 Z" fill="var(--accent)" />
          </g>
        )}
        {sun && sun.elevation > 0 && (() => {
          const a = (screen(sun.azimuth) * Math.PI) / 180;
          return <circle cx={Math.sin(a) * 46} cy={-Math.cos(a) * 46} r="7" fill="#f6b73c" stroke="#fff" strokeWidth="2" />;
        })()}
      </svg>
      <div className="text-xs leading-snug sm:text-sm lg:text-base">
        {w.data?.viento_kmh != null ? (
          <>
            <div className="text-sm font-bold sm:text-lg lg:text-xl">{w.data.viento_kmh} km/h</div>
            {w.data.viento_desde == null ? (
              <div className="text-muted">Calma</div>
            ) : (
              <>
                <div className="text-muted sm:hidden">hacia el {cardinal(toward ?? 0)}</div>
                <div className="hidden text-muted sm:block">sopla hacia el {cardinal(toward ?? 0)} (viene del {cardinal(w.data.viento_desde)}){w.data.rafagas_kmh != null ? ` · ráfagas ${w.data.rafagas_kmh}` : ""}</div>
              </>
            )}
          </>
        ) : <div className="text-muted">Sin datos de viento</div>}
        {w.data?.viento_fuente && (
          <div className="hidden text-[11px] text-muted sm:block">{windSourceText(w.data.viento_fuente, ws.timezone)}</div>
        )}
        {sun && <div className="hidden sm:block">{sun.elevation > 0
          ? <div className="mt-1.5"><span className="text-[#e0a020]">●</span> <strong>Sol del {cardinal(sun.azimuth)}</strong><div className="text-muted">{Math.round(sun.elevation)}° de altura</div></div>
          : <div className="mt-1.5 text-muted">El sol ya se puso</div>}</div>}
      </div>
    </div>
  );
}
