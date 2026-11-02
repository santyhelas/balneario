"use client";
import { useMemo, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { addDays, formatDate, formatMoney, todayISO } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, ConfirmDialog, Field, Input, Modal, Select, Spinner, Textarea, TextField } from "@/components/ui";
import { BeachMap, type MapFeature, type MapSpace } from "@/components/map/BeachMap";
import { STATE_COLOR, STATE_LABEL, type SpaceState } from "@/components/map/icons";

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [message, setMessage] = useState<{ tone: "danger" | "ok"; text: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const { data, error, loading, reload, stale, updatedAt } = useLoader<DayStatus[]>(
    async () => unwrap(await sb.rpc("map_day_status", { p_workspace_id: ws.id, p_day: day })) as DayStatus[],
    [ws.id, day],
  );

  const featuresQ = useLoader<MapFeature[]>(
    async () => unwrap(await sb.from("map_features").select("id, kind, label, x, y, width, height, rotation, color")
      .eq("workspace_id", ws.id).eq("active", true)) as MapFeature[],
    [ws.id],
    0,
  );

  async function applyLayout() {
    setLayoutBusy(true);
    const { data: res, error } = await sb.rpc("apply_parador_layout", { p_workspace_id: ws.id });
    setLayoutBusy(false);
    setLayoutConfirm(false);
    if (error) return setMessage({ tone: "danger", text: friendlyError(error) });
    setMessage({ tone: "ok", text: `Listo: se ubicaron ${(res as { espacios_ubicados: number }).espacios_ubicados} espacios según el plano del parador.` });
    await reloadWorkspace();
    featuresQ.reload();
    reload();
  }

  const spaces = data ?? [];
  const selected = spaces.find((s) => s.space_id === selectedId) ?? null;
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

  return (
    <>
      <PageHeader
        title="Mapa del balneario"
        subtitle={day === today ? `Hoy, ${formatDate(day)}` : `Estado al ${formatDate(day)}`}
        actions={
          isAdmin ? (
            <>
              {editMode && <Button variant="secondary" onClick={() => setLayoutConfirm(true)}>Diseño Parador</Button>}
              {editMode && <Button variant="secondary" onClick={() => setAdding(true)}>Agregar espacio</Button>}
              <Button variant={editMode ? "primary" : "secondary"} onClick={() => setEditMode((v) => !v)}>
                {editMode ? "Terminar edición" : "Editar ubicaciones"}
              </Button>
            </>
          ) : undefined
        }
      />
      <SyncNotice error={error} stale={stale} updatedAt={updatedAt} onRetry={reload} />

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Consultar fecha">
          <Input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="w-auto" />
        </Field>
        <Button variant="secondary" onClick={() => setDay(addDays(day, -1))} aria-label="Día anterior">←</Button>
        <Button variant="secondary" onClick={() => setDay(today)} disabled={day === today}>Hoy</Button>
        <Button variant="secondary" onClick={() => setDay(addDays(day, 1))} aria-label="Día siguiente">→</Button>
        <Button variant="secondary" onClick={() => setDay(addDays(today, 7))}>En una semana</Button>
        {loading && <span className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Actualizando…</span>}
      </div>

      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {STATES.map((st) => (
          <span key={st} className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ background: STATE_COLOR[st] }} />
            {STATE_LABEL[st]} <span className="text-muted">({counts[st]})</span>
          </span>
        ))}
      </div>

      {message && <Alert tone={message.tone} className="mb-3">{message.text}</Alert>}
      {editMode && <Alert tone="info" className="mb-3">Modo edición: arrastrá carpas y sombrillas a su lugar. Cada movimiento se guarda al soltar.</Alert>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        {data ? (
          <BeachMap
            width={ws.map_width}
            height={ws.map_height}
            seaSide={ws.sea_side}
            spaces={spaces}
            features={featuresQ.data ?? []}
            selectedId={selectedId}
            editMode={editMode}
            onSelect={setSelectedId}
            onMove={moveSpace}
          />
        ) : (
          <div className="flex h-[62vh] items-center justify-center rounded-xl border border-line text-muted">
            {loading ? <><Spinner /> <span className="ml-2">Cargando mapa…</span></> : "Sin datos"}
          </div>
        )}

        <SpacePanel space={selected} day={day} today={today} isAdmin={isAdmin} onChanged={reload} onCheckDate={setDay} />
      </div>

      <ConfirmDialog
        open={layoutConfirm}
        title="Aplicar el Diseño Parador"
        message="Todas las carpas y sombrillas cuyo número figura en el plano oficial vuelven a su lugar original, y se redibujan el parador, las pasarelas y los juegos. No se crean ni se borran espacios, y las reservas no cambian."
        confirmLabel="Aplicar diseño"
        busy={layoutBusy}
        onConfirm={applyLayout}
        onCancel={() => setLayoutConfirm(false)}
      />
      {isAdmin && <AddSpaceModal open={adding} onClose={() => setAdding(false)} onDone={(id) => { setAdding(false); reload(); setSelectedId(id); }} mapW={ws.map_width} mapH={ws.map_height} />}
    </>
  );
}

function SpacePanel({ space, day, today, isAdmin, onChanged, onCheckDate }: { space: DayStatus | null; day: string; today: string; isAdmin: boolean; onChanged: () => void; onCheckDate: (d: string) => void }) {
  const [renaming, setRenaming] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [maint, setMaint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!space) {
    return <Card><p className="text-sm text-muted">Tocá una carpa o sombrilla para ver su estado el {formatDate(day)}.</p></Card>;
  }

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
    <Card title={`${kindLabel} ${space.code}`}>
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
