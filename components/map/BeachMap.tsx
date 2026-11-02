"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { STATE_COLOR, TENT_H, TENT_W, TentIcon, UMBRELLA_R, UmbrellaIcon, type SpaceState } from "./icons";
import { cx } from "@/components/ui";

export type MapSpace = {
  space_id: string;
  code: string;
  kind: "carpa" | "sombrilla";
  x: number;
  y: number;
  rotation: number;
  state: SpaceState;
  version: number;
};

export type MapFeature = {
  id: string;
  kind: "camino" | "pasillo" | "area_comun" | "instalacion" | "sector";
  label: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  color: string | null;
};

type View = { x: number; y: number; w: number; h: number };

const MIN_ZOOM_W = 300; // ancho mínimo visible (zoom máximo)

/**
 * Plano cenital del balneario.
 * - Arrastrar el fondo: mueve el mapa.
 * - Ctrl + rueda o botones: zoom. La rueda sola hace scroll normal de la página.
 * - En modo edición, arrastrar una carpa la mueve; al soltar se guarda.
 */
export function BeachMap({
  width,
  height,
  seaSide,
  spaces,
  features,
  selectedId,
  editMode,
  onSelect,
  onMove,
}: {
  width: number;
  height: number;
  seaSide: "top" | "bottom" | "left" | "right";
  spaces: MapSpace[];
  features: MapFeature[];
  selectedId: string | null;
  editMode: boolean;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => Promise<boolean>;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, w: width, h: height });
  const [local, setLocal] = useState<Record<string, { x: number; y: number }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const drag = useRef<
    | { type: "pan"; startX: number; startY: number; view: View; moved: boolean }
    | { type: "space"; id: string; dx: number; dy: number; startX: number; startY: number; moved: boolean }
    | null
  >(null);

  useEffect(() => {
    setView({ x: 0, y: 0, w: width, h: height });
  }, [width, height]);

  // Cuando la base ya confirma la posición nueva, se descarta la copia local.
  useEffect(() => {
    setLocal((prev) => {
      const next: typeof prev = {};
      for (const [id, p] of Object.entries(prev)) {
        const s = spaces.find((sp) => sp.space_id === id);
        if (s && (Number(s.x) !== p.x || Number(s.y) !== p.y)) next[id] = p;
      }
      return next;
    });
  }, [spaces]);

  const toSvg = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }, []);

  // Escape: cancela el arrastre en curso y devuelve el espacio a su lugar guardado.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !drag.current) return;
      const d = drag.current;
      drag.current = null;
      if (d.type === "space") {
        setLocal((prev) => {
          const next = { ...prev };
          delete next[d.id];
          return next;
        });
      } else {
        setView(d.view);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Rueda: zoom solo con Ctrl; durante un arrastre se bloquea para evitar saltos.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (drag.current) {
        e.preventDefault();
        return;
      }
      if (!e.ctrlKey) return;
      e.preventDefault();
      const p = toSvg(e.clientX, e.clientY);
      zoomAt(p.x, p.y, e.deltaY < 0 ? 0.85 : 1 / 0.85);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toSvg]);

  const zoomAt = useCallback(
    (cx0: number, cy0: number, factor: number) => {
      setView((v) => {
        const w = Math.min(width * 1.5, Math.max(MIN_ZOOM_W, v.w * factor));
        const h = (w / v.w) * v.h;
        const x = cx0 - ((cx0 - v.x) * w) / v.w;
        const y = cy0 - ((cy0 - v.y) * h) / v.h;
        return { x, y, w, h };
      });
    },
    [width],
  );

  function onBgPointerDown(e: RPointerEvent<SVGRectElement>) {
    if (e.button !== 0) return;
    (e.currentTarget.ownerSVGElement ?? svgRef.current)!.setPointerCapture(e.pointerId);
    drag.current = { type: "pan", startX: e.clientX, startY: e.clientY, view, moved: false };
  }

  function onSpacePointerDown(e: RPointerEvent<SVGGElement>, s: MapSpace) {
    if (e.button !== 0) return;
    e.stopPropagation();
    svgRef.current!.setPointerCapture(e.pointerId);
    const pos = local[s.space_id] ?? { x: Number(s.x), y: Number(s.y) };
    const p = toSvg(e.clientX, e.clientY);
    drag.current = { type: "space", id: s.space_id, dx: p.x - pos.x, dy: p.y - pos.y, startX: e.clientX, startY: e.clientY, moved: false };
  }

  function onPointerMove(e: RPointerEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d) return;
    const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
    if (dist > 4) d.moved = true;
    if (!d.moved) return;
    if (d.type === "pan") {
      const rect = svgRef.current!.getBoundingClientRect();
      const sx = d.view.w / rect.width;
      const sy = d.view.h / rect.height;
      setView({ ...d.view, x: d.view.x - (e.clientX - d.startX) * sx, y: d.view.y - (e.clientY - d.startY) * sy });
    } else if (editMode) {
      const s = spaces.find((sp) => sp.space_id === d.id);
      if (!s) return;
      const p = toSvg(e.clientX, e.clientY);
      const halfW = s.kind === "carpa" ? TENT_W / 2 : UMBRELLA_R;
      const halfH = s.kind === "carpa" ? TENT_H / 2 + 9 : UMBRELLA_R;
      // Límites = el borde visible del mapa, nada más.
      const x = Math.round(Math.min(width - halfW, Math.max(halfW, p.x - d.dx)));
      const y = Math.round(Math.min(height - halfH, Math.max(halfH, p.y - d.dy)));
      setLocal((prev) => ({ ...prev, [d.id]: { x, y } }));
    }
  }

  async function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.type === "pan") {
      if (!d.moved) onSelect(null);
      return;
    }
    if (!d.moved || !editMode) {
      onSelect(d.id);
      return;
    }
    const pos = local[d.id];
    if (!pos) return;
    setSaving(d.id);
    const ok = await onMove(d.id, pos.x, pos.y);
    setSaving(null);
    if (!ok) {
      // No se guardó: vuelve a la posición de la base.
      setLocal((prev) => {
        const next = { ...prev };
        delete next[d.id];
        return next;
      });
    }
  }

  const sea = useMemo(() => {
    const band = Math.round((seaSide === "top" || seaSide === "bottom" ? height : width) * 0.17);
    switch (seaSide) {
      case "bottom":
        return { x: 0, y: height - band, w: width, h: band, shore: "h" as const, shoreAt: height - band };
      case "left":
        return { x: 0, y: 0, w: band, h: height, shore: "v" as const, shoreAt: band };
      case "right":
        return { x: width - band, y: 0, w: band, h: height, shore: "v" as const, shoreAt: width - band };
      default:
        return { x: 0, y: 0, w: width, h: band, shore: "h" as const, shoreAt: band };
    }
  }, [seaSide, width, height]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-line" ref={wrapRef}>
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className={cx("block h-[62vh] min-h-[360px] w-full select-none touch-none", drag.current?.type === "pan" ? "cursor-grabbing" : "cursor-grab")}
        preserveAspectRatio="xMidYMid meet"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { drag.current = null; }}
        role="img"
        aria-label="Mapa del balneario"
      >
        <defs>
          <pattern id="sand" width="22" height="22" patternUnits="userSpaceOnUse">
            <rect width="22" height="22" fill="var(--sand)" />
            <circle cx="4" cy="6" r="1.3" fill="var(--sand-dot)" />
            <circle cx="15" cy="16" r="1.1" fill="var(--sand-dot)" />
          </pattern>
          <linearGradient id="sea" x1="0" y1="0" x2={sea.shore === "h" ? "0" : "1"} y2={sea.shore === "h" ? "1" : "0"}>
            <stop offset="0" stopColor={seaSide === "bottom" || seaSide === "right" ? "var(--sea)" : "var(--sea-deep)"} />
            <stop offset="1" stopColor={seaSide === "bottom" || seaSide === "right" ? "var(--sea-deep)" : "var(--sea)"} />
          </linearGradient>
          <pattern id="planks" width="14" height="14" patternUnits="userSpaceOnUse">
            <rect width="14" height="14" fill="none" />
            <line x1="0" y1="0" x2="0" y2="14" stroke="#3b2410" strokeWidth="2" />
          </pattern>
          <clipPath id="tent-clip">
            <rect x={-TENT_W / 2} y={-TENT_H / 2} width={TENT_W} height={TENT_H} rx={7} />
          </clipPath>
        </defs>

        {/* Fondo: arena y mar. Un área un poco más grande permite arrastrar el mapa con zoom. */}
        <rect x={-width} y={-height} width={width * 3} height={height * 3} fill="var(--surface-2)" onPointerDown={onBgPointerDown} />
        <rect x={0} y={0} width={width} height={height} fill="url(#sand)" onPointerDown={onBgPointerDown} />
        <rect x={sea.x} y={sea.y} width={sea.w} height={sea.h} fill="url(#sea)" onPointerDown={onBgPointerDown} />
        {/* espuma de la orilla */}
        {sea.shore === "h" ? (
          <path
            d={`M0 ${sea.shoreAt} ${Array.from({ length: Math.ceil(width / 60) + 1 }, (_, i) => `q 15 ${seaSide === "top" ? 10 : -10} 30 0 t 30 0`).join(" ")}`}
            fill="none" stroke="var(--foam)" strokeWidth={5} opacity={0.9} pointerEvents="none"
          />
        ) : (
          <path
            d={`M${sea.shoreAt} 0 ${Array.from({ length: Math.ceil(height / 60) + 1 }, () => `q ${seaSide === "left" ? 10 : -10} 15 0 30 t 0 30`).join(" ")}`}
            fill="none" stroke="var(--foam)" strokeWidth={5} opacity={0.9} pointerEvents="none"
          />
        )}
        <text
          x={sea.x + sea.w / 2}
          y={sea.y + sea.h / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--foam)"
          fontSize={28}
          fontWeight={600}
          opacity={0.75}
          pointerEvents="none"
          letterSpacing={6}
        >
          MAR
        </text>
        <rect x={0} y={0} width={width} height={height} fill="none" stroke="var(--line)" strokeWidth={3} pointerEvents="none" />

        {features.map((f) => (
          <FeatureShape key={f.id} f={f} />
        ))}

        {spaces.map((s) => {
          const pos = local[s.space_id] ?? { x: Number(s.x), y: Number(s.y) };
          const color = STATE_COLOR[s.state];
          const selected = s.space_id === selectedId;
          return (
            <g
              key={s.space_id}
              transform={`translate(${pos.x} ${pos.y})`}
              onPointerDown={(e) => onSpacePointerDown(e, s)}
              className={editMode ? "cursor-move" : "cursor-pointer"}
              opacity={saving === s.space_id ? 0.6 : 1}
              tabIndex={0}
              role="button"
              aria-label={`${s.kind === "carpa" ? "Carpa" : "Sombrilla"} ${s.code}`}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelect(s.space_id);
              }}
            >
              <g transform={`rotate(${Number(s.rotation) || 0})`}>
                {s.kind === "carpa" ? (
                  <TentIcon color={color} selected={selected} dashed={s.state === "desactivada"} />
                ) : (
                  <UmbrellaIcon color={color} selected={selected} dashed={s.state === "desactivada"} />
                )}
              </g>
              <rect x={-21} y={-13} width={42} height={26} rx={7} fill="var(--surface)" opacity={0.95} stroke={color} strokeWidth={1.5} />
              <text y={1} textAnchor="middle" dominantBaseline="middle" fontSize={17} fontWeight={700} fill="var(--fg)">
                {s.code}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <MapBtn label="Acercar" onClick={() => zoomAt(view.x + view.w / 2, view.y + view.h / 2, 0.8)}>+</MapBtn>
        <MapBtn label="Alejar" onClick={() => zoomAt(view.x + view.w / 2, view.y + view.h / 2, 1.25)}>−</MapBtn>
        <MapBtn label="Ver todo" onClick={() => setView({ x: 0, y: 0, w: width, h: height })}>⤢</MapBtn>
      </div>
      <p className="pointer-events-none absolute bottom-2 left-2 rounded bg-surface/90 px-2 py-1 text-[11px] text-muted">
        Arrastrá el fondo para mover · Ctrl + rueda para zoom{editMode ? " · Arrastrá una carpa para ubicarla · Esc cancela" : ""}
      </p>
    </div>
  );
}

