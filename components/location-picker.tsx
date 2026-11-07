"use client";
import { useEffect, useState } from "react";
import type { Place } from "@/lib/places";
import { Alert, Button, Input, Spinner, TextField, cx } from "@/components/ui";

const round = (n: number) => Math.round(n * 1e5) / 1e5;

/**
 * Ubicación del balneario para el clima, el viento y el sol:
 * se detecta con el celular o la compu, se busca por nombre, o se carga a mano.
 */
export function LocationPicker({ lat, lon, onChange, disabled }: {
  lat: number | null; lon: number | null; onChange: (lat: number | null, lon: number | null) => void; disabled?: boolean;
}) {
  const [name, setName] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState<null | "gps" | "buscar">(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [mLat, setMLat] = useState(lat?.toString() ?? "");
  const [mLon, setMLon] = useState(lon?.toString() ?? "");

  // Nombre del lugar elegido ("Pinamar, Buenos Aires").
  useEffect(() => {
    setMLat(lat?.toString() ?? "");
    setMLon(lon?.toString() ?? "");
    if (lat == null || lon == null) { setName(null); return; }
    let off = false;
    fetch(`/api/lugar?lat=${lat}&lon=${lon}`).then((r) => r.json()).then((b: { nombre?: string | null }) => { if (!off) setName(b.nombre ?? null); }).catch(() => undefined);
    return () => { off = true; };
  }, [lat, lon]);

  /** Si el navegador no puede ubicarse, se ofrece la ubicación aproximada de la conexión a internet. */
  async function ipFallback(reason: string) {
    try {
      const r = await fetch("/api/lugar?ip=1");
      const b = (await r.json()) as { lat: number | null; lon: number | null; ciudad: string | null };
      if (b.lat != null && b.lon != null) {
        setResults([{ lat: round(b.lat), lon: round(b.lon), label: `${b.ciudad ?? "Ubicación aproximada"} (según tu conexión a internet; revisá que sea el balneario)` }]);
        setError(`${reason} Te mostramos abajo la ubicación aproximada de tu conexión: tocala solo si corresponde al balneario. Si no, buscalo por nombre.`);
        return;
      }
    } catch { /* sin respaldo */ }
    setError(`${reason} Buscá el balneario por nombre (por ejemplo «Villa Gesell») o cargá la latitud y longitud a mano.`);
  }

  function useMyLocation() {
    setError(null);
    setResults(null);
    if (!("geolocation" in navigator) || !window.isSecureContext) {
      void ipFallback("Este navegador no puede detectar la ubicación.");
      return;
    }
    setBusy("gps");
    const ok = (p: GeolocationPosition) => {
      setBusy(null);
      onChange(round(p.coords.latitude), round(p.coords.longitude));
      // En una compu sin GPS la ubicación sale de la red y puede errar varios kilómetros.
      if (p.coords.accuracy > 3000) {
        setError(`Ubicación aproximada (puede errar unos ${Math.round(p.coords.accuracy / 1000)} km). Revisá con «Ver en el mapa» que sea el balneario; si no, buscalo por nombre.`);
      }
    };
    const fail = (e: GeolocationPositionError) => {
      setBusy(null);
      if (e.code === e.PERMISSION_DENIED) {
        setError("El navegador no tiene permiso para ver la ubicación. Tocá el candado de la barra de direcciones → Ubicación → Permitir, y probá de nuevo. También podés buscar el balneario por nombre.");
      } else {
        void ipFallback(e.code === e.TIMEOUT
          ? "La compu tardó demasiado en ubicarse."
          : "La compu no pudo ubicarse (en Windows, revisá Configuración → Privacidad → Ubicación).");
      }
    };
    // Primero rápido (red o wifi); si falla por tiempo, una vez más con más precisión.
    navigator.geolocation.getCurrentPosition(ok, (e) => {
      if (e.code === e.PERMISSION_DENIED) return fail(e);
      navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }

  async function search() {
    const t = q.trim();
    if (t.length < 3) return setError("Escribí al menos 3 letras.");
    setBusy("buscar");
    setError(null);
    try {
      const r = await fetch(`/api/lugar?q=${encodeURIComponent(t)}`);
      const b = (await r.json()) as { lugares?: Place[]; error?: string };
      if (!r.ok) throw new Error(b.error);
      setResults(b.lugares ?? []);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "No se pudo buscar el lugar.");
    } finally {
      setBusy(null);
    }
  }

  function applyManual() {
    const la = Number(mLat.replace(",", "."));
    const lo = Number(mLon.replace(",", "."));
    if (!(la >= -90 && la <= 90) || !(lo >= -180 && lo <= 180) || mLat.trim() === "" || mLon.trim() === "") {
      return setError("Revisá los números: la latitud va de -90 a 90 y la longitud de -180 a 180.");
    }
    setError(null);
    onChange(round(la), round(lo));
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <div className="text-sm font-medium">Ubicación del balneario</div>
      <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
        {lat != null && lon != null ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span><strong>{name ?? "Ubicación cargada"}</strong> <span className="text-xs text-muted">({lat}, {lon})</span></span>
            <span className="flex gap-3 text-xs">
              <a href={`https://www.google.com/maps?q=${lat},${lon}`} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Ver en el mapa</a>
              {!disabled && <button type="button" className="text-muted hover:text-danger" onClick={() => onChange(null, null)}>Quitar</button>}
            </span>
          </div>
        ) : <span className="text-muted">Sin ubicación: no se puede mostrar el clima.</span>}
      </div>
      {!disabled && (
        <>
          <Button type="button" variant="secondary" onClick={useMyLocation} loading={busy === "gps"}>Usar mi ubicación actual</Button>
          <p className="text-xs text-muted">Conviene hacerlo estando en el balneario: el celular o la compu te van a pedir permiso.</p>
          <div className="flex gap-2">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="O buscá: Punta Mogotes, Pinamar, Villa Gesell…" aria-label="Buscar lugar"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }} />
            <Button type="button" variant="secondary" onClick={search} disabled={busy !== null} className="shrink-0">{busy === "buscar" ? <Spinner small /> : "Buscar"}</Button>
          </div>
          {results && (
            results.length === 0 ? <p className="text-sm text-muted">No se encontró ese lugar. Probá con el nombre de la ciudad.</p> : (
              <ul className="overflow-hidden rounded-lg border border-line text-sm">
                {results.map((r) => (
                  <li key={`${r.lat},${r.lon}`} className="border-b border-line last:border-0">
                    <button type="button" onClick={() => { onChange(r.lat, r.lon); setResults(null); setQ(""); }} className="w-full px-3 py-2 text-left hover:bg-surface-2">{r.label}</button>
                  </li>
                ))}
              </ul>
            )
          )}
          <button type="button" onClick={() => setManual((v) => !v)} className={cx("self-start text-xs text-muted hover:underline")}>
            {manual ? "Ocultar carga a mano" : "Cargar latitud y longitud a mano"}
          </button>
          {manual && (
            <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              <TextField label="Latitud" inputMode="decimal" value={mLat} onChange={(e) => setMLat(e.target.value)} placeholder="-37.2639" />
              <TextField label="Longitud" inputMode="decimal" value={mLon} onChange={(e) => setMLon(e.target.value)} placeholder="-56.9731" />
              <Button type="button" variant="secondary" onClick={applyManual}>Usar</Button>
            </div>
          )}
          {error && <Alert tone="warn">{error}</Alert>}
          <p className="text-[11px] text-muted">Búsqueda de lugares: © colaboradores de OpenStreetMap.</p>
        </>
      )}
    </div>
  );
}
