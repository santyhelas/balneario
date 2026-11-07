"use client";
import { useEffect, useRef, useState } from "react";
import type { Map as LMap, Marker } from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * Mapa de calles (OpenStreetMap) para marcar el punto exacto del balneario:
 * se toca el lugar o se arrastra la marca. Sirve para esquinas como «Paseo 100 y la playa»,
 * que los buscadores de direcciones no siempre encuentran.
 */
export function MapPointPicker({ lat, lon, onPick, disabled }: { lat: number | null; lon: number | null; onPick: (lat: number, lon: number) => void; disabled?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<LMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const placeRef = useRef<((la: number, lo: number) => void) | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const L = (await import("leaflet")).default;
        if (off || !box.current || map.current) return;
        const has = lat != null && lon != null;
        const m = L.map(box.current, { zoomControl: true, attributionControl: true })
          .setView(has ? [lat!, lon!] : [-37.2639, -56.9731], has ? 17 : 13);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
        }).addTo(m);
        const icon = L.divIcon({
          className: "",
          html: '<div style="width:28px;height:28px;margin:-28px 0 0 -14px;border-radius:50% 50% 50% 0;background:#ef4444;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);transform:rotate(-45deg)"></div>',
          iconSize: [0, 0],
        });
        const place = (la: number, lo: number) => {
          if (marker.current) marker.current.setLatLng([la, lo]);
          else {
            marker.current = L.marker([la, lo], { icon, draggable: !disabled, keyboard: false }).addTo(m);
            marker.current.on("dragend", () => {
              const p = marker.current!.getLatLng();
              pick.current(p.lat, p.lng);
            });
          }
        };
        placeRef.current = place;
        if (has) place(lat!, lon!);
        if (!disabled) m.on("click", (e) => { place(e.latlng.lat, e.latlng.lng); pick.current(e.latlng.lat, e.latlng.lng); });
        map.current = m;
        // El contenedor puede haber cambiado de tamaño al abrirse.
        window.setTimeout(() => m.invalidateSize(), 50);
      } catch {
        if (!off) setError("No se pudo cargar el mapa. Revisá la conexión y probá de nuevo.");
      }
    })();
    return () => {
      off = true;
      map.current?.remove();
      map.current = null;
      marker.current = null;
      placeRef.current = null;
    };
    // El mapa se arma una sola vez; los cambios de ubicación se aplican abajo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Si la ubicación cambia desde afuera (búsqueda, GPS), el mapa va hasta ahí.
  useEffect(() => {
    const m = map.current;
    if (!m || lat == null || lon == null) return;
    const cur = marker.current?.getLatLng();
    if (cur && Math.abs(cur.lat - lat) < 1e-6 && Math.abs(cur.lng - lon) < 1e-6) return;
    placeRef.current?.(lat, lon);
    m.setView([lat, lon], Math.max(m.getZoom(), 16));
  }, [lat, lon]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  return <div ref={box} className="relative z-0 h-80 w-full overflow-hidden rounded-lg border border-line" aria-label="Mapa para marcar la ubicación del balneario" />;
}
