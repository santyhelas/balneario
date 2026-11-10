"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { addDays, formatDate, formatMoney, todayISO } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, ConfirmDialog, Field, Input, Modal, Select, Spinner, Textarea, TextField } from "@/components/ui";
import { BeachMap, FEATURE_KIND_LABEL, type MapFeature, type MapItem, type MapItemPos, type MapSpace, type Selection } from "@/components/map/BeachMap";
import { WeatherStrip, WindCompass, type CompassLayout } from "@/components/weather";
import { RelocateModal } from "@/components/relocate";
import { loadReservation, type Full } from "@/lib/reservations";
import { DEFAULT_TENT_STYLE, normalizeTentStyle, STATE_COLOR, STATE_LABEL, type SpaceState, type TentStyle } from "@/components/map/icons";
import { TentDesigner } from "@/components/map/TentDesigner";

type DayStatus = MapSpace & {
  rotation: number;
  active: boolean;
  reservation_id: string | null;
  reservation_number: number | null;
  customer_name: string | null;
  reservation_start: string | null;
  reservation_end: string | null;
  days_remaining: number | null;
  due_amount: number | null;
  maintenance_reason: string | null;
  maintenance_end: string | null;
  next_start: string | null;
};

const STATES: SpaceState[] = ["disponible", "ocupada", "reservada_futura", "cortesia", "mantenimiento", "desactivada"];

