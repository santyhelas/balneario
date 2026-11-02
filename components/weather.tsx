"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { cardinal, sunPosition, sunTimes } from "@/lib/sun";
import { spotOf, widgetDocument } from "@/lib/windguru";
import { useWorkspace } from "@/components/workspace";
import { cx } from "@/components/ui";

function hhmm(d: Date | null, tz: string) {
  if (!d) return "—";
  return new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(d);
}

/** Parámetros del widget de Windguru guardados en Configuración (null si no hay spot cargado). */
function useWindguruParams() {
  const { ws } = useWorkspace();
  const [state, setState] = useState<{ params: string | null; error: string | null; loading: boolean }>({ params: null, error: null, loading: true });
  useEffect(() => {
    let cancelled = false;
    getSupabase().from("workspaces").select("windguru_params").eq("id", ws.id).single().then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setState({ params: null, loading: false, error: error.code === "42703" ? "Falta aplicar la actualización 0013 de la base de datos." : "No se pudo leer la configuración del clima." });
      } else {
        setState({ params: (data as { windguru_params: string | null }).windguru_params, error: null, loading: false });
      }
    });
    return () => { cancelled = true; };
  }, [ws.id, ws.version]);
  return state;
}

/**
 * Pronóstico oficial de Windguru para el spot del balneario.
 * Se muestra en un recuadro aislado (sin acceso a la sesión ni a los datos del sistema).
 */
export function WindguruWidget({ className, height = 400 }: { className?: string; height?: number }) {
  const { ws, isAdmin } = useWorkspace();
  const wg = useWindguruParams();
  const [now] = useState(() => new Date());
  const sun = useMemo(
    () => (ws.latitude != null && ws.longitude != null ? sunTimes(now, Number(ws.latitude), Number(ws.longitude)) : null),
    [now, ws.latitude, ws.longitude],
  );
  const doc = useMemo(() => (wg.params ? widgetDocument(wg.params) : null), [wg.params]);
  const spot = spotOf(wg.params);

  return (
    <section className={cx("rounded-2xl border border-line bg-surface p-3", className)}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <h2 className="text-xs font-bold uppercase tracking-widest">Pronóstico · Windguru</h2>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
          {sun && <span>☀ Sale {hhmm(sun.sunrise, ws.timezone)} · se pone {hhmm(sun.sunset, ws.timezone)}</span>}
          {spot && <a href={`https://www.windguru.cz/${spot}`} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">Abrir en Windguru ↗</a>}
        </div>
      </div>
      {wg.loading ? (
        <p className="px-1 py-6 text-center text-sm text-muted">Cargando…</p>
      ) : wg.error ? (
        <p className="px-1 py-4 text-sm text-danger">{wg.error}</p>
      ) : !doc ? (
        <p className="px-1 py-4 text-sm text-muted">
          Todavía no está configurado el spot de Windguru.{" "}
          {isAdmin ? <Link href="/configuracion" className="text-accent underline">Cargalo en Configuración</Link> : "Pedile al propietario que lo cargue en Configuración."}
        </p>
      ) : (
        <iframe
          title="Pronóstico de Windguru"
          srcDoc={doc}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          loading="lazy"
          className="w-full rounded-xl border-0 bg-white"
          style={{ height }}
        />
      )}
    </section>
  );
}

/**
 * Rosa de orientación sobre el plano, girada como el dibujo:
 * muestra dónde está el norte y desde dónde llega el sol en este momento.
 */
export function SunCompass({ seaSide }: { seaSide: "top" | "bottom" | "left" | "right" }) {
  const { ws } = useWorkspace();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 5 * 60_000);
    return () => window.clearInterval(id);
  }, []);
  if (ws.latitude == null || ws.longitude == null) return null;
  const seaBearing = Number(ws.sea_bearing ?? 90);
  const up = seaSide === "bottom" ? seaBearing + 180 : seaSide === "top" ? seaBearing : seaSide === "right" ? seaBearing - 90 : seaBearing + 90;
  const screen = (bearing: number) => (((bearing - up) % 360) + 360) % 360;
  const sun = sunPosition(now, Number(ws.latitude), Number(ws.longitude));
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-2 rounded-xl bg-surface/90 p-2 shadow-sm backdrop-blur print:hidden" aria-label="Orientación y sol">
      <svg viewBox="-50 -50 100 100" className="h-16 w-16 sm:h-20 sm:w-20">
        <circle r="44" fill="none" stroke="var(--line)" strokeWidth="2" />
        {["N", "E", "S", "O"].map((l, i) => {
          const a = (screen(i * 90) * Math.PI) / 180;
          return <text key={l} x={Math.sin(a) * 34} y={-Math.cos(a) * 34} textAnchor="middle" dominantBaseline="middle" fontSize="13" fontWeight={l === "N" ? 800 : 600} fill={l === "N" ? "var(--danger)" : "var(--muted)"}>{l}</text>;
        })}
        {sun.elevation > 0 && (() => {
          const a = (screen(sun.azimuth) * Math.PI) / 180;
          return (
            <g>
              <line x1="0" y1="0" x2={Math.sin(a) * 36} y2={-Math.cos(a) * 36} stroke="#f6b73c" strokeWidth="2" strokeDasharray="3 3" />
              <circle cx={Math.sin(a) * 44} cy={-Math.cos(a) * 44} r="7" fill="#f6b73c" stroke="#fff" strokeWidth="2" />
            </g>
          );
        })()}
      </svg>
      <div className="text-xs leading-tight">
        {sun.elevation > 0 ? (
          <>
            <div className="font-bold"><span className="text-[#e0a020]">●</span> Sol del {cardinal(sun.azimuth)}</div>
            <div className="text-muted">{Math.round(sun.elevation)}° de altura</div>
          </>
        ) : <div className="text-muted">El sol ya se puso</div>}
      </div>
    </div>
  );
}
