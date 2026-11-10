"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { designForState, SpaceNumber, SpaceSurname, STATE_COLOR, TENT_H, TENT_W, TentIcon, UMBRELLA_R, UmbrellaIcon, type SpaceState, type TentStyle } from "./icons";
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
  /** Apellido de quien la ocupa ese día (se muestra en el plano). */
  surname?: string | null;
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
  layer?: number;
  version: number;
};

export type Selection = { type: "space" | "feature"; id: string } | null;
export type MapItem = { type: "space" | "feature"; id: string };
export type MapItemPos = MapItem & { x: number; y: number };
export type FeatureGeom = { x: number; y: number; width: number; height: number };

type View = { x: number; y: number; w: number; h: number };
type Drag =
  | { type: "pan"; startX: number; startY: number; view: View; moved: boolean; tap?: Selection }
  | { type: "space"; id: string; dx: number; dy: number; startX: number; startY: number; moved: boolean }
  | { type: "feature"; id: string; dx: number; dy: number; startX: number; startY: number; moved: boolean }
  | { type: "resize"; id: string; startX: number; startY: number; moved: boolean; hx: -1 | 0 | 1; hy: -1 | 0 | 1; g0: FeatureGeom; angle: number }
  | { type: "pinch"; lastDist: number; lastMid: { x: number; y: number } }
  | { type: "group"; anchor: MapItem; startX: number; startY: number; moved: boolean; p0: { x: number; y: number }; items: (MapItemPos & { lo: [number, number]; hi: [number, number] })[] }
  | { type: "marquee"; startX: number; startY: number; moved: boolean; p0: { x: number; y: number }; additive: boolean }
  | { type: "toggle"; item: MapItem; startX: number; startY: number; moved: boolean }
  | null;

const MIN_FEATURE = 16;

/**
 * Plano del balneario, integrado a la página: ocupa todo el ancho y mantiene la proporción del dibujo.
 * - Se puede acercar con los botones, Ctrl + rueda o dos dedos; cuando está acercado, se arrastra para moverse.
 * - En modo edición: arrastrar carpas y elementos (caminos, juegos…), y agrandarlos desde la esquina.
 *   Varias a la vez: arrastrando sobre la arena se encierran en un recuadro; Ctrl + clic suma o quita una.
 *   Con varias elegidas, arrastrar una mueve todas juntas.
 */