export default function MapaPage() {
  const { ws, isAdmin, reloadWorkspace } = useWorkspace();
  const sb = getSupabase();
  const today = todayISO(ws.timezone);
  const [day, setDay] = useState(today);
  // Desde el Panel ("Próximos 7 días") se puede abrir el mapa en un día puntual: /mapa?dia=AAAA-MM-DD
  useEffect(() => {
    const d = new URLSearchParams(window.location.search).get("dia");
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) setDay(d);
  }, []);
  const [layoutConfirm, setLayoutConfirm] = useState(false);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [sel, setSelRaw] = useState<Selection>(null);
  /** Varias cosas elegidas a la vez (modo edición). */
  const [group, setGroupRaw] = useState<MapItem[]>([]);
  const setSel = (v: Selection) => { setSelRaw(v); setGroupRaw(v ? [v] : []); };
  const setGroup = (items: MapItem[]) => { setGroupRaw(items); setSelRaw(items.length === 1 ? items[0] : null); };
  /** Lo copiado con Ctrl + C (y cuántas veces se pegó, para correr cada copia un poco más). */
  const clip = useRef<{ items: MapItem[]; pastes: number } | null>(null);
  const [clipCount, setClipCount] = useState(0);
  const [pasting, setPasting] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [message, setMessage] = useState<{ tone: "danger" | "ok"; text: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const { data, error, loading, reload, stale, updatedAt } = useLoader<DayStatus[]>(
    async () => {
      const rows = unwrap(await sb.rpc("map_day_status", { p_workspace_id: ws.id, p_day: day })) as DayStatus[];
      // Amarillo solo el día anterior a que empiece la reserva; antes de eso se ve libre.
      const tomorrow = addDays(day, 1);
      for (const r of rows) {
        if (r.state === "reservada_futura" && r.next_start !== tomorrow) r.state = "disponible";
      }
      // Apellido de quien ocupa cada espacio ese día.
      const ids = [...new Set(rows.filter((r) => r.reservation_id && (r.state === "ocupada" || r.state === "cortesia")).map((r) => r.reservation_id!))];
      if (ids.length) {
        const res = unwrap(await sb.from("reservations").select("id, customers(last_name, first_name)").in("id", ids)) as unknown as
          { id: string; customers: { last_name: string | null; first_name: string } | null }[];
        const byId = new Map(res.map((x) => [x.id, (x.customers?.last_name || x.customers?.first_name || "").replace(/\s*\(.*\)\s*$/, "").trim()]));
        for (const r of rows) if (r.reservation_id) r.surname = byId.get(r.reservation_id) || null;
      }
      return rows;
    },
    [ws.id, day],
  );

  // Cantidad contratada (null = sin límite; sin la actualización 0039 tampoco hay límite).
  const limitsQ = useLoader<{ carpa: number | null; sombrilla: number | null }>(
    async () => {
      const res = await sb.from("workspaces").select("max_tents, max_umbrellas").eq("id", ws.id).single();
      if (res.error) return { carpa: null, sombrilla: null };
      const r = res.data as { max_tents: number | null; max_umbrellas: number | null };
      return { carpa: r.max_tents, sombrilla: r.max_umbrellas };
    },
    [ws.id],
    0,
  );

  const featuresQ = useLoader<MapFeature[]>(
    async () => {
      const q = (cols: string) => sb.from("map_features").select(cols).eq("workspace_id", ws.id).eq("active", true).order("created_at");
      let res = await q("id, kind, label, x, y, width, height, rotation, color, layer, version");
      // Sin la actualización 0014 todavía no existe la columna de capas.
      if (res.error?.code === "42703") res = await q("id, kind, label, x, y, width, height, rotation, color, version");
      return unwrap(res) as unknown as MapFeature[];
    },
    [ws.id],
    0,
  );

  // Diseño de las carpas: se lee aparte para que el plano funcione aunque falte la actualización 0015.
  const [design, setDesign] = useState<TentStyle | null>(null);
  const [designReady, setDesignReady] = useState(false);
  const [resizing, setResizing] = useState(false);
  /** Mostrar hasta dónde llega el plano si se achica (y qué queda afuera). */
  const [showLimit, setShowLimit] = useState(false);
  const [hoverShrink, setHoverShrink] = useState(false);
  /** Agranda o achica el plano: lo que está cerca del mar queda cerca del mar; el lugar nuevo va del lado de tierra. */
  async function resize(factor: number) {
    const w = Math.round(Math.min(20000, Math.max(400, ws.map_width * factor)));
    const h = Math.round(Math.min(20000, Math.max(400, ws.map_height * factor)));
    if (w === ws.map_width && h === ws.map_height) return;
    setResizing(true);
    setMessage(null);
    const { error } = await getSupabase().rpc("resize_map", { p_workspace_id: ws.id, p_width: w, p_height: h, p_expected_version: ws.version });
    setResizing(false);
    if (error) {
      setMessage({ tone: "danger", text: error.code === "PGRST202" ? "Para cambiar el tamaño del plano hay que aplicar la actualización 0033." : `${friendlyError(error)} La línea roja punteada marca hasta dónde llegaría el plano; lo marcado en rojo queda afuera.` });
      if (factor < 1) setShowLimit(true);
      return;
    }
    setShowLimit(false);
    setMessage({ tone: "ok", text: factor > 1 ? "Listo: el plano es más grande. Hay más lugar para carpas (se ve más alejado; acercate con +)." : "Listo: el plano es más chico." });
    await reloadWorkspace();
    reload();
    featuresQ.reload();
  }
  const [designOpen, setDesignOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    sb.from("workspaces").select("tent_style").eq("id", ws.id).single().then(({ data: row, error: err }) => {
      if (!alive || err) return;
      const raw = (row as { tent_style: unknown }).tent_style;
      setDesign(raw ? normalizeTentStyle(raw) : null);
      setDesignReady(true);
    });
    return () => { alive = false; };
  }, [sb, ws.id]);

  async function saveDesign(next: TentStyle | null): Promise<boolean> {
    const cur = await sb.from("workspaces").select("version").eq("id", ws.id).single();
    const { data: upd, error: err } = cur.error
      ? { data: null, error: cur.error }
      : await sb.from("workspaces").update({ tent_style: next, version: (cur.data as { version: number }).version + 1 }).eq("id", ws.id).select("id");
    if (err || !upd?.length) {
      setMessage({ tone: "danger", text: err ? friendlyError(err) : "No se pudo guardar el diseño. Volvé a intentarlo." });
      return false;
    }
    setDesign(next);
    setMessage({ tone: "ok", text: "Listo: se guardó el diseño de las carpas y sombrillas." });
    await reloadWorkspace();
    return true;
  }

  // Brújula: lugar y tamaño sobre el plano (sin la actualización 0041 queda en su lugar de siempre).
  const [compass, setCompass] = useState<CompassLayout | null>(null);
  const [compassReady, setCompassReady] = useState(false);
  useEffect(() => {
    let alive = true;
    sb.from("workspaces").select("compass_layout").eq("id", ws.id).single().then(({ data: row, error: err }) => {
      if (!alive || err) return;
      const c = (row as { compass_layout: CompassLayout | null }).compass_layout;
      setCompass(c && typeof c.x === "number" && typeof c.y === "number" && typeof c.scale === "number" ? c : null);
      setCompassReady(true);
    });
    return () => { alive = false; };
  }, [sb, ws.id]);
  async function saveCompass(next: CompassLayout | null) {
    setCompass(next);
    const cur = await sb.from("workspaces").select("version").eq("id", ws.id).single();
    const res = cur.error ? cur : await sb.from("workspaces").update({ compass_layout: next, version: (cur.data as { version: number }).version + 1 }).eq("id", ws.id).select("id");
    if (res.error) setMessage({ tone: "danger", text: `No se guardó la brújula: ${friendlyError(res.error)}` });
    else await reloadWorkspace();
  }

  // Foto del plano al entrar a editar, para poder dejar todo como estaba.
  type Snapshot = {
    width: number; height: number; design: TentStyle | null; compass: CompassLayout | null;
    spaces: { id: string; x: number; y: number; rotation: number; code: string; active: boolean }[];
    features: { id: string; kind: MapFeature["kind"]; label: string | null; x: number; y: number; width: number; height: number; rotation: number; color: string | null; layer?: number }[];
  };
  const snapshot = useRef<Snapshot | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  function startEditing() {
    snapshot.current = {
      width: ws.map_width, height: ws.map_height, design, compass,
      spaces: (data ?? []).map((x) => ({ id: x.space_id, x: Number(x.x), y: Number(x.y), rotation: Number(x.rotation) || 0, code: x.code, active: x.active })),
      features: (featuresQ.data ?? []).map((f) => ({ id: f.id, kind: f.kind, label: f.label, x: Number(f.x), y: Number(f.y), width: Number(f.width), height: Number(f.height), rotation: Number(f.rotation) || 0, color: f.color, layer: f.layer })),
    };
    setEditMode(true);
  }
  /** Vuelve el plano a como estaba al tocar «Editar plano» (ubicaciones, tamaños, nombres, elementos, diseño y brújula). */
  async function restoreSnapshot() {
    const snap = snapshot.current;
    if (!snap) return;
    setRestoring(true);
    setMessage(null);
    const problems: string[] = [];
    try {
      // 1) Tamaño del plano (corre todo junto), 2) ubicaciones exactas, 3) el resto de los datos.
      if (snap.width !== ws.map_width || snap.height !== ws.map_height) {
        const cur = await sb.from("workspaces").select("version").eq("id", ws.id).single();
        const r = cur.error ? cur : await sb.rpc("resize_map", { p_workspace_id: ws.id, p_width: snap.width, p_height: snap.height, p_expected_version: (cur.data as { version: number }).version });
        if (r.error) problems.push(`tamaño del plano: ${friendlyError(r.error)}`);
      }
      const spRows = unwrap(await sb.from("spaces").select("id, x, y, rotation, code, active, version").eq("workspace_id", ws.id)) as
        { id: string; x: number; y: number; rotation: number; code: string; active: boolean; version: number }[];
      const ftRows = unwrap(await sb.from("map_features").select("*").eq("workspace_id", ws.id)) as unknown as (MapFeature & { active: boolean })[];
      const spById = new Map(spRows.map((r) => [r.id, r]));
      const moves = snap.spaces.filter((o) => { const c = spById.get(o.id); return c && (Number(c.x) !== o.x || Number(c.y) !== o.y); })
        .map((o) => ({ type: "space", id: o.id, x: o.x, y: o.y, version: spById.get(o.id)!.version }));
      if (moves.length) {
        const r = await sb.rpc("move_map_items", { p_workspace_id: ws.id, p_items: moves });
        if (r.error) problems.push(`ubicaciones: ${friendlyError(r.error)}`);
      }
      const spRows2 = moves.length ? unwrap(await sb.from("spaces").select("id, x, y, rotation, code, active, version").eq("workspace_id", ws.id)) as typeof spRows : spRows;
      for (const o of snap.spaces) {
        const c = spRows2.find((r) => r.id === o.id);
        if (!c) continue;
        const patch: Record<string, unknown> = {};
        if ((Number(c.rotation) || 0) !== o.rotation) patch.rotation = o.rotation;
        if (c.code !== o.code) patch.code = o.code;
        if (c.active !== o.active) patch.active = o.active;
        if (!Object.keys(patch).length) continue;
        const r = await sb.from("spaces").update({ ...patch, version: c.version + 1 }).eq("id", o.id).select("id").single();
        if (r.error) problems.push(`${o.code}: ${friendlyError(r.error)}`);
      }
      // Carpas o sombrillas agregadas durante la edición: se desactivan (no se borran, por el historial).
      for (const c of spRows2.filter((r) => r.active && !snap.spaces.some((o) => o.id === r.id))) {
        const r = await sb.from("spaces").update({ active: false, version: c.version + 1 }).eq("id", c.id).select("id").single();
        if (r.error) problems.push(`${c.code}: ${friendlyError(r.error)}`);
      }
      for (const o of snap.features) {
        const c = ftRows.find((r) => r.id === o.id);
        if (!c) continue;
        const same = c.active && c.kind === o.kind && (c.label ?? null) === o.label && Number(c.x) === o.x && Number(c.y) === o.y && Number(c.width) === o.width
          && Number(c.height) === o.height && (Number(c.rotation) || 0) === o.rotation && (c.color ?? null) === o.color && (o.layer === undefined || (c.layer ?? 0) === (o.layer ?? 0));
        if (same) continue;
        const { id: _id, ...rest } = o;
        void _id;
        const r = await sb.from("map_features").update({ ...rest, active: true, version: c.version + 1 }).eq("id", o.id).select("id").single();
        if (r.error) problems.push(`elemento: ${friendlyError(r.error)}`);
      }
      for (const c of ftRows.filter((r) => r.active && !snap.features.some((o) => o.id === r.id))) {
        const r = await sb.from("map_features").update({ active: false, version: c.version + 1 }).eq("id", c.id).select("id").single();
        if (r.error) problems.push(`elemento: ${friendlyError(r.error)}`);
      }
      if (JSON.stringify(snap.design) !== JSON.stringify(design)) await saveDesign(snap.design);
      if (JSON.stringify(snap.compass) !== JSON.stringify(compass)) await saveCompass(snap.compass);
    } catch (e) {
      problems.push(friendlyError(e));
    }
    setRestoring(false);
    setRestoreOpen(false);
    setGroup([]);
    await reloadWorkspace();
    await Promise.all([reload(), featuresQ.reload()]);
    setMessage(problems.length
      ? { tone: "danger", text: `Se volvió atrás casi todo, pero no se pudo: ${problems.slice(0, 4).join(" · ")}${problems.length > 4 ? "…" : ""}` }
      : { tone: "ok", text: "Listo: el plano quedó como estaba antes de editar." });
  }

  async function applyLayout() {
    setLayoutBusy(true);
    const { data: res, error } = await sb.rpc("apply_parador_layout", { p_workspace_id: ws.id });
    setLayoutBusy(false);
    setLayoutConfirm(false);
    if (error) return setMessage({ tone: "danger", text: friendlyError(error) });
    setMessage({ tone: "ok", text: `Listo: se ubicaron ${(res as { espacios_ubicados: number }).espacios_ubicados} espacios según el plano del parador.` });
    setSel(null);
    await reloadWorkspace();
    featuresQ.reload();
    reload();
  }

  const spaces = data ?? [];
  const usage = {
    carpa: { used: spaces.filter((x) => x.kind === "carpa" && x.state !== "desactivada").length, max: limitsQ.data?.carpa ?? null },
    sombrilla: { used: spaces.filter((x) => x.kind === "sombrilla" && x.state !== "desactivada").length, max: limitsQ.data?.sombrilla ?? null },
  };
  const features = featuresQ.data ?? [];
  const selectedSpace = sel?.type === "space" ? spaces.find((s) => s.space_id === sel.id) ?? null : null;
  const selectedFeature = sel?.type === "feature" ? features.find((f) => f.id === sel.id) ?? null : null;

  // Fuera del modo edición no se seleccionan elementos del plano ni varias cosas a la vez.
  useEffect(() => {
    if (!editMode && sel?.type === "feature") setSel(null);
    if (!editMode && group.length > 1) setGroup([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, sel, group.length]);

  // Copiar y pegar es solo para caminos y elementos: las carpas y sombrillas no se duplican (son las del plan).
  function copyGroup() {
    const items = (group.length ? group : sel ? [sel] : []).filter((i) => i.type === "feature");
    if (!items.length) {
      setMessage({ tone: "danger", text: "Las carpas y sombrillas no se copian: solo se mueven. Copiar y pegar sirve para caminos, juegos y otros elementos." });
      return;
    }
    clip.current = { items, pastes: 0 };
    setClipCount(items.length);
  }

  async function pasteClip() {
    const c = clip.current;
    if (!c || pasting) return;
    setPasting(true);
    setMessage(null);
    const off = 40 * (c.pastes + 1);
    const { data: res, error: err } = await sb.rpc("paste_map_items", { p_workspace_id: ws.id, p_items: c.items, p_dx: off, p_dy: off });
    setPasting(false);
    if (err) {
      setMessage({ tone: "danger", text: err.code === "PGRST202" ? "Para copiar y pegar hay que aplicar la actualización 0036 de la base de datos." : friendlyError(err) });
      return;
    }
    c.pastes += 1;
    const created = res as MapItem[];
    await Promise.all([reload(), featuresQ.reload()]);
    setGroup(created);
    setMessage({ tone: "ok", text: `Pegado: ${created.length === 1 ? "1 copia" : `${created.length} copias`}. Ya quedaron elegidas: arrastralas a su lugar.` });
  }

  async function moveMany(items: MapItemPos[]): Promise<boolean> {
    const payload = items.map((i) => ({
      ...i,
      version: i.type === "space" ? spaces.find((s) => s.space_id === i.id)?.version : features.find((f) => f.id === i.id)?.version,
    }));
    const { error: err } = await sb.rpc("move_map_items", { p_workspace_id: ws.id, p_items: payload });
    if (err) {
      setMessage({ tone: "danger", text: err.code === "PGRST202" ? "Para mover varias cosas juntas hay que aplicar la actualización 0036 de la base de datos." : `No se guardó: ${friendlyError(err)}` });
      reload();
      featuresQ.reload();
      return false;
    }
    setMessage(null);
    await Promise.all([reload(), featuresQ.reload()]);
    return true;
  }

  // Atajos del modo edición: Ctrl + C, Ctrl + V, Ctrl + A y Esc (fuera de los campos de texto).
  const keys = useRef({ copyGroup, pasteClip, setGroup, spaces, features, group });
  keys.current = { copyGroup, pasteClip, setGroup, spaces, features, group };
  useEffect(() => {
    if (!editMode || !isAdmin) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable=true]") || t.closest("[role=dialog]"))) return;
      const k = keys.current;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "c" && k.group.length) { e.preventDefault(); k.copyGroup(); }
      else if (mod && e.key.toLowerCase() === "v" && clip.current) { e.preventDefault(); void k.pasteClip(); }
      else if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        k.setGroup([...k.spaces.map((x) => ({ type: "space" as const, id: x.space_id })), ...k.features.map((f) => ({ type: "feature" as const, id: f.id }))]);
      } else if (e.key === "Escape" && k.group.length > 1) k.setGroup([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editMode, isAdmin]);

  // En pantallas chicas la ficha de edición queda debajo del plano: bajar hasta ella.
  useEffect(() => {
    if (!sel || !editMode || window.innerWidth >= 1024) return;
    const el = document.getElementById("ficha-espacio");
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [sel, editMode]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<SpaceState, number>;
    spaces.forEach((s) => (c[s.state] += 1));
    return c;
  }, [spaces]);

  // Hasta dónde llegaría el plano si se achica (mismo cálculo que la base: el lado del mar queda fijo).
  const shrink = useMemo(() => {
    const W = ws.map_width, H = ws.map_height;
    const w = Math.round(Math.max(400, W * 0.8)), h = Math.round(Math.max(400, H * 0.8));
    const dx = ws.sea_side === "left" ? 0 : ws.sea_side === "right" ? w - W : Math.round((w - W) / 2);
    const dy = ws.sea_side === "top" ? 0 : ws.sea_side === "bottom" ? h - H : Math.round((h - H) / 2);
    const rect = { x: -dx, y: -dy, w, h };
    const inside = (x: number, y: number) => x >= rect.x && x <= rect.x + w && y >= rect.y && y <= rect.y + h;
    const outSpaces = new Set((data ?? []).filter((x) => x.active && !inside(Number(x.x), Number(x.y))).map((x) => x.space_id));
    const outFeatures = (featuresQ.data ?? []).filter((f) => !inside(Number(f.x), Number(f.y))).length;
    return { rect, outSpaces, outFeatures, possible: w < W || h < H };
  }, [ws.map_width, ws.map_height, ws.sea_side, data, featuresQ.data]);
  const limitVisible = editMode && (showLimit || hoverShrink);

  async function moveSpace(id: string, x: number, y: number): Promise<boolean> {
    const s = spaces.find((sp) => sp.space_id === id);
    if (!s) return false;
    const { error } = await sb.from("spaces").update({ x, y, version: s.version + 1 }).eq("id", id).select("id").single();
    if (error) {
      setMessage({ tone: "danger", text: `No se guardó la ubicación de ${s.code}: ${friendlyError(error)}` });
      reload();
      return false;
    }
    setMessage(null);
    await reload();
    return true;
  }

  async function updateFeature(id: string, patch: Partial<MapFeature>): Promise<boolean> {
    const f = features.find((x) => x.id === id);
    if (!f) return false;
    const { error } = await sb.from("map_features").update({ ...patch, version: f.version + 1 }).eq("id", id).select("id").single();
    if (error) {
      setMessage({ tone: "danger", text: `No se guardó el cambio: ${friendlyError(error)}` });
      featuresQ.reload();
      return false;
    }
    setMessage(null);
    await featuresQ.reload();
    return true;
  }

  async function addFeature(kind: MapFeature["kind"], label: string | null, w: number, h: number, color: string) {
    const { data: row, error } = await sb.from("map_features").insert({
      workspace_id: ws.id, kind, label, x: Math.round(ws.map_width / 2), y: Math.round(ws.map_height / 2), width: w, height: h, color,
    }).select("id").single();
    if (error) return setMessage({ tone: "danger", text: friendlyError(error) });
    await featuresQ.reload();
    setSel({ type: "feature", id: (row as { id: string }).id });
    setMessage({ tone: "ok", text: "Elemento agregado en el centro del plano: arrastralo a su lugar." });
  }

  return (
    <>
      <PageHeader
        title="Mapa del balneario"
        subtitle={day === today ? `Hoy, ${formatDate(day)}` : `Estado al ${formatDate(day)}`}
        actions={
          isAdmin ? (
            <>
              {editMode && <Button variant="secondary" onClick={() => setLayoutConfirm(true)}>Diseño Parador</Button>}
              {editMode && <Button variant="secondary" onClick={() => setAdding(true)}>Agregar carpa o sombrilla</Button>}
              {editMode && (usage.carpa.max != null || usage.sombrilla.max != null) && (
                <span className="text-xs text-muted" title="Lo que incluye tu plan. Podés desactivar y activar otras, sin pasar el máximo.">
                  Plan: {usage.carpa.used}/{usage.carpa.max ?? "∞"} carpas · {usage.sombrilla.used}/{usage.sombrilla.max ?? "∞"} sombrillas
                </span>
              )}
              {editMode && (
                <Button variant="secondary" onClick={() => setRestoreOpen(true)} title="Vuelve el plano a como estaba al tocar «Editar plano»">Deshacer todo lo editado</Button>
              )}
              <Button data-tour="mapa-editar" variant={editMode ? "primary" : "secondary"}
                onClick={() => { if (editMode) { setEditMode(false); setShowLimit(false); } else startEditing(); setMessage(null); }}>
                {editMode ? "Terminar edición" : "Editar plano"}
              </Button>
            </>
          ) : undefined
        }
      />
      <SyncNotice error={error} stale={stale} updatedAt={updatedAt} onRetry={reload} />

      <WeatherStrip className="mb-3" />

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Consultar fecha">
            <Input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="w-auto" />
          </Field>
          <Button variant="secondary" onClick={() => setDay(addDays(day, -1))} aria-label="Día anterior">←</Button>
          <Button variant="secondary" onClick={() => setDay(today)} disabled={day === today}>Hoy</Button>
          <Button variant="secondary" onClick={() => setDay(addDays(day, 1))} aria-label="Día siguiente">→</Button>
          <Button variant="secondary" onClick={() => setDay(addDays(today, 7))}>En una semana</Button>
          {loading && <span className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Actualizando…</span>}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {STATES.map((st) => (
            <span key={st} className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded-sm" style={{ background: STATE_COLOR[st] }} />
              {STATE_LABEL[st]} <span className="text-muted">({counts[st]})</span>
            </span>
          ))}
        </div>
      </div>

      {message && <Alert tone={message.tone} className="mb-3">{message.text}</Alert>}
      {editMode && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent-soft p-2 text-sm">
          <span className="px-1 font-medium">Agregar al plano:</span>
          <Button variant="secondary" className="py-1.5" onClick={() => addFeature("camino", null, 30, 400, "#9a6a34")}>Camino</Button>
          <Button variant="secondary" className="py-1.5" onClick={() => addFeature("area_comun", "Juegos infantiles", 160, 250, "#e9c98f")}>Juegos</Button>
          <Button variant="secondary" className="py-1.5" onClick={() => addFeature("instalacion", "Nueva instalación", 260, 160, "#f08c1a")}>Instalación</Button>
          <Button variant="secondary" className="py-1.5" onClick={() => addFeature("area_comun", "Área común", 300, 200, "#d9b77e")}>Área común</Button>
          <Button variant="secondary" className="py-1.5" onClick={() => addFeature("sector", "Sector", 600, 400, "#0b6a87")}>Sector</Button>
          {isAdmin && (
            <Button variant="secondary" className="py-1.5" disabled={!designReady} onClick={() => setDesignOpen(true)}
              title={designReady ? undefined : "Falta aplicar la actualización 0015 de la base de datos"}>
              Diseño de carpas
            </Button>
          )}
          <span className="text-xs text-muted">Tocá un elemento para editarlo; arrastralo para moverlo. La brújula también se arrastra y se agranda o achica.</span>
          {limitVisible && (
            <span className="basis-full text-xs font-medium text-danger">
              {shrink.outSpaces.size || shrink.outFeatures
                ? `Para achicar, mové hacia adentro de la línea roja: ${shrink.outSpaces.size ? `${shrink.outSpaces.size} ${shrink.outSpaces.size === 1 ? "carpa o sombrilla" : "carpas o sombrillas"} (marcadas en rojo)` : ""}${shrink.outSpaces.size && shrink.outFeatures ? " y " : ""}${shrink.outFeatures ? `${shrink.outFeatures} ${shrink.outFeatures === 1 ? "elemento" : "elementos"}` : ""}.`
                : "Todo entra: al achicar, el plano queda hasta la línea roja."}
            </span>
          )}
          {isAdmin && (
            <span className="ml-auto flex items-center gap-1.5">
              <span className="text-xs text-muted">Tamaño del plano:</span>
              <span onMouseEnter={() => setHoverShrink(true)} onMouseLeave={() => setHoverShrink(false)}>
                <Button variant="secondary" className="py-1.5" disabled={resizing || !shrink.possible} onClick={() => resize(0.8)}
                  title="Achicar el plano: la línea roja muestra hasta dónde llegaría">Achicar</Button>
              </span>
              <Button variant="ghost" className="py-1.5 text-xs" onClick={() => setShowLimit((v) => !v)} aria-pressed={showLimit}>
                {showLimit ? "Ocultar límite" : "Ver límite"}
              </Button>
              <Button variant="secondary" className="py-1.5" disabled={resizing} onClick={() => resize(1.25)} title="Más lugar para carpas: el plano se ve más alejado">Agrandar</Button>
            </span>
          )}
        </div>
      )}

      <div className="relative" data-tour="mapa">
        {editMode && (group.length > 1 || clipCount > 0) && (
          <div className="absolute left-1/2 top-3 z-10 flex w-max max-w-[calc(100%-7rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-xl border border-line bg-surface/95 p-2 text-sm shadow-lg backdrop-blur print:hidden">
            {group.length > 1 && (
              <span className="px-1 font-medium">
                {group.length} elegidas
                <span className="font-normal text-muted"> ({group.filter((g) => g.type === "space").length} carpas o sombrillas, {group.filter((g) => g.type === "feature").length} elementos)</span>
              </span>
            )}
            {group.some((g) => g.type === "feature") && <Button variant="secondary" className="py-1.5" onClick={copyGroup}>Copiar elementos</Button>}
            {clipCount > 0 && <Button variant="secondary" className="py-1.5" loading={pasting} onClick={() => void pasteClip()}>Pegar {clipCount === 1 ? "1 cosa" : `${clipCount} cosas`}</Button>}
            {group.length > 1 && <Button variant="secondary" className="py-1.5" onClick={() => setGroup([])}>Quitar selección</Button>}
          </div>
        )}


        {data ? (
          <BeachMap
            width={ws.map_width}
            height={ws.map_height}
            seaSide={ws.sea_side}
            spaces={spaces}
            features={features}
            selected={sel}
            editMode={editMode}
            onSelect={setSel}
            onMove={moveSpace}
            onFeatureChange={(id, g) => updateFeature(id, g)}
            group={editMode ? group : []}
            onGroupChange={setGroup}
            onMoveMany={moveMany}
            overlay={<WindCompass seaSide={ws.sea_side} layout={compass} editable={editMode && isAdmin && compassReady} onLayoutChange={(l) => void saveCompass(l)} />}
            design={design}
            guide={limitVisible && shrink.possible ? { ...shrink.rect, label: "Límite si achicás" } : null}
            flagged={limitVisible ? shrink.outSpaces : undefined}
          />
        ) : (
          <div className="flex aspect-[4/3] items-center justify-center rounded-2xl bg-surface-2 text-muted">
            {loading ? <><Spinner /> <span className="ml-2">Cargando plano…</span></> : "Sin datos"}
          </div>
        )}

        {((editMode && selectedSpace) || selectedFeature) && (
          <div id="ficha-espacio" className="mt-3 scroll-mt-20 lg:absolute lg:left-3 lg:top-3 lg:mt-0 lg:max-h-[calc(100%-1.5rem)] lg:w-[340px] lg:overflow-y-auto lg:rounded-xl lg:shadow-xl">
            {selectedSpace && <SpaceEditPanel space={selectedSpace} day={day} onChanged={reload} onClose={() => setSel(null)} />}
            {selectedFeature && <FeaturePanel feature={selectedFeature} features={features} onSave={(patch) => updateFeature(selectedFeature.id, patch)} onSaveOther={(id, patch) => updateFeature(id, patch)} onClose={() => setSel(null)} onRemove={async () => { if (await updateFeature(selectedFeature.id, { active: false } as Partial<MapFeature>)) setSel(null); }} />}
          </div>
        )}
      </div>
      {!sel && <p className="mt-2 text-xs text-muted">Tocá una carpa o sombrilla para ver su estado{day === today ? " de hoy" : ` el ${formatDate(day)}`}.</p>}

      {!editMode && selectedSpace && (
        <SpaceModal space={selectedSpace} spaces={spaces} day={day} today={today} isAdmin={isAdmin} onChanged={reload} onCheckDate={(d) => { setDay(d); }} onClose={() => setSel(null)}
          onMoved={(t) => { setMessage({ tone: "ok", text: t }); reload(); }} />
      )}
      <ConfirmDialog
        open={restoreOpen}
        title="Deshacer todo lo editado"
        message="El plano vuelve a como estaba cuando tocaste «Editar plano»: ubicación y giro de cada carpa, nombres, caminos y elementos, tamaño del plano, diseño de las carpas y la brújula. Las carpas que agregaste en esta edición se desactivan. Las reservas no cambian."
        confirmLabel="Dejar como estaba"
        busy={restoring}
        onConfirm={restoreSnapshot}
        onCancel={() => setRestoreOpen(false)}
      />
      <ConfirmDialog
        open={layoutConfirm}
        title="Aplicar el Diseño Parador"
        message="Todas las carpas y sombrillas cuyo número figura en el plano oficial vuelven a su lugar original, y se redibujan el parador, las pasarelas y los juegos (los cambios que hayas hecho a caminos y elementos se reemplazan). No se crean ni se borran carpas, y las reservas no cambian."
        confirmLabel="Aplicar diseño"
        busy={layoutBusy}
        onConfirm={applyLayout}
        onCancel={() => setLayoutConfirm(false)}
      />
      {isAdmin && designReady && (
        <TentDesigner open={designOpen} value={design ?? DEFAULT_TENT_STYLE} onClose={() => setDesignOpen(false)} onSave={saveDesign} />
      )}
      {isAdmin && <AddSpaceModal open={adding} onClose={() => setAdding(false)} onDone={(id) => { setAdding(false); reload(); setSel({ type: "space", id }); }} mapW={ws.map_width} mapH={ws.map_height} usage={usage} />}
    </>
  );
}

