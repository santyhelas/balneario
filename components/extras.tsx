"use client";
import { useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError, isVersionConflict } from "@/lib/errors";
import { formatDateTime, formatMoney, parseMoney } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { Alert, Badge, Button, Card, CardBareContext, EmptyState, Modal, Select, Spinner, TextField, cx } from "@/components/ui";

/**
 * Extras: cosas que se cobran aparte de la carpa (reposeras, estacionamiento, heladera…).
 * El catálogo lo arma un administrador; cualquiera del equipo los suma a una reserva.
 * Un extra cargado no se borra: se anula con motivo y el total de la reserva baja.
 */

export type Extra = { id: string; name: string; price: number; per_day: boolean; active: boolean; version: number };
export type ReservationExtra = {
  id: string; description: string; quantity: number; days: number; unit_price: number; amount: number;
  created_at: string; voided_at: string | null; void_reason: string | null;
};

/** Precio del extra para mostrar: "$2.000 por día" o "$5.000". */
export const extraPriceLabel = (x: Pick<Extra, "price" | "per_day">) => `${formatMoney(x.price)}${x.per_day ? " por día" : ""}`;

/** Lo que va a costar: precio × cantidad × días (si es por día). */
export function extraAmount(price: number, qty: number, days: number, perDay: boolean): number {
  return Math.round(price * qty * (perDay ? days : 1) * 100) / 100;
}

/** Catálogo de extras, en Configuración. */
export function ExtrasCard() {
  const { ws, isAdmin } = useWorkspace();
  const sb = getSupabase();
  const q = useLoader(async () => {
    const res = await sb.from("extras").select("id, name, price, per_day, active, version").eq("workspace_id", ws.id).order("active", { ascending: false }).order("name");
    if (res.error && (res.error.code === "42P01" || res.error.code === "PGRST205")) return { missing: true, rows: [] as Extra[] };
    return { missing: false, rows: unwrap(res) as Extra[] };
  }, [ws.id], 0);
  const [editing, setEditing] = useState<Extra | "new" | null>(null);

  return (
    <Card title="Extras" tour="config-extras" actions={isAdmin && q.data && !q.data.missing ? <Button variant="secondary" onClick={() => setEditing("new")}>Agregar extra</Button> : undefined}>
      <p className="mb-3 text-sm text-muted">Lo que cobrás aparte de la carpa: reposeras, estacionamiento, heladera, gazebo… Se suman al total de cada reserva desde su detalle.</p>
      {!q.data ? <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando…</div>
        : q.data.missing ? <p className="text-sm text-muted">Para usar extras hay que aplicar la actualización 0029 de la base de datos.</p>
        : q.data.rows.length === 0 ? <EmptyState>Todavía no cargaste extras.</EmptyState>
        : (
          <ul className="divide-y divide-line">
            {q.data.rows.map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{x.name} {!x.active && <Badge tone="muted">Desactivado</Badge>}</div>
                  <div className="text-xs text-muted">{x.per_day ? `${formatMoney(x.price)} por día` : `${formatMoney(x.price)} por única vez`}</div>
                </div>
                {isAdmin && <Button variant="ghost" onClick={() => setEditing(x)}>Editar</Button>}
              </li>
            ))}
          </ul>
        )}
      {q.error && <Alert tone="danger" className="mt-2">{q.error}</Alert>}
      {editing && <ExtraForm extra={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); q.reload(); }} />}
    </Card>
  );
}

function ExtraForm({ extra, onClose, onSaved }: { extra: Extra | null; onClose: () => void; onSaved: () => void }) {
  const { ws } = useWorkspace();
  const [name, setName] = useState(extra?.name ?? "");
  const [price, setPrice] = useState(extra ? String(extra.price) : "");
  const [perDay, setPerDay] = useState(extra?.per_day ?? true);
  const [active, setActive] = useState(extra?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = parseMoney(price);
    if (name.trim().length < 2) return setError("Poné un nombre (por ejemplo, Reposera).");
    if (p == null || p < 0) return setError("Poné un precio válido.");
    setBusy(true);
    setError(null);
    const sb = getSupabase();
    const res = extra
      ? await sb.from("extras").update({ name: name.trim(), price: p, per_day: perDay, active, version: extra.version + 1 }).eq("id", extra.id).select("id").single()
      : await sb.from("extras").insert({ workspace_id: ws.id, name: name.trim(), price: p, per_day: perDay }).select("id").single();
    setBusy(false);
    if (res.error) {
      setError(isVersionConflict(res.error) ? "Otra persona cambió este extra recién. Cerrá y volvé a abrirlo." : friendlyError(res.error));
      return;
    }
    onSaved();
  }

  return (
    <Modal open onClose={onClose} busy={busy} title={extra ? "Editar extra" : "Nuevo extra"}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button type="submit" form="extra-form" loading={busy}>Guardar</Button></>}>
      <form id="extra-form" onSubmit={submit} className="flex flex-col gap-3">
        <TextField label="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="Ej: Reposera" />
        <TextField label="Precio" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required placeholder="Ej: 2000" />
        <fieldset className="flex flex-col gap-1 text-sm">
          <label className="flex items-center gap-2"><input type="radio" checked={perDay} onChange={() => setPerDay(true)} /> Por día (se multiplica por los días de la estadía)</label>
          <label className="flex items-center gap-2"><input type="radio" checked={!perDay} onChange={() => setPerDay(false)} /> Por única vez</label>
        </fieldset>
        {extra && (
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Se ofrece en las reservas nuevas</label>
        )}
        <p className="text-xs text-muted">Cambiar el precio no modifica los extras ya cargados en reservas.</p>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Modal>
  );
}