function MapBtn({ label, onClick, children }: { label: string; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="h-9 w-9 rounded-lg border border-line bg-surface text-lg font-semibold text-fg shadow-sm hover:bg-surface-2"
    >
      {children}
    </button>
  );
}

const FEATURE_TEXT: Record<MapFeature["kind"], string> = {
  camino: "#fff8ec",
  pasillo: "#fff8ec",
  instalacion: "#ffffff",
  area_comun: "#5a3a12",
  sector: "var(--fg)",
};

/** Caminos, pasarelas, edificios y áreas comunes del plano. No reciben clics (no tapan las carpas). */
function FeatureShape({ f }: { f: MapFeature }) {
  const w = Number(f.width);
  const h = Number(f.height);
  const isPath = f.kind === "camino" || f.kind === "pasillo";
  const fill = f.color ?? (isPath ? "#9a6a34" : "#d9b77e");
  const vertical = h > w;
  const fontSize = Math.max(14, Math.min(40, (vertical ? w : h) * 0.32, (w / Math.max(4, (f.label ?? "").length)) * 1.6));
  return (
    <g transform={`translate(${Number(f.x)} ${Number(f.y)}) rotate(${Number(f.rotation) || 0})`} pointerEvents="none">
      <rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        rx={isPath ? 2 : 10}
        fill={fill}
        opacity={f.kind === "sector" ? 0.15 : f.kind === "area_comun" ? 0.75 : 1}
        stroke={f.kind === "sector" ? "var(--muted)" : "rgba(0,0,0,0.15)"}
        strokeDasharray={f.kind === "sector" ? "10 8" : undefined}
      />
      {isPath && (
        <rect x={-w / 2} y={-h / 2} width={w} height={h} fill="url(#planks)" opacity={0.35} />
      )}
      {f.label && !isPath && (
        <text
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={fontSize}
          fontWeight={700}
          fill={FEATURE_TEXT[f.kind]}
          transform={vertical && w < 160 ? "rotate(-90)" : undefined}
        >
          {f.label}
        </text>
      )}
    </g>
  );
}