function FeaturePanel({ feature, features, onSave, onSaveOther, onClose, onRemove }: {
  feature: MapFeature; features: MapFeature[]; onSave: (patch: Partial<MapFeature>) => Promise<boolean>;
  onSaveOther: (id: string, patch: Partial<MapFeature>) => Promise<boolean>; onClose: () => void; onRemove: () => Promise<void>;
}) {
  const [len, setLen] = useState(String(Math.round(Number(feature.width))));
  const [wid, setWid] = useState(String(Math.round(Number(feature.height))));
  useEffect(() => {
    setLen(String(Math.round(Number(feature.width))));
    setWid(String(Math.round(Number(feature.height))));
  }, [feature.id, feature.width, feature.height]);
  const hasLayers = feature.layer !== undefined;
  const layers = features.map((f) => f.layer ?? 0);
  const myLayer = feature.layer ?? 0;

  // Capas: más alto = más arriba (las carpas y sombrillas siempre quedan encima de todo).
  async function toFront() { await run({ layer: Math.max(...layers) + 1 }); }
  async function toBack() { await run({ layer: Math.min(...layers) - 1 }); }
  async function step(dir: 1 | -1) {
    // Intercambia la capa con el elemento inmediatamente arriba (o abajo) que se superpone en el plano.
    const others = features
      .filter((f) => f.id !== feature.id && overlaps(f, feature))
      .filter((f) => (dir === 1 ? (f.layer ?? 0) >= myLayer : (f.layer ?? 0) <= myLayer))
      .sort((a, b) => dir * ((a.layer ?? 0) - (b.layer ?? 0)));
    const other = others[0];
    if (!other) {
      await run({ layer: myLayer + dir });
      return;
    }
    const otherLayer = other.layer ?? 0;
    setBusy(true);
    if (otherLayer === myLayer) await onSave({ layer: myLayer + dir });
    else {
      await onSaveOther(other.id, { layer: myLayer });
      await onSave({ layer: otherLayer });
    }
    setBusy(false);
  }
  const [kind, setKind] = useState(feature.kind);
  const [label, setLabel] = useState(feature.label ?? "");
  const [color, setColor] = useState(feature.color ?? "#9a6a34");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    setKind(feature.kind);
    setLabel(feature.label ?? "");
    setColor(feature.color ?? "#9a6a34");
  }, [feature.id, feature.kind, feature.label, feature.color]);

  async function run(patch: Partial<MapFeature>) {
    setBusy(true);
    await onSave(patch);
    setBusy(false);
  }
  const dirty = kind !== feature.kind || label !== (feature.label ?? "") || color !== (feature.color ?? "#9a6a34");

  return (
    <Card title={FEATURE_KIND_LABEL[feature.kind]} actions={<button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Cerrar">✕</button>}>
      <div className="flex flex-col gap-3">
        <Field label="Tipo">
          <Select value={kind} onChange={(e) => setKind(e.target.value as MapFeature["kind"])}>
            {Object.entries(FEATURE_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <TextField label="Texto (opcional)" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Ej: Juegos infantiles" />
        <Field label="Color">
          <div className="flex items-center gap-2">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-10 w-14 cursor-pointer rounded border border-line bg-surface" aria-label="Color" />
            {["#9a6a34", "#e9c98f", "#d9b77e", "#f08c1a", "#a8661b", "#2f9e5b", "#0b6a87"].map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)} className="h-6 w-6 rounded-full border border-line" style={{ background: c }} aria-label={`Color ${c}`} />
            ))}
          </div>
        </Field>
        {dirty && <Button loading={busy} onClick={() => run({ kind, label: label.trim() || null, color })}>Guardar cambios</Button>}
        <div className="grid grid-cols-2 gap-2">
          <TextField label="Largo" inputMode="numeric" value={len} onChange={(e) => setLen(e.target.value.replace(/\D/g, ""))}
            onBlur={() => { const v = Number(len); if (v >= 16 && v !== Math.round(Number(feature.width))) run({ width: v }); }} />
          <TextField label="Ancho" inputMode="numeric" value={wid} onChange={(e) => setWid(e.target.value.replace(/\D/g, ""))}
            onBlur={() => { const v = Number(wid); if (v >= 16 && v !== Math.round(Number(feature.height))) run({ height: v }); }} />
        </div>
        <p className="text-xs text-muted">También podés estirarlo en el plano tirando de las agarraderas de sus lados o esquinas. Como referencia, una carpa mide 86 de largo.</p>
        {hasLayers ? (
          <div>
            <div className="mb-1 text-sm font-medium">Superponer</div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" className="py-1.5" loading={busy} onClick={toFront}>Traer al frente</Button>
              <Button variant="secondary" className="py-1.5" loading={busy} onClick={toBack}>Enviar al fondo</Button>
              <Button variant="secondary" className="py-1.5" loading={busy} onClick={() => step(1)}>Subir un nivel</Button>
              <Button variant="secondary" className="py-1.5" loading={busy} onClick={() => step(-1)}>Bajar un nivel</Button>
            </div>
          </div>
        ) : <p className="text-xs text-warn">Para superponer elementos falta aplicar la actualización 0014 de la base de datos.</p>}
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <Button variant="secondary" loading={busy} onClick={() => run({ rotation: ((Number(feature.rotation) || 0) + 90) % 360 })}>Girar 90°</Button>
          <Button variant="secondary" loading={busy} onClick={() => run({ width: Number(feature.height), height: Number(feature.width) })}>Cambiar orientación</Button>
          <Button variant="danger" onClick={() => setConfirmRemove(true)}>Quitar</Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        title="Quitar del plano"
        message="El elemento deja de mostrarse en el plano. Si lo necesitás de nuevo, lo podés volver a agregar."
        confirmLabel="Quitar"
        danger
        busy={busy}
        onConfirm={async () => { setBusy(true); await onRemove(); setBusy(false); setConfirmRemove(false); }}
        onCancel={() => setConfirmRemove(false)}
      />
    </Card>
  );
}