/** Extras de una reserva, en su detalle. */
export function ReservationExtras({ reservationId, stayDays, editable, onChanged }: {
  reservationId: string; stayDays: number; editable: boolean; onChanged: () => void;
}) {
  const { ws } = useWorkspace();
  const sb = getSupabase();
  const q = useLoader(async () => {
    const lines = await sb.from("reservation_extras")
      .select("id, description, quantity, days, unit_price, amount, created_at, voided_at, void_reason")
      .eq("reservation_id", reservationId).order("created_at");
    if (lines.error && (lines.error.code === "42P01" || lines.error.code === "PGRST205")) return null; // falta la actualización 0029
    const cat = unwrap(await sb.from("extras").select("id, name, price, per_day, active, version").eq("workspace_id", ws.id).eq("active", true).order("name")) as Extra[];
    return { lines: unwrap(lines) as ReservationExtra[], catalog: cat };
  }, [reservationId, ws.id], 0);
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<ReservationExtra | null>(null);

  if (q.data === null) return null;
  if (!q.data) return null;
  const active = q.data.lines.filter((l) => !l.voided_at);
  const voided = q.data.lines.filter((l) => l.voided_at);
  if (!editable && q.data.lines.length === 0) return null;
  if (q.data.catalog.length === 0 && q.data.lines.length === 0) {
    return (
      <Card title="Extras">
        <p className="text-sm text-muted">Si cobrás reposeras, estacionamiento u otra cosa aparte, creá el extra desde «Nueva reserva» (paso 4, Extras) y después lo sumás acá.</p>
      </Card>
    );
  }

  return (
    <Card title="Extras" actions={editable && q.data.catalog.length > 0 ? <Button variant="secondary" onClick={() => setAdding(true)}>Agregar extra</Button> : undefined}>
      {active.length === 0 ? <p className="text-sm text-muted">Sin extras.</p> : (
        <ul className="divide-y divide-line">
          {active.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{l.description}{l.quantity > 1 ? ` × ${l.quantity}` : ""}</div>
                <div className="text-xs text-muted">
                  {formatMoney(l.unit_price)}{l.days > 1 ? ` × ${l.days} días` : ""}{l.quantity > 1 ? ` × ${l.quantity}` : ""} · cargado el {formatDateTime(l.created_at, ws.timezone)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="tabular font-semibold">{formatMoney(l.amount)}</span>
                {editable && <Button variant="ghost" onClick={() => setVoiding(l)}>Anular</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {voided.length > 0 && (
        <details className="mt-2 text-xs text-muted">
          <summary className="cursor-pointer">Anulados ({voided.length})</summary>
          <ul className="mt-1 flex flex-col gap-1">
            {voided.map((l) => <li key={l.id}><s>{l.description} {formatMoney(l.amount)}</s> — {l.void_reason}</li>)}
          </ul>
        </details>
      )}
      {adding && <AddExtraModal reservationId={reservationId} catalog={q.data.catalog} stayDays={stayDays}
        onClose={() => setAdding(false)} onDone={() => { setAdding(false); q.reload(); onChanged(); }} />}
      {voiding && <VoidExtraModal line={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); q.reload(); onChanged(); }} />}
    </Card>
  );
}

function AddExtraModal({ reservationId, catalog, stayDays, onClose, onDone }: {
  reservationId: string; catalog: Extra[]; stayDays: number; onClose: () => void; onDone: () => void;
}) {
  const [extraId, setExtraId] = useState(catalog[0]?.id ?? "");
  const [qty, setQty] = useState("1");
  const [days, setDays] = useState(String(stayDays));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const x = catalog.find((c) => c.id === extraId);
  const n = Math.max(0, Math.floor(Number(qty) || 0));
  const d = Math.max(0, Math.floor(Number(days) || 0));
  const total = x ? extraAmount(Number(x.price), n, d, x.per_day) : 0;

  async function submit() {
    if (!x) return;
    if (n < 1 || n > 99) return setError("La cantidad tiene que ser entre 1 y 99.");
    if (x.per_day && (d < 1 || d > stayDays)) return setError(`Los días tienen que ser entre 1 y ${stayDays}.`);
    setBusy(true);
    setError(null);
    const { error: err } = await getSupabase().rpc("add_reservation_extra", {
      p_reservation_id: reservationId, p_extra_id: x.id, p_quantity: n, p_days: x.per_day ? d : null,
    });
    setBusy(false);
    if (err) return setError(friendlyError(err));
    onDone();
  }

  return (
    <Modal open onClose={onClose} busy={busy} title="Agregar extra"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button onClick={submit} loading={busy} disabled={!x}>Agregar {x ? formatMoney(total) : ""}</Button></>}>
      <label className="flex flex-col gap-1 text-sm font-medium">Extra
        <Select value={extraId} onChange={(e) => setExtraId(e.target.value)}>
          {catalog.map((c) => <option key={c.id} value={c.id}>{c.name} — {extraPriceLabel(c)}</option>)}
        </Select>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Cantidad" type="number" inputMode="numeric" min={1} max={99} value={qty} onChange={(e) => setQty(e.target.value)} />
        {x?.per_day && <TextField label={`Días (de ${stayDays})`} type="number" inputMode="numeric" min={1} max={stayDays} value={days} onChange={(e) => setDays(e.target.value)} />}
      </div>
      <p className="text-sm">Se suma al total de la reserva: <strong className="font-mono">{formatMoney(total)}</strong>. Queda como deuda hasta que lo cobres.</p>
      {error && <Alert tone="danger">{error}</Alert>}
    </Modal>
  );
}

function VoidExtraModal({ line, onClose, onDone }: { line: ReservationExtra; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (reason.trim().length < 3) return setError("Indicá el motivo.");
    setBusy(true);
    setError(null);
    const { error: err } = await getSupabase().rpc("void_reservation_extra", { p_extra_line_id: line.id, p_reason: reason.trim() });
    setBusy(false);
    if (err) return setError(friendlyError(err));
    onDone();
  }
  return (
    <Modal open onClose={onClose} busy={busy} title="Anular extra"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button variant="danger" onClick={submit} loading={busy}>Anular</Button></>}>
      <p className="text-sm">{line.description}{line.quantity > 1 ? ` × ${line.quantity}` : ""}: <strong>{formatMoney(line.amount)}</strong> se resta del total. Queda registrado como anulado. Si ya lo cobraste, la devolución se hace desde los cobros.</p>
      <TextField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Ej: No lo usó" />
      {error && <Alert tone="danger">{error}</Alert>}
    </Modal>
  );
}

export type ExtraPick = { extra_id: string; quantity: number; days: number };

/**
 * Extras al crear una reserva: se eligen del catálogo con su cantidad (y días, si se cobran por día).
 * Un administrador puede crear un extra nuevo o editar la lista desde acá mismo.
 */
export function ExtrasPicker({ stayDays, value, onChange, disabled }: {
  stayDays: number; value: ExtraPick[]; onChange: (v: ExtraPick[]) => void; disabled?: boolean;
}) {
  const { ws, isAdmin } = useWorkspace();
  const q = useLoader(async () => {
    const res = await getSupabase().from("extras").select("id, name, price, per_day, active, version").eq("workspace_id", ws.id).eq("active", true).order("name");
    if (res.error && (res.error.code === "42P01" || res.error.code === "PGRST205")) return { missing: true, rows: [] as Extra[] };
    return { missing: false, rows: unwrap(res) as Extra[] };
  }, [ws.id], 0);
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState(false);
  if (q.data?.missing) return null;
  const catalog = q.data?.rows ?? [];
  const get = (id: string) => value.find((v) => v.extra_id === id);
  function set(id: string, qty: number) {
    const rest = value.filter((v) => v.extra_id !== id);
    onChange(qty > 0 ? [...rest, { extra_id: id, quantity: Math.min(99, qty), days: get(id)?.days ?? stayDays }] : rest);
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Extras (opcional)</span>
        {isAdmin && (
          <span className="flex gap-1">
            <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={() => setCreating(true)}>+ Nuevo extra</Button>
            {catalog.length > 0 && <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={() => setManaging(true)}>Editar lista</Button>}
          </span>
        )}
      </div>
      {!q.data ? <span className="flex items-center gap-2 text-xs text-muted"><Spinner small /> Cargando extras…</span>
        : catalog.length === 0 ? <p className="text-xs text-muted">Reposeras, estacionamiento o lo que cobres aparte.{isAdmin ? " Tocá «+ Nuevo extra» para cargar el primero." : " Pedile a un administrador que los cargue."}</p>
        : (
          <ul className={cx("flex flex-col gap-1.5", disabled && "pointer-events-none opacity-50")}>
            {catalog.map((x) => {
              const v = get(x.id);
              const n = v?.quantity ?? 0;
              return (
                <li key={x.id} className={cx("flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-sm", n ? "border-accent/50 bg-accent-soft" : "border-line")}>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{x.name}</span>
                    <span className="block text-xs text-muted">{extraPriceLabel(x)}{n && x.per_day ? ` × ${v!.days} días` : ""}{n ? ` = ${formatMoney(extraAmount(Number(x.price), n, v!.days, x.per_day))}` : ""}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <button type="button" className="h-7 w-7 rounded-md border border-line font-bold hover:bg-surface-2 disabled:opacity-40" disabled={!n} onClick={() => set(x.id, n - 1)} aria-label={`Quitar un ${x.name}`}>−</button>
                    <span className="w-6 text-center tabular font-semibold">{n}</span>
                    <button type="button" className="h-7 w-7 rounded-md border border-line font-bold hover:bg-surface-2" onClick={() => set(x.id, n + 1)} aria-label={`Sumar un ${x.name}`}>+</button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      {disabled && value.length > 0 && <p className="text-xs text-warn">Una cortesía no lleva extras con cargo.</p>}
      {creating && <ExtraForm extra={null} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); q.reload(); }} />}
      {managing && (
        <Modal open onClose={() => { setManaging(false); q.reload(); }} title="Lista de extras" wide
          footer={<Button variant="secondary" onClick={() => { setManaging(false); q.reload(); }}>Listo</Button>}>
          <CardBareContext.Provider value={true}><ExtrasCard /></CardBareContext.Provider>
        </Modal>
      )}
    </div>
  );
}

/** Total de los extras elegidos (con el catálogo a mano). */
export function useExtrasTotal(value: ExtraPick[]): number {
  const { ws } = useWorkspace();
  const q = useLoader(async () => {
    const res = await getSupabase().from("extras").select("id, price, per_day").eq("workspace_id", ws.id);
    return res.error ? [] : (res.data as { id: string; price: number; per_day: boolean }[]);
  }, [ws.id, value.length], 0);
  return value.reduce((sum, v) => {
    const x = q.data?.find((c) => c.id === v.extra_id);
    return x ? sum + extraAmount(Number(x.price), v.quantity, v.days, x.per_day) : sum;
  }, 0);
}

/** Desde el mapa: sumar un extra a la reserva de esa carpa. */
export function QuickAddExtra({ reservationId, stayDays, onClose, onDone }: { reservationId: string; stayDays: number; onClose: () => void; onDone: () => void }) {
  const { ws, isAdmin } = useWorkspace();
  const q = useLoader(async () => {
    const res = await getSupabase().from("extras").select("id, name, price, per_day, active, version").eq("workspace_id", ws.id).eq("active", true).order("name");
    if (res.error && (res.error.code === "42P01" || res.error.code === "PGRST205")) return { missing: true, rows: [] as Extra[] };
    return { missing: false, rows: unwrap(res) as Extra[] };
  }, [ws.id], 0);
  const [creating, setCreating] = useState(false);
  if (!q.data) return <Modal open onClose={onClose} title="Agregar extra"><span className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando…</span></Modal>;
  if (creating || (isAdmin && !q.data.missing && q.data.rows.length === 0)) {
    // Sin extras cargados: un administrador crea el primero y después lo suma.
    return <ExtraForm extra={null} onClose={onClose} onSaved={() => { setCreating(false); q.reload(); }} />;
  }
  if (q.data.missing || q.data.rows.length === 0) {
    return (
      <Modal open onClose={onClose} title="Agregar extra" footer={<Button variant="secondary" onClick={onClose}>Cerrar</Button>}>
        <p className="text-sm text-muted">{q.data.missing ? "Para usar extras hay que aplicar la actualización 0029 de la base de datos." : "Todavía no hay extras cargados. Pedile a un administrador que los cargue."}</p>
      </Modal>
    );
  }
  return <AddExtraModal reservationId={reservationId} catalog={q.data.rows} stayDays={stayDays} onClose={onClose} onDone={onDone} />;
}