export function BeachMap({
  width,
  height,
  seaSide,
  spaces,
  features,
  selected,
  editMode,
  onSelect,
  onMove,
  onFeatureChange,
  group = [],
  onGroupChange,
  onMoveMany,
  overlay,
  design = null,
  guide = null,
  flagged,
}: {
  /** Recuadro punteado sobre el plano (por ejemplo, hasta dónde llega el plano si se achica). */
  guide?: { x: number; y: number; w: number; h: number; label: string } | null;
  /** Carpas o sombrillas marcadas en rojo (por ejemplo, las que quedarían afuera al achicar). */
  flagged?: Set<string>;
  /** Selección múltiple (modo edición). */
  group?: MapItem[];
  onGroupChange?: (items: MapItem[]) => void;
  /** Guarda de una vez la ubicación nueva de varias cosas. */
  onMoveMany?: (items: MapItemPos[]) => Promise<boolean>;
  /** Diseño de carpas y sombrillas (null = el clásico, a rayas según el estado). */
  design?: TentStyle | null;
  width: number;
  height: number;
  seaSide: "top" | "bottom" | "left" | "right";
  spaces: MapSpace[];
  features: MapFeature[];
  selected: Selection;
  editMode: boolean;
  onSelect: (s: Selection) => void;
  onMove: (id: string, x: number, y: number) => Promise<boolean>;
  onFeatureChange: (id: string, g: FeatureGeom) => Promise<boolean>;
  overlay?: ReactNode;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const full = useMemo<View>(() => ({ x: 0, y: 0, w: width, h: height }), [width, height]);
  const [view, setViewRaw] = useState<View>(full);
  const [localSpaces, setLocalSpaces] = useState<Record<string, { x: number; y: number }>>({});
  const [localFeatures, setLocalFeatures] = useState<Record<string, FeatureGeom>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const setSaving = (id: string | null) => setSavingIds(id ? new Set([id]) : new Set());
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const drag = useRef<Drag>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const zoomed = view.w < width - 1;

  /** La vista nunca sale del dibujo: sin bordes grises ni zonas vacías. */
  const clamp = useCallback((v: View): View => {
    const w = Math.min(width, Math.max(width / 10, v.w));
    const h = (w * height) / width;
    return { w, h, x: Math.min(width - w, Math.max(0, v.x)), y: Math.min(height - h, Math.max(0, v.y)) };
  }, [width, height]);
  const setView = useCallback((v: View | ((p: View) => View)) => {
    setViewRaw((prev) => clamp(typeof v === "function" ? v(prev) : v));
  }, [clamp]);

  useEffect(() => setViewRaw(full), [full]);

  // Cuando la base confirma la posición nueva, se descarta la copia local.
  useEffect(() => {
    setLocalSpaces((prev) => {
      const next: typeof prev = {};
      for (const [id, p] of Object.entries(prev)) {
        const s = spaces.find((sp) => sp.space_id === id);
        if (s && (Number(s.x) !== p.x || Number(s.y) !== p.y)) next[id] = p;
      }
      return next;
    });
  }, [spaces]);
  useEffect(() => {
    setLocalFeatures((prev) => {
      const next: typeof prev = {};
      for (const [id, g] of Object.entries(prev)) {
        const f = features.find((x) => x.id === id);
        if (f && (Number(f.x) !== g.x || Number(f.y) !== g.y || Number(f.width) !== g.width || Number(f.height) !== g.height)) next[id] = g;
      }
      return next;
    });
  }, [features]);

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

  const zoomAt = useCallback((cx0: number, cy0: number, factor: number) => {
    setView((v) => {
      const w = v.w * factor;
      const h = (w * height) / width;
      return { x: cx0 - ((cx0 - v.x) * w) / v.w, y: cy0 - ((cy0 - v.y) * h) / v.h, w, h };
    });
  }, [setView, width, height]);

  // Escape: cancela el arrastre en curso.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !drag.current) return;
      const d = drag.current;
      drag.current = null;
      if (d.type === "space") setLocalSpaces((p) => { const n = { ...p }; delete n[d.id]; return n; });
      if (d.type === "feature" || d.type === "resize") setLocalFeatures((p) => { const n = { ...p }; delete n[d.id]; return n; });
      if (d.type === "pan") setView(d.view);
      if (d.type === "group") {
        setLocalSpaces((p) => { const n = { ...p }; d.items.forEach((i) => { if (i.type === "space") delete n[i.id]; }); return n; });
        setLocalFeatures((p) => { const n = { ...p }; d.items.forEach((i) => { if (i.type === "feature") delete n[i.id]; }); return n; });
      }
      if (d.type === "marquee") setMarquee(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView]);

  // Rueda: zoom solo con Ctrl (la rueda sola desplaza la página). Bloqueada durante un arrastre.
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
  }, [toSvg, zoomAt]);

  const unitsPerPx = (v: View) => v.w / svgRef.current!.getBoundingClientRect().width;
  const pinchInfo = () => {
    const [a, b] = [...pointers.current.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };
  const capture = (e: RPointerEvent) => svgRef.current!.setPointerCapture(e.pointerId);
  const spacePos = (s: MapSpace) => localSpaces[s.space_id] ?? { x: Number(s.x), y: Number(s.y) };
  const featGeom = (f: MapFeature): FeatureGeom => localFeatures[f.id] ?? { x: Number(f.x), y: Number(f.y), width: Number(f.width), height: Number(f.height) };

  function onPointerDownCapture(e: RPointerEvent<SVGSVGElement>) {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      e.stopPropagation();
      capture(e);
      const d = drag.current;
      if (d?.type === "space") setLocalSpaces((p) => { const n = { ...p }; delete n[d.id]; return n; });
      if (d?.type === "feature" || d?.type === "resize") setLocalFeatures((p) => { const n = { ...p }; delete n[d.id]; return n; });
      if (d?.type === "group") {
        setLocalSpaces((p) => { const n = { ...p }; d.items.forEach((i) => { if (i.type === "space") delete n[i.id]; }); return n; });
        setLocalFeatures((p) => { const n = { ...p }; d.items.forEach((i) => { if (i.type === "feature") delete n[i.id]; }); return n; });
      }
      if (d?.type === "marquee") setMarquee(null);
      const { dist, mid } = pinchInfo();
      drag.current = { type: "pinch", lastDist: dist, lastMid: mid };
    } else if (pointers.current.size > 2) {
      e.stopPropagation();
    }
  }

  function startPan(e: RPointerEvent, tap?: Selection) {
    capture(e);
    drag.current = { type: "pan", startX: e.clientX, startY: e.clientY, view, moved: false, tap };
  }

  const inGroup = (type: MapItem["type"], id: string) => group.some((g) => g.type === type && g.id === id);
  const multi = editMode && group.length > 1;

  function startMarquee(e: RPointerEvent, additive: boolean) {
    capture(e);
    const p = toSvg(e.clientX, e.clientY);
    drag.current = { type: "marquee", startX: e.clientX, startY: e.clientY, moved: false, p0: p, additive };
  }

  /** Arrastre de todo lo elegido: cada cosa guarda sus límites para que el grupo no se deforme contra los bordes. */
  function startGroup(e: RPointerEvent, anchor: MapItem) {
    capture(e);
    const items = group.flatMap((g) => {
      if (g.type === "space") {
        const s = spaces.find((x) => x.space_id === g.id);
        if (!s) return [];
        const pos = spacePos(s);
        const hw = s.kind === "carpa" ? TENT_W / 2 : UMBRELLA_R;
        const hh = s.kind === "carpa" ? TENT_H / 2 + 9 : UMBRELLA_R;
        return [{ ...g, x: pos.x, y: pos.y, lo: [hw, hh] as [number, number], hi: [width - hw, height - hh] as [number, number] }];
      }
      const f = features.find((x) => x.id === g.id);
      if (!f) return [];
      const fg = featGeom(f);
      return [{ ...g, x: fg.x, y: fg.y, lo: [0, 0] as [number, number], hi: [width, height] as [number, number] }];
    });
    drag.current = { type: "group", anchor, startX: e.clientX, startY: e.clientY, moved: false, p0: toSvg(e.clientX, e.clientY), items };
  }

  function onBgPointerDown(e: RPointerEvent<SVGElement>) {
    if (editMode && e.button === 0) return startMarquee(e, e.ctrlKey || e.metaKey || e.shiftKey);
    // En modo edición, con la rueda apretada o el botón derecho se recorre el plano.
    if (e.button !== 0 && !(editMode && (e.button === 1 || e.button === 2))) return;
    startPan(e, null);
  }

  /** Ctrl/Shift en modo edición: Ctrl + clic suma o quita; Shift + arrastre encierra con un recuadro. */
  function multiPointerDown(e: RPointerEvent, item: MapItem): boolean {
    if (!editMode) return false;
    if (e.shiftKey) { startMarquee(e, true); return true; }
    if (e.ctrlKey || e.metaKey) {
      capture(e);
      drag.current = { type: "toggle", item, startX: e.clientX, startY: e.clientY, moved: false };
      return true;
    }
    if (group.length > 1 && inGroup(item.type, item.id)) { startGroup(e, item); return true; }
    return false;
  }

  function onSpacePointerDown(e: RPointerEvent<SVGGElement>, s: MapSpace) {
    if (e.button !== 0) {
      if (editMode && (e.button === 1 || e.button === 2)) { e.stopPropagation(); startPan(e, null); }
      return;
    }
    e.stopPropagation();
    if (!editMode) return startPan(e, { type: "space", id: s.space_id });
    if (multiPointerDown(e, { type: "space", id: s.space_id })) return;
    capture(e);
    const pos = spacePos(s);
    const p = toSvg(e.clientX, e.clientY);
    drag.current = { type: "space", id: s.space_id, dx: p.x - pos.x, dy: p.y - pos.y, startX: e.clientX, startY: e.clientY, moved: false };
  }

  function onFeaturePointerDown(e: RPointerEvent<SVGGElement>, f: MapFeature) {
    if (!editMode) return;
    if (e.button !== 0) {
      if (e.button === 1 || e.button === 2) { e.stopPropagation(); startPan(e, null); }
      return;
    }
    e.stopPropagation();
    if (multiPointerDown(e, { type: "feature", id: f.id })) return;
    capture(e);
    const g = featGeom(f);
    const p = toSvg(e.clientX, e.clientY);
    drag.current = { type: "feature", id: f.id, dx: p.x - g.x, dy: p.y - g.y, startX: e.clientX, startY: e.clientY, moved: false };
  }

  function onResizePointerDown(e: RPointerEvent<SVGElement>, f: MapFeature, hx: -1 | 0 | 1, hy: -1 | 0 | 1) {
    if (e.button !== 0) return;
    e.stopPropagation();
    capture(e);
    drag.current = { type: "resize", id: f.id, startX: e.clientX, startY: e.clientY, moved: false, hx, hy, g0: featGeom(f), angle: ((Number(f.rotation) || 0) * Math.PI) / 180 };
  }

  function onPointerMove(e: RPointerEvent<SVGSVGElement>) {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = drag.current;
    if (!d) return;
    if (d.type === "pinch") {
      if (pointers.current.size < 2) return;
      const { dist, mid } = pinchInfo();
      if (dist < 10) return;
      const factor = d.lastDist / dist;
      const upp = unitsPerPx(view);
      const dx = (mid.x - d.lastMid.x) * upp;
      const dy = (mid.y - d.lastMid.y) * upp;
      const c = toSvg(mid.x, mid.y);
      setView((v) => {
        const w = v.w * factor;
        const h = (w * height) / width;
        return { x: c.x - ((c.x - v.x) * w) / v.w - dx, y: c.y - ((c.y - v.y) * h) / v.h - dy, w, h };
      });
      d.lastDist = dist;
      d.lastMid = mid;
      return;
    }
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > (e.pointerType === "touch" ? 8 : 4)) d.moved = true;
    if (!d.moved) return;
    const p = toSvg(e.clientX, e.clientY);
    if (d.type === "toggle") return;
    if (d.type === "marquee") {
      setMarquee({ x0: Math.min(d.p0.x, p.x), y0: Math.min(d.p0.y, p.y), x1: Math.max(d.p0.x, p.x), y1: Math.max(d.p0.y, p.y) });
      return;
    }
    if (d.type === "group") {
      let dx = p.x - d.p0.x;
      let dy = p.y - d.p0.y;
      for (const i of d.items) {
        dx = Math.min(i.hi[0] - i.x, Math.max(i.lo[0] - i.x, dx));
        dy = Math.min(i.hi[1] - i.y, Math.max(i.lo[1] - i.y, dy));
      }
      dx = Math.round(dx);
      dy = Math.round(dy);
      const ns: Record<string, { x: number; y: number }> = {};
      const nf: Record<string, FeatureGeom> = {};
      for (const i of d.items) {
        if (i.type === "space") ns[i.id] = { x: Math.round(i.x + dx), y: Math.round(i.y + dy) };
        else {
          const f = features.find((x) => x.id === i.id);
          if (f) nf[i.id] = { ...featGeom(f), x: Math.round(i.x + dx), y: Math.round(i.y + dy) };
        }
      }
      setLocalSpaces((prev) => ({ ...prev, ...ns }));
      setLocalFeatures((prev) => ({ ...prev, ...nf }));
      return;
    }
    if (d.type === "pan") {
      if (!zoomed) return; // sin acercar no hay nada que mover: el dibujo ya entra completo
      const upp = unitsPerPx(d.view);
      setView({ ...d.view, x: d.view.x - (e.clientX - d.startX) * upp, y: d.view.y - (e.clientY - d.startY) * upp });
    } else if (d.type === "space") {
      const s = spaces.find((sp) => sp.space_id === d.id);
      if (!s) return;
      const halfW = s.kind === "carpa" ? TENT_W / 2 : UMBRELLA_R;
      const halfH = s.kind === "carpa" ? TENT_H / 2 + 9 : UMBRELLA_R;
      const x = Math.round(Math.min(width - halfW, Math.max(halfW, p.x - d.dx)));
      const y = Math.round(Math.min(height - halfH, Math.max(halfH, p.y - d.dy)));
      setLocalSpaces((prev) => ({ ...prev, [d.id]: { x, y } }));
    } else if (d.type === "feature") {
      const f = features.find((x) => x.id === d.id);
      if (!f) return;
      const g = featGeom(f);
      const x = Math.round(Math.min(width, Math.max(0, p.x - d.dx)));
      const y = Math.round(Math.min(height, Math.max(0, p.y - d.dy)));
      setLocalFeatures((prev) => ({ ...prev, [d.id]: { ...g, x, y } }));
    } else if (d.type === "resize") {
      // Se estira desde el lado o la esquina tomada; el lado opuesto queda fijo. Respeta la rotación.
      const { g0, angle, hx, hy } = d;
      const vx = p.x - g0.x;
      const vy = p.y - g0.y;
      const lx = vx * Math.cos(-angle) - vy * Math.sin(-angle);
      const ly = vx * Math.sin(-angle) + vy * Math.cos(-angle);
      let w = g0.width;
      let h = g0.height;
      let cxL = 0;
      let cyL = 0;
      if (hx !== 0) {
        w = Math.max(MIN_FEATURE, hx * lx + g0.width / 2);
        cxL = -hx * (g0.width / 2) + hx * (w / 2);
      }
      if (hy !== 0) {
        h = Math.max(MIN_FEATURE, hy * ly + g0.height / 2);
        cyL = -hy * (g0.height / 2) + hy * (h / 2);
      }
      const cx = g0.x + cxL * Math.cos(angle) - cyL * Math.sin(angle);
      const cy = g0.y + cxL * Math.sin(angle) + cyL * Math.cos(angle);
      setLocalFeatures((prev) => ({ ...prev, [d.id]: { x: Math.round(cx), y: Math.round(cy), width: Math.round(w), height: Math.round(h) } }));
    }
  }

  async function onPointerUp(e: RPointerEvent<SVGSVGElement>) {
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    if (d?.type === "pinch") {
      if (pointers.current.size === 0) drag.current = null;
      return;
    }
    drag.current = null;
    if (!d) return;
    if (d.type === "pan") {
      if (!d.moved) onSelect(d.tap ?? null);
      return;
    }
    if (d.type === "toggle") {
      if (d.moved) return;
      const has = inGroup(d.item.type, d.item.id);
      // La que estaba abierta sola también cuenta como elegida.
      const base = group.length ? group : selected ? [selected] : [];
      const next = has ? base.filter((g) => !(g.type === d.item.type && g.id === d.item.id))
        : base.some((g) => g.type === d.item.type && g.id === d.item.id) ? base.filter((g) => !(g.type === d.item.type && g.id === d.item.id)) : [...base, d.item];
      onGroupChange?.(next);
      return;
    }
    if (d.type === "marquee") {
      setMarquee(null);
      if (!d.moved) { if (!d.additive) onSelect(null); return; }
      const p = toSvg(e.clientX, e.clientY);
      const r = { x0: Math.min(d.p0.x, p.x), y0: Math.min(d.p0.y, p.y), x1: Math.max(d.p0.x, p.x), y1: Math.max(d.p0.y, p.y) };
      const inside = (x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
      const found: MapItem[] = [
        ...spaces.filter((s) => { const q = spacePos(s); return inside(q.x, q.y); }).map((s) => ({ type: "space" as const, id: s.space_id })),
        ...features.filter((f) => { const g = featGeom(f); return inside(g.x, g.y); }).map((f) => ({ type: "feature" as const, id: f.id })),
      ];
      const base = d.additive ? (group.length ? group : selected ? [selected] : []) : [];
      const next = [...base, ...found.filter((f) => !base.some((b) => b.type === f.type && b.id === f.id))];
      onGroupChange?.(next);
      return;
    }
    if (d.type === "group") {
      if (!d.moved) { onSelect(d.anchor); return; } // clic sin arrastrar: queda elegida solo esa
      const moved: MapItemPos[] = d.items.map((i) => {
        const l = i.type === "space" ? localSpaces[i.id] : localFeatures[i.id];
        return { type: i.type, id: i.id, x: l?.x ?? i.x, y: l?.y ?? i.y };
      });
      const clear = () => {
        setLocalSpaces((p) => { const n = { ...p }; d.items.forEach((i) => { if (i.type === "space") delete n[i.id]; }); return n; });
        setLocalFeatures((p) => { const n = { ...p }; d.items.forEach((i) => { if (i.type === "feature") delete n[i.id]; }); return n; });
      };
      if (!onMoveMany) return clear();
      setSavingIds(new Set(d.items.map((i) => i.id)));
      const ok = await onMoveMany(moved);
      setSavingIds(new Set());
      if (!ok) clear();
      return;
    }
    if (!d.moved) {
      onSelect({ type: d.type === "space" ? "space" : "feature", id: d.id });
      return;
    }
    if (d.type === "space") {
      const pos = localSpaces[d.id];
      if (!pos) return;
      setSaving(d.id);
      const ok = await onMove(d.id, pos.x, pos.y);
      setSaving(null);
      if (!ok) setLocalSpaces((p) => { const n = { ...p }; delete n[d.id]; return n; });
      return;
    }
    const g = localFeatures[d.id];
    if (!g) return;
    onSelect({ type: "feature", id: d.id });
    setSaving(d.id);
    const ok = await onFeatureChange(d.id, g);
    setSaving(null);
    if (!ok) setLocalFeatures((p) => { const n = { ...p }; delete n[d.id]; return n; });
  }

  const sea = useMemo(() => {
    // Franja de mar: 17% del plano, con un máximo, para que al agrandar el plano el mar no "avance" sobre la arena.
    const band = Math.min(400, Math.round((seaSide === "top" || seaSide === "bottom" ? height : width) * 0.17));
    switch (seaSide) {
      case "bottom": return { x: 0, y: height - band, w: width, h: band, shore: "h" as const, shoreAt: height - band };
      case "left": return { x: 0, y: 0, w: band, h: height, shore: "v" as const, shoreAt: band };
      case "right": return { x: width - band, y: 0, w: band, h: height, shore: "v" as const, shoreAt: width - band };
      default: return { x: 0, y: 0, w: width, h: band, shore: "h" as const, shoreAt: band };
    }
  }, [seaSide, width, height]);

  const selSpace = selected?.type === "space" ? selected.id : null;
  const selFeature = selected?.type === "feature" ? selected.id : null;
  const saving = (id: string) => savingIds.has(id);

  return (
    <div className="relative" ref={wrapRef}>
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        style={{ aspectRatio: `${width} / ${height}`, touchAction: zoomed || editMode ? "none" : "pan-y" }}
        className={cx("block w-full select-none rounded-2xl", zoomed && "cursor-grab")}
        onPointerDownCapture={onPointerDownCapture}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(e) => { pointers.current.delete(e.pointerId); if (pointers.current.size === 0) drag.current = null; }}
        onContextMenu={(e) => { if (editMode || zoomed) e.preventDefault(); }}
        role="img"
        aria-label="Plano del balneario"
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
            <line x1="0" y1="0" x2="0" y2="14" stroke="#3b2410" strokeWidth="2" />
          </pattern>
          <clipPath id="map-clip"><rect x={0} y={0} width={width} height={height} /></clipPath>
          <clipPath id="tent-clip"><rect x={-TENT_W / 2} y={-TENT_H / 2} width={TENT_W} height={TENT_H} rx={8} /></clipPath>
        </defs>

        <g clipPath="url(#map-clip)">
          <rect x={0} y={0} width={width} height={height} fill="url(#sand)" onPointerDown={onBgPointerDown} />
          <rect x={sea.x} y={sea.y} width={sea.w} height={sea.h} fill="url(#sea)" onPointerDown={onBgPointerDown} />
          {/* espuma de la orilla (recortada al dibujo) */}
          {sea.shore === "h" ? (
            <path d={`M0 ${sea.shoreAt} ${Array.from({ length: Math.ceil(width / 60) }, () => `q 15 ${seaSide === "top" ? 10 : -10} 30 0 t 30 0`).join(" ")}`}
              fill="none" stroke="var(--foam)" strokeWidth={6} opacity={0.9} pointerEvents="none" />
          ) : (
            <path d={`M${sea.shoreAt} 0 ${Array.from({ length: Math.ceil(height / 60) }, () => `q ${seaSide === "left" ? 10 : -10} 15 0 30 t 0 30`).join(" ")}`}
              fill="none" stroke="var(--foam)" strokeWidth={6} opacity={0.9} pointerEvents="none" />
          )}
          <text x={sea.x + sea.w / 2} y={sea.y + sea.h / 2} textAnchor="middle" dominantBaseline="middle" fill="var(--foam)"
            fontSize={56} fontWeight={700} opacity={0.6} pointerEvents="none" letterSpacing={18}>MAR</text>

          {[...features].sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0)).map((f) => (
            <FeatureShape
              key={f.id}
              f={f}
              g={featGeom(f)}
              editable={editMode}
              selected={selFeature === f.id && !multi}
              grouped={multi && inGroup("feature", f.id)}
              saving={saving(f.id)}
              onPointerDown={(e) => onFeaturePointerDown(e, f)}
              onResizeDown={(e, hx, hy) => onResizePointerDown(e, f, hx, hy)}
            />
          ))}

          {spaces.map((s) => {
            const pos = spacePos(s);
            const color = STATE_COLOR[s.state];
            const dsg = designForState(s.state, design);
            const surname = (s.state === "ocupada" || s.state === "cortesia") && s.surname ? s.surname : null;
            return (
              <g
                key={s.space_id}
                transform={`translate(${pos.x} ${pos.y})`}
                onPointerDown={(e) => onSpacePointerDown(e, s)}
                className={editMode ? "cursor-move" : "cursor-pointer"}
                opacity={saving(s.space_id) ? 0.6 : 1}
                tabIndex={0}
                role="button"
                aria-label={`${s.kind === "carpa" ? "Carpa" : "Sombrilla"} ${s.code}`}
                data-state={s.state}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect({ type: "space", id: s.space_id }); }}
              >
                <g transform={`rotate(${Number(s.rotation) || 0})`}>
                  {s.kind === "carpa"
                    ? <TentIcon color={color} selected={selSpace === s.space_id || (multi && inGroup("space", s.space_id))} dashed={s.state === "desactivada"} design={dsg} />
                    : <UmbrellaIcon color={color} selected={selSpace === s.space_id || (multi && inGroup("space", s.space_id))} dashed={s.state === "desactivada"} design={dsg} />}
                </g>
                {flagged?.has(s.space_id) && (
                  <circle r={s.kind === "carpa" ? 62 : UMBRELLA_R + 16} fill="none" stroke="var(--danger)" strokeWidth={6} strokeDasharray="12 8" pointerEvents="none" />
                )}
                <SpaceNumber code={s.code} color={color} design={dsg} dy={surname ? -9 : 0} />
                {surname && <SpaceSurname name={surname} kind={s.kind} />}
              </g>
            );
          })}

          {guide && (
            <g pointerEvents="none">
              <rect x={guide.x} y={guide.y} width={guide.w} height={guide.h} fill="none" stroke="var(--danger)"
                strokeWidth={Math.max(4, view.w / 300)} strokeDasharray="24 14" opacity={0.85} />
              <text x={guide.x + guide.w / 2} y={guide.y + Math.max(40, view.w / 40)} textAnchor="middle" fontSize={Math.max(26, view.w / 55)} fontWeight={800}
                fill="var(--danger)" stroke="#ffffff" strokeWidth={5} paintOrder="stroke">{guide.label}</text>
            </g>
          )}

          {marquee && (
            <rect x={marquee.x0} y={marquee.y0} width={marquee.x1 - marquee.x0} height={marquee.y1 - marquee.y0}
              fill="var(--accent)" fillOpacity={0.12} stroke="var(--accent)" strokeWidth={Math.max(2, view.w / 400)} strokeDasharray="10 6" pointerEvents="none" />
          )}
        </g>
      </svg>

      {overlay}

      <div className="absolute right-3 top-3 flex gap-1 print:hidden">
        <MapBtn label="Acercar" onClick={() => zoomAt(view.x + view.w / 2, view.y + view.h / 2, 0.75)}>+</MapBtn>
        <MapBtn label="Alejar" onClick={() => zoomAt(view.x + view.w / 2, view.y + view.h / 2, 1 / 0.75)} disabled={!zoomed}>−</MapBtn>
        {zoomed && <MapBtn label="Ver todo el plano" onClick={() => setView(full)}>⤢</MapBtn>}
      </div>
      {zoomed && !editMode && (
        <p className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-surface/90 px-2 py-1 text-[11px] text-muted print:hidden">
          Arrastrá para recorrer el plano.
        </p>
      )}
      {editMode && <Shortcuts />}
    </div>
  );
}