/** Estado de una carpa o sombrilla el día consultado (sirve para la ficha y para la ventana). */
function SpaceInfo({ space, day, onCheckDate }: { space: DayStatus; day: string; onCheckDate: (d: string) => void }) {
  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-block h-3 w-3 rounded-full" style={{ background: STATE_COLOR[space.state] }} />
        <span className="text-sm font-medium">{STATE_LABEL[space.state]}</span>
        <span className="text-xs text-muted">el {formatDate(day)}</span>
      </div>
      {space.reservation_id && (
        <dl className="mb-3 grid grid-cols-2 gap-2 rounded-lg bg-surface-2 p-3 text-sm">
          <div className="col-span-2"><dt className="text-xs text-muted">Cliente</dt><dd className="font-medium">{space.customer_name}</dd></div>
          <div><dt className="text-xs text-muted">Desde</dt><dd>{formatDate(space.reservation_start)}</dd></div>
          <div><dt className="text-xs text-muted">Hasta</dt><dd>{formatDate(space.reservation_end)}</dd></div>
          <div><dt className="text-xs text-muted">Días restantes</dt><dd>{space.days_remaining === 0 ? "Último día" : space.days_remaining}</dd></div>
          <div><dt className="text-xs text-muted">Reserva</dt><dd>#{space.reservation_number}</dd></div>
          <div className="col-span-2">
            <dt className="text-xs text-muted">Saldo</dt>
            <dd>{Number(space.due_amount) > 0 ? <Badge tone="danger">Debe {formatMoney(space.due_amount)}</Badge> : <Badge tone="ok">Sin deuda</Badge>}</dd>
          </div>
        </dl>
      )}
      {space.state === "mantenimiento" && (
        <Alert tone="warn" className="mb-3">Mantenimiento hasta el {formatDate(space.maintenance_end)}: {space.maintenance_reason}</Alert>
      )}
      {space.next_start && !space.reservation_id && (
        <p className="mb-3 text-sm">
          Próxima reserva desde el <strong>{formatDate(space.next_start)}</strong>.{" "}
          <button className="text-accent hover:underline" onClick={() => onCheckDate(space.next_start!)}>Ver ese día</button>
        </p>
      )}
      {space.state === "disponible" && !space.next_start && <p className="mb-3 text-sm text-muted">Sin reservas futuras.</p>}
    </>
  );
}

