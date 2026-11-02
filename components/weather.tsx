"use client";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { cardinal, cardinalName, sunPosition, sunTimes } from "@/lib/sun";
import { formatTemperature } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { cx } from "@/components/ui";

export type Weather = {
  fuente: string;
  actualizado: string;
  hora_dato: string;
  temperatura: number | null;
  humedad: number | null;
  viento_kmh: number | null;
  rafagas_kmh: number | null;
  viento_desde: number | null;
  simbolo: string | null;
  lluvia_1h_mm: number | null;
  lluvia_1h_prob: number | null;
  lluvia_6h_mm: number | null;
  lluvia_6h_prob: number | null;
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
    fetch(`/api/clima?lat=${lat}&lon=${lon}`)
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

  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === "visible") setTick((t) => t + 1); }, 10 * 60_000);
    return () => window.clearInterval(id);
  }, []);

  return <WeatherCtx.Provider value={{ data, error, loading, fetchedAt, reload: () => setTick((t) => t + 1), noLocation }}>{children}</WeatherCtx.Provider>;
}

export function useWeather(): Ctx {
  const c = useContext(WeatherCtx);
  if (!c) throw new Error("useWeather fuera de WeatherProvider");
  return c;
}

/** Descripción e ícono a partir del código de MET Norway (ej. "lightrain", "partlycloudy_day"). */
export function describeSymbol(code: string | null): { text: string; icon: string } {
  if (!code) return { text: "—", icon: "🌡️" };
  const c = code.replace(/_(day|night|polartwilight)$/, "");
  const night = code.endsWith("_night");
  if (c.includes("thunder")) return { text: "Tormenta eléctrica", icon: "⛈️" };
  if (c.includes("snow") || c.includes("sleet")) return { text: c.includes("sleet") ? "Aguanieve" : "Nieve", icon: "🌨️" };
  if (c.includes("heavyrain")) return { text: c.includes("showers") ? "Chaparrones fuertes" : "Lluvia fuerte", icon: "🌧️" };
  if (c.includes("lightrain")) return { text: c.includes("showers") ? "Chaparrones débiles" : "Llovizna", icon: "🌦️" };
  if (c.includes("rain")) return { text: c.includes("showers") ? "Chaparrones" : "Lluvia", icon: "🌧️" };
  if (c === "fog") return { text: "Niebla", icon: "🌫️" };
  if (c === "cloudy") return { text: "Nublado", icon: "☁️" };
  if (c === "partlycloudy") return { text: "Parcialmente nublado", icon: night ? "☁️" : "⛅" };
  if (c === "fair") return { text: "Mayormente despejado", icon: night ? "🌙" : "🌤️" };
  if (c === "clearsky") return { text: "Despejado", icon: night ? "🌙" : "☀️" };
  return { text: code, icon: "🌡️" };
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
  const ageMin = Math.round((Date.now() - Date.parse(d.actualizado)) / 60_000);

  return (
    <div className={cx("flex flex-col gap-2", className)}>
      {windy && (
        <div role="alert" className="rounded-xl border border-warn/50 bg-warn-soft px-3 py-2 text-sm font-medium">
          💨 Viento fuerte ({d.viento_kmh} km/h{d.rafagas_kmh ? `, ráfagas de ${d.rafagas_kmh}` : ""}): revisá amarres de carpas y cerrá sombrillas.
        </div>
      )}
      <div className="flex flex-wrap items-stretch gap-x-6 gap-y-2 rounded-2xl border border-line bg-surface px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-4xl leading-none" aria-hidden>{sym.icon}</span>
          <div>
            <div className="tabular text-3xl font-extrabold leading-none">{d.temperatura == null ? "—" : formatTemperature(d.temperatura, tempUnit)}</div>
            <div className="text-xs text-muted">{sym.text}{d.humedad != null ? ` · Humedad ${Math.round(d.humedad)}%` : ""}</div>
          </div>
        </div>
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
            {d.viento_desde != null ? `Viene del ${cardinalName(d.viento_desde)} (${cardinal(d.viento_desde)}) → sopla hacia el ${cardinal((d.viento_desde + 180) % 360)}` : ""}
            {d.rafagas_kmh != null ? ` · Ráfagas ${d.rafagas_kmh} km/h` : ""}
          </span>
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
          <span className={cx(stale && "text-danger")}>{stale ? "No se pudo actualizar · " : ""}Pronóstico de las {hhmm(d.actualizado, ws.timezone)}{ageMin > 180 ? " (viejo)" : ""}</span>
          <a href="https://www.met.no/en" target="_blank" rel="noopener noreferrer" className="hover:underline">Datos: MET Norway (CC BY 4.0)</a>
        </div>
      </div>
    </div>
  );
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
 * Rosa de los vientos sobre el plano, orientada como el dibujo:
 * muestra el norte, hacia dónde va el viento y desde dónde llega el sol.
 */
export function WindCompass({ seaSide }: { seaSide: "top" | "bottom" | "left" | "right" }) {
  const { ws } = useWorkspace();
  const w = useWeather();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 5 * 60_000);
    return () => window.clearInterval(id);
  }, []);
  const seaBearing = Number(ws.sea_bearing ?? 90);
  // Rumbo que queda "arriba" en el dibujo, según de qué lado está el mar.
  const up = seaSide === "bottom" ? seaBearing + 180 : seaSide === "top" ? seaBearing : seaSide === "right" ? seaBearing - 90 : seaBearing + 90;
  const screen = (bearing: number) => (((bearing - up) % 360) + 360) % 360;
  const toward = w.data?.viento_desde != null ? (w.data.viento_desde + 180) % 360 : null;
  const sun = ws.latitude != null && ws.longitude != null ? sunPosition(now, Number(ws.latitude), Number(ws.longitude)) : null;

  if (w.noLocation) return null;
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-2 rounded-xl bg-surface/90 p-2 shadow-sm backdrop-blur print:hidden" aria-label="Orientación, viento y sol">
      <svg viewBox="-50 -50 100 100" className="h-20 w-20 sm:h-24 sm:w-24">
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
      <div className="text-xs leading-tight">
        {w.data?.viento_kmh != null ? (
          <>
            <div className="font-bold">💨 {w.data.viento_kmh} km/h</div>
            <div className="text-muted">del {cardinal(w.data.viento_desde ?? 0)}</div>
          </>
        ) : <div className="text-muted">Sin datos de viento</div>}
        {sun && sun.elevation > 0 && <div className="mt-1 text-muted"><span className="text-[#e0a020]">●</span> sol del {cardinal(sun.azimuth)}</div>}
      </div>
    </div>
  );
}