/** Atajos del editor, arriba a la derecha y discretos (se pueden plegar). */
function Shortcuts() {
  const [open, setOpen] = useState(true);
  const rows: [string, string][] = [
    ["Arrastrar", "mover"],
    ["Arrastrar sobre la arena", "elegir varias"],
    ["Ctrl + clic", "sumar o sacar una"],
    ["Ctrl + A", "elegir todo (para moverlo)"],
    ["Ctrl + C / Ctrl + V", "copiar caminos y elementos"],
    ["Esc", "soltar la selección"],
    ["Botón derecho", "recorrer el plano"],
    ["Ctrl + rueda", "acercar o alejar"],
  ];
  return (
    <div className="absolute right-3 top-14 z-[1] max-w-[15rem] rounded-xl border border-line/60 bg-surface/75 text-[11px] leading-snug text-muted shadow-sm backdrop-blur print:hidden">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 font-semibold uppercase tracking-wider" aria-expanded={open}>
        Atajos <span aria-hidden>{open ? "−" : "+"}</span>
      </button>
      {open && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 px-2.5 pb-2">
          {rows.map(([k, v]) => (<Fragment key={k}><dt className="whitespace-nowrap font-semibold text-fg/80">{k}</dt><dd>{v}</dd></Fragment>))}
        </dl>
      )}
    </div>
  );
}