/**
 * Ventana en el medio de la pantalla al tocar una carpa (fuera de la edición del plano):
 * su estado, la reserva, y mover clientes: si está ocupada, cambiarlo de lugar; si está libre, traer a alguien de otra.
 */
function SpaceModal({ space, spaces, day, today, isAdmin, onChanged, onCheckDate, onClose, onMoved }: {
  space: DayStatus; spaces: DayStatus[]; day: string; today: string; isAdmin: boolean;
  onChanged: () => void; onCheckDate: (d: string) => void; onClose: () => void; onMoved: (t: string) => void;
}) {
  const [maint, setMaint] = useState(false);
  const [picking, setPicking] = useState(false);
  const [moving, setMoving] = useState<{ full: Full; target?: string } | null>(null);
  const [loadingRes, setLoadingRes] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kindLabel = space.kind === "carpa" ? "Carpa" : "Sombrilla";
  const free = space.active && !space.reservation_id && space.state !== "mantenimiento";
  const pastDay = day < today;
  // Quiénes están ocupando otra carpa o sombrilla ese día (para traerlos a esta).
  const occupants = spaces.filter((x) => x.reservation_id && x.space_id !== space.space_id && (x.state === "ocupada" || x.state === "cortesia"))
    .sort((a, b) => a.code.localeCompare(b.code, "es", { numeric: true }));

  async function openMove(reservationId: string, target?: string) {
    setLoadingRes(reservationId);
    setError(null);
    try {
      const full = await loadReservation(reservationId);
      setMoving({ full, target });
      setPicking(false);
    } catch (e) {
      setError(friendlyError(e));
    }
    setLoadingRes(null);
  }

  if (moving) {
    return (
      <RelocateModal open full={moving.full} today={today} initialDay={day} initialTarget={moving.target}
        onClose={() => setMoving(null)}
        onDone={(t) => { setMoving(null); onClose(); onMoved(t); }} />
    );
  }

  return (
    <>
    <Modal open={!maint} onClose={onClose} title={`${kindLabel} ${space.code}`}>
      <div>
        <SpaceInfo space={space} day={day} onCheckDate={(d) => { onCheckDate(d); onClose(); }} />
        {error && <Alert tone="danger" className="mb-3">{error}</Alert>}

        {picking ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">¿A quién traés a la {kindLabel.toLowerCase()} {space.code}?</p>
            {occupants.length === 0 ? <p className="text-sm text-muted">No hay nadie en otra carpa o sombrilla el {formatDate(day)}.</p> : (
              <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                {occupants.map((o) => (
                  <li key={o.space_id}>
                    <button type="button" disabled={loadingRes !== null} onClick={() => openMove(o.reservation_id!, space.space_id)}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:opacity-60">
                      <span><strong>{o.kind === "carpa" ? "Carpa" : "Sombrilla"} {o.code}</strong> · {o.customer_name ?? o.surname ?? "Cliente"}</span>
                      {loadingRes === o.reservation_id ? <Spinner small /> : <span className="text-xs text-muted">hasta {formatDate(o.reservation_end)}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end"><Button variant="secondary" onClick={() => setPicking(false)}>Volver</Button></div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {space.reservation_id && <Link href={`/reservas/${space.reservation_id}`}><Button>Ver reserva #{space.reservation_number}</Button></Link>}
            {space.reservation_id && !pastDay && (
              <Button variant="secondary" loading={loadingRes === space.reservation_id} onClick={() => openMove(space.reservation_id!)}>Cambiar de lugar</Button>
            )}
            {free && !pastDay && (
              <Link href={`/reservas/nueva?espacio=${space.space_id}&desde=${day}`}><Button>Reservar desde el {formatDate(day)}</Button></Link>
            )}
            {free && !pastDay && (
              <Button variant="secondary" onClick={() => setPicking(true)}>Traer a alguien de otra carpa</Button>
            )}
            {isAdmin && space.active && !pastDay && <Button variant="secondary" onClick={() => setMaint(true)}>Bloquear por mantenimiento</Button>}
          </div>
        )}
      </div>
    </Modal>
    <MaintenanceModal open={maint} space={space} today={today} onClose={() => setMaint(false)} onDone={() => { setMaint(false); onChanged(); }} />
    </>
  );
}

/** Ficha en la edición del plano: cambiar la identificación, girar y desactivar. */
function SpaceEditPanel({ space, day, onChanged, onClose }: { space: DayStatus; day: string; onChanged: () => void; onClose: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rotate() {
    setBusy(true);
    setError(null);
    const { error } = await getSupabase().from("spaces")
      .update({ rotation: ((Number(space.rotation) || 0) + 90) % 360, version: space.version + 1 })
      .eq("id", space.space_id).select("id").single();
    setBusy(false);
    if (error) return setError(friendlyError(error));
    onChanged();
  }

  async function toggleActive() {
    setBusy(true);
    setError(null);
    const { error } = await getSupabase().from("spaces").update({ active: !space.active, version: space.version + 1 }).eq("id", space.space_id).select("id").single();
    setBusy(false);
    setToggling(false);
    if (error) return setError(friendlyError(error));
    onChanged();
  }

  const kindLabel = space.kind === "carpa" ? "Carpa" : "Sombrilla";
  return (
    <Card title={`${kindLabel} ${space.code}`} actions={<button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Cerrar">✕</button>}>
      <p className="mb-3 text-sm text-muted">{STATE_LABEL[space.state]} el {formatDate(day)}. Arrastrala para moverla.</p>
      {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setRenaming(true)}>Cambiar identificación</Button>
        <Button variant="secondary" onClick={rotate} loading={busy}>Girar 90°</Button>
        <Button variant={space.active ? "danger" : "secondary"} onClick={() => setToggling(true)}>{space.active ? "Desactivar" : "Reactivar"}</Button>
      </div>
      {space.active && <p className="mt-2 text-xs text-muted">Desactivarla libera un lugar de tu plan para activar otra. Las reservas e historial se conservan.</p>}

      <RenameModal open={renaming} space={space} onClose={() => setRenaming(false)} onDone={() => { setRenaming(false); onChanged(); }} />
      <ConfirmDialog
        open={toggling}
        title={space.active ? `Desactivar ${space.code}` : `Reactivar ${space.code}`}
        message={space.active
          ? "Deja de ofrecerse para nuevas reservas. Si tiene reservas de hoy en adelante, el sistema no lo permite hasta cambiarlas de carpa. El historial se conserva."
          : "Vuelve a estar disponible para reservar."}
        confirmLabel={space.active ? "Desactivar" : "Reactivar"}
        danger={space.active}
        busy={busy}
        onConfirm={toggleActive}
        onCancel={() => setToggling(false)}
      />
    </Card>
  );
}

function RenameModal({ open, space, onClose, onDone }: { open: boolean; space: DayStatus; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState(space.code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await getSupabase().from("spaces").update({ code: code.trim(), version: space.version + 1 }).eq("id", space.space_id).select("id").single();
    setBusy(false);
    if (error) return setError(friendlyError(error));
    onDone();
  }
  return (
    <Modal open={open} onClose={onClose} title={`Cambiar identificación de ${space.code}`} busy={busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <TextField label="Nueva identificación" value={code} onChange={(e) => setCode(e.target.value)} required maxLength={20} hint="Las reservas y el historial siguen vinculados al mismo espacio." />
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button type="submit" loading={busy}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}

function MaintenanceModal({ open, space, today, onClose, onDone }: { open: boolean; space: DayStatus; today: string; onClose: () => void; onDone: () => void }) {
  const { ws } = useWorkspace();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (to < from) return setError("La fecha final no puede ser anterior a la inicial.");
    setBusy(true);
    setError(null);
    const { error } = await getSupabase().from("maintenance_blocks").insert({
      workspace_id: ws.id, space_id: space.space_id, start_date: from, end_date: to, reason: reason.trim(), notes: notes.trim() || null,
    }).select("id").single();
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setReason(""); setNotes("");
    onDone();
  }
  return (
    <Modal open={open} onClose={onClose} title={`Mantenimiento de ${space.code}`} busy={busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Desde"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></Field>
          <Field label="Hasta (inclusive)"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required /></Field>
        </div>
        <TextField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={300} placeholder="Ej: Lona rota" />
        <Field label="Observaciones"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
        <p className="text-xs text-muted">Si el espacio tiene reservas en esas fechas, el sistema avisa y no bloquea hasta que cambies de carpa a esos clientes.</p>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button type="submit" loading={busy}>Bloquear</Button>
        </div>
      </form>
    </Modal>
  );
}

type Usage = Record<"carpa" | "sombrilla", { used: number; max: number | null }>;
const kindLabel = (k: "carpa" | "sombrilla", n: number) => (k === "carpa" ? (n === 1 ? "carpa" : "carpas") : n === 1 ? "sombrilla" : "sombrillas");

function AddSpaceModal({ open, onClose, onDone, mapW, mapH, usage }: { open: boolean; onClose: () => void; onDone: (id: string) => void; mapW: number; mapH: number; usage: Usage }) {
  const { ws } = useWorkspace();
  const [kind, setKind] = useState<"carpa" | "sombrilla">("carpa");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await getSupabase().from("spaces").insert({
      workspace_id: ws.id, kind, code: code.trim(), x: Math.round(mapW / 2), y: Math.round(mapH / 2),
    }).select("id").single();
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setCode("");
    onDone((data as { id: string }).id);
  }
  return (
    <Modal open={open} onClose={onClose} title="Agregar espacio" busy={busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Tipo">
          <Select value={kind} onChange={(e) => setKind(e.target.value as "carpa" | "sombrilla")}>
            <option value="carpa">Carpa</option>
            <option value="sombrilla">Sombrilla</option>
          </Select>
        </Field>
        <TextField label="Identificación" value={code} onChange={(e) => setCode(e.target.value)} required maxLength={20} placeholder={kind === "carpa" ? "Ej: 90" : "Ej: 91"} />
        {usage[kind].max != null && (usage[kind].used >= usage[kind].max! ? (
          <Alert tone="warn">
            Ya tenés las {usage[kind].max} {kindLabel(kind, usage[kind].max!)} de tu plan activas. Podés desactivar una y sumar otra en su lugar;
            para tener más, escribinos.
          </Alert>
        ) : (
          <p className="text-xs text-muted">Tu plan: {usage[kind].used} de {usage[kind].max} {kindLabel(kind, usage[kind].max!)} activas.</p>
        ))}
        <p className="text-xs text-muted">Aparece en el centro del mapa; después arrastralo a su lugar.</p>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button type="submit" loading={busy} disabled={usage[kind].max != null && usage[kind].used >= usage[kind].max!}>Agregar</Button>
        </div>
      </form>
    </Modal>
  );
}

/** ¿Se tocan dos elementos en el plano? (aproximación con rectángulos sin rotar) */
function overlaps(a: MapFeature, b: MapFeature): boolean {
  const ext = (f: MapFeature) => {
    const r = ((Number(f.rotation) || 0) / 90) % 2 === 1;
    const w = r ? Number(f.height) : Number(f.width);
    const h = r ? Number(f.width) : Number(f.height);
    return { x0: Number(f.x) - w / 2, x1: Number(f.x) + w / 2, y0: Number(f.y) - h / 2, y1: Number(f.y) + h / 2 };
  };
  const A = ext(a);
  const B = ext(b);
  return A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1;
}
