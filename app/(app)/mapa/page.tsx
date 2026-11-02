"use client";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { addDays, formatDate, formatMoney, todayISO } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, ConfirmDialog, Field, Input, Modal, Select, Spinner, Textarea, TextField } from "@/components/ui";
import { BeachMap, FEATURE_KIND_LABEL, type MapFeature, type MapSpace, type Selection } from "@/components/map/BeachMap";
import { WeatherStrip, WindCompass } from "@/components/weather";
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
  const [layoutConfirm, setLayoutConfirm] = useState(false);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [sel, setSel] = useState<Selection>(null);
  const [editMode, setEditMode] = useState(false);
  const [message, setMessage] = useState<{ tone: "danger" | "ok"; text: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const { data, error, loading, reload, stale, updatedAt } = useLoader<DayStatus[]>(
    async () => unwrap(await sb.rpc("map_day_status", { p_workspace_id: ws.id, p_day: day })) as DayStatus[],
    [ws.id, day],
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
  const features = featuresQ.data ?? [];
  const selectedSpace = sel?.type === "space" ? spaces.find((s) => s.space_id === sel.id) ?? null : null;
  const selectedFeature = sel?.type === "feature" ? features.find((f) => f.id === sel.id) ?? null : null;

  // Fuera del modo edición no se seleccionan elementos del plano.
  useEffect(() => {
    if (!editMode && sel?.type === "feature") setSel(null);
  }, [editMode, sel]);

  // En pantallas chicas la ficha queda debajo del plano: bajar hasta ella.
  useEffect(() => {
    if (!sel || window.innerWidth >= 1024) return;
    const el = document.getElementById("ficha-espacio");
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [sel]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<SpaceState, number>;
    spaces.forEach((s) => (c[s.state] += 1));
    return c;
  }, [spaces]);

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
              <Button variant={editMode ? "primary" : "secondary"} onClick={() => { setEditMode((v) => !v); setMessage(null); }}>
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
              🎨 Diseño de carpas
            </Button>
          )}
          <span className="text-xs text-muted">Tocá un elemento para editarlo; arrastralo para moverlo.</span>
        </div>
      )}

        </div>
      )}

      <div className="relative">
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
            overlay={<WindCompass seaSide={ws.sea_side} />}
            design={design}
          />
        ) : (
          <div className="flex aspect-[4/3] items-center justify-center rounded-2xl bg-surface-2 text-muted">
            {loading ? <><Spinner /> <span className="ml-2">Cargando plano…</span></> : "Sin datos"}
          </div>
        )}

        {(selectedSpace || selectedFeature) && (
          <div id="ficha-espacio" className="mt-3 scroll-mt-20 lg:absolute lg:left-3 lg:top-3 lg:mt-0 lg:max-h-[calc(100%-1.5rem)] lg:w-[340px] lg:overflow-y-auto lg:rounded-xl lg:shadow-xl">
            {selectedSpace && <SpacePanel space={selectedSpace} day={day} today={today} isAdmin={isAdmin} onChanged={reload} onCheckDate={setDay} onClose={() => setSel(null)} />}
            {selectedFeature && <FeaturePanel feature={selectedFeature} features={features} onSave={(patch) => updateFeature(selectedFeature.id, patch)} onSaveOther={(id, patch) => updateFeature(id, patch)} onClose={() => setSel(null)} onRemove={async () => { if (await updateFeature(selectedFeature.id, { active: false } as Partial<MapFeature>)) setSel(null); }} />}
          </div>
        )}
      </div>
      {!sel && <p className="mt-2 text-xs text-muted">Tocá una carpa o sombrilla para ver su estado{day === today ? " de hoy" : ` el ${formatDate(day)}`}.</p>}

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
      {isAdmin && <AddSpaceModal open={adding} onClose={() => setAdding(false)} onDone={(id) => { setAdding(false); reload(); setSel({ type: "space", id }); }} mapW={ws.map_width} mapH={ws.map_height} />}
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

function SpacePanel({ space, day, today, isAdmin, onChanged, onCheckDate, onClose }: { space: DayStatus; day: string; today: string; isAdmin: boolean; onChanged: () => void; onCheckDate: (d: string) => void; onClose: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [maint, setMaint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rotate() {
    if (!space) return;
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
    if (!space) return;
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

      {error && <Alert tone="danger" className="mb-3">{error}</Alert>}

      <div className="mb-3 flex flex-wrap gap-2">
        {space.reservation_id && <Link href={`/reservas/${space.reservation_id}`}><Button>Ver reserva #{space.reservation_number}</Button></Link>}
        {space.active && !space.reservation_id && space.state !== "mantenimiento" && (
          <Link href={`/reservas/nueva?espacio=${space.space_id}&desde=${day}`}><Button>Reservar desde el {formatDate(day)}</Button></Link>
        )}
      </div>

      {isAdmin && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <Button variant="secondary" onClick={() => setRenaming(true)}>Cambiar identificación</Button>
          <Button variant="secondary" onClick={rotate} loading={busy}>Girar 90°</Button>
          {space.active && <Button variant="secondary" onClick={() => setMaint(true)}>Bloquear por mantenimiento</Button>}
          <Button variant={space.active ? "danger" : "secondary"} onClick={() => setToggling(true)}>{space.active ? "Desactivar" : "Reactivar"}</Button>
        </div>
      )}

      <RenameModal open={renaming} space={space} onClose={() => setRenaming(false)} onDone={() => { setRenaming(false); onChanged(); }} />
      <MaintenanceModal open={maint} space={space} today={today} onClose={() => setMaint(false)} onDone={() => { setMaint(false); onChanged(); }} />
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

function AddSpaceModal({ open, onClose, onDone, mapW, mapH }: { open: boolean; onClose: () => void; onDone: (id: string) => void; mapW: number; mapH: number }) {
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
        <p className="text-xs text-muted">Aparece en el centro del mapa; después arrastralo a su lugar.</p>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button type="submit" loading={busy}>Agregar</Button>
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