function MapBtn({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} disabled={disabled}
      className="h-9 w-9 rounded-lg bg-surface/90 text-lg font-semibold text-fg shadow-sm backdrop-blur hover:bg-surface disabled:opacity-40">
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

export const FEATURE_KIND_LABEL: Record<MapFeature["kind"], string> = {
  camino: "Camino / pasarela",
  pasillo: "Pasillo",
  area_comun: "Área común (juegos, patio…)",
  instalacion: "Instalación (bar, baños…)",
  sector: "Sector (zona marcada)",
};

/** Caminos, pasarelas, edificios y áreas comunes. Solo se pueden tocar en modo edición. */
function FeatureShape({ f, g, editable, selected, grouped, saving, onPointerDown, onResizeDown }: {
  f: MapFeature; g: FeatureGeom; editable: boolean; selected: boolean; grouped?: boolean; saving: boolean;
  onPointerDown: (e: RPointerEvent<SVGGElement>) => void;
  onResizeDown: (e: RPointerEvent<SVGElement>, hx: -1 | 0 | 1, hy: -1 | 0 | 1) => void;
}) {
  const w = g.width;
  const h = g.height;
  const isPath = f.kind === "camino" || f.kind === "pasillo";
  const fill = f.color ?? (isPath ? "#9a6a34" : "#d9b77e");
  const vertical = h > w;
  const fontSize = Math.max(16, Math.min(46, (vertical ? w : h) * 0.32, (Math.max(w, h) / Math.max(4, (f.label ?? "").length)) * 1.5));
  return (
    <g transform={`translate(${g.x} ${g.y}) rotate(${Number(f.rotation) || 0})`}
      pointerEvents={editable ? "auto" : "none"} onPointerDown={onPointerDown}
      className={editable ? "cursor-move" : undefined} opacity={saving ? 0.6 : 1}>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={isPath ? 3 : 12} fill={fill}
        opacity={f.kind === "sector" ? 0.15 : f.kind === "area_comun" ? 0.8 : 1}
        stroke={f.kind === "sector" ? "var(--muted)" : "rgba(0,0,0,0.15)"} strokeDasharray={f.kind === "sector" ? "10 8" : undefined} />
      {isPath && <rect x={-w / 2} y={-h / 2} width={w} height={h} fill="url(#planks)" opacity={0.35} pointerEvents="none" />}
      {f.label && !isPath && (
        <text textAnchor="middle" dominantBaseline="middle" fontSize={fontSize} fontWeight={700} fill={FEATURE_TEXT[f.kind]}
          transform={vertical && w < 180 ? "rotate(-90)" : undefined} pointerEvents="none">
          {f.label}
        </text>
      )}
      {editable && grouped && (
        <rect x={-w / 2 - 6} y={-h / 2 - 6} width={w + 12} height={h + 12} rx={14} fill="none" stroke="var(--accent)" strokeWidth={4} strokeDasharray="12 8" pointerEvents="none" />
      )}
      {editable && selected && (
        <>
          <rect x={-w / 2 - 6} y={-h / 2 - 6} width={w + 12} height={h + 12} rx={14} fill="none" stroke="var(--accent)" strokeWidth={4} strokeDasharray="12 8" pointerEvents="none" />
          {HANDLES.map(([hx, hy]) => {
            const side = hx === 0 || hy === 0;
            const px = (hx * (w + 12)) / 2;
            const py = (hy * (h + 12)) / 2;
            return (
              <g key={`${hx}${hy}`} transform={`translate(${px} ${py})`} onPointerDown={(e) => onResizeDown(e, hx, hy)} style={{ cursor: handleCursor(hx, hy, Number(f.rotation) || 0) }}>
                {/* zona de agarre amplia e invisible */}
                <circle r={34} fill="transparent" />
                {side
                  ? <rect x={hx === 0 ? -26 : -11} y={hy === 0 ? -26 : -11} width={hx === 0 ? 52 : 22} height={hy === 0 ? 52 : 22} rx={8} fill="#fff" stroke="var(--accent)" strokeWidth={5} />
                  : <circle r={14} fill="var(--accent)" stroke="#fff" strokeWidth={4} />}
              </g>
            );
          })}
        </>
      )}
    </g>
  );
}

const HANDLES: [-1 | 0 | 1, -1 | 0 | 1][] = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [1, -1], [-1, 1], [1, 1],
];

function handleCursor(hx: number, hy: number, rotation: number): string {
  // Ángulo de la agarradera en pantalla para elegir la flecha de cursor adecuada.
  const a = ((Math.atan2(hy, hx) * 180) / Math.PI + rotation + 360) % 180;
  if (a < 22.5 || a >= 157.5) return "ew-resize";
  if (a < 67.5) return "nwse-resize";
  if (a < 112.5) return "ns-resize";
  return "nesw-resize";
}
