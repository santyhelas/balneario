"use client";
import { useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatMoney } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Field, Input, Modal, Textarea, TextField, cx } from "@/components/ui";

export type Pkg = { id: string; min_days: number; percent: number; active: boolean; version: number };
export type Agreement = { id: string; name: string; percent: number; active: boolean; valid_from: string | null; valid_to: string | null; conditions: string | null; version: number };

export function PackagesCard({ pkgs, cashPercent, wsVersion, editable, onChanged }: { pkgs: Pkg[]; cashPercent: number; wsVersion: number; editable: boolean; onChanged: () => void }) {
  const { ws } = useWorkspace();
  const [days, setDays] = useState("");
  const [pct, setPct] = useState("");
  const [cash, setCash] = useState(String(cashPercent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sb = getSupabase();
  const active = pkgs.filter((p) => p.active);

  async function run(fn: () => PromiseLike<{ error: unknown }>) {
    setBusy(true);
    setError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) return setError(friendlyError(error));
    onChanged();
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const d = Number(days);
    const p = Number(pct.replace(",", "."));
    if (!Number.isInteger(d) || d < 2) return setError("Los días deben ser un número entero mayor a 1.");
    if (!(p > 0 && p <= 100)) return setError("El porcentaje debe estar entre 0 y 100.");
    await run(() => sb.from("package_discounts").insert({ workspace_id: ws.id, min_days: d, percent: p }).select("id"));
    setDays("");
    setPct("");
  }

  return (
    <Card title="Descuentos por paquete de días">
      {active.length === 0 ? <EmptyState>Sin descuentos por paquete.</EmptyState> : (
        <ul className="mb-3 divide-y divide-line text-sm">
          {active.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 py-1.5">
              <span>Desde <strong>{p.min_days} días</strong>: {Number(p.percent)}%</span>
              {editable && (
                <div className="flex gap-2">
                  <button className="text-xs text-accent hover:underline" disabled={busy} onClick={() => {
                    const v = window.prompt(`Nuevo porcentaje para ${p.min_days} días`, String(Number(p.percent)));
                    if (v === null) return;
                    const n = Number(v.replace(",", "."));
                    if (!(n > 0 && n <= 100)) return setError("El porcentaje debe estar entre 0 y 100.");
                    run(() => sb.from("package_discounts").update({ percent: n, version: p.version + 1 }).eq("id", p.id).select("id"));
                  }}>Cambiar %</button>
                  <button className="text-xs text-danger hover:underline" disabled={busy} onClick={() =>
                    run(() => sb.from("package_discounts").update({ active: false, version: p.version + 1 }).eq("id", p.id).select("id"))
                  }>Quitar</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mb-3 text-xs text-muted">Se aplica el escalón más alto que alcance la estadía. Ej.: 10 días toma el de 7.</p>
      {editable && (
        <form onSubmit={add} className="mb-4 flex flex-wrap items-end gap-2">
          <Field label="Desde (días)"><Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} className="w-24" /></Field>
          <Field label="%"><Input inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} className="w-20" /></Field>
          <Button type="submit" variant="secondary" loading={busy}>Agregar</Button>
        </form>
      )}
      <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
        <Field label="Descuento por pago en efectivo (%)">
          <Input inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} disabled={!editable} className="w-24" />
        </Field>
        {editable && Number(cash.replace(",", ".")) !== Number(cashPercent) && (
          <Button variant="secondary" loading={busy} onClick={() => {
            const n = Number(cash.replace(",", "."));
            if (!(n >= 0 && n <= 100)) return setError("El porcentaje debe estar entre 0 y 100.");
            run(() => sb.from("workspaces").update({ cash_discount_percent: n, version: wsVersion + 1 }).eq("id", ws.id).select("id"));
          }}>Guardar</Button>
        )}
      </div>
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
    </Card>
  );
}

/** Convenios del balneario, sin los eliminados (si falta la actualización 0032, los trae todos). */
export async function loadAgreements(sb: SupabaseClient, wsId: string): Promise<Agreement[]> {
  const cols = "id, name, percent, active, valid_from, valid_to, conditions, version";
  let res = await sb.from("agreements").select(cols).eq("workspace_id", wsId).is("deleted_at", null).order("active", { ascending: false }).order("name");
  if (res.error?.code === "42703") res = await sb.from("agreements").select(cols).eq("workspace_id", wsId).order("active", { ascending: false }).order("name");
  if (res.error) throw res.error;
  return (res.data ?? []) as Agreement[];
}

export function AgreementsCard({ agreements, editable, onChanged }: { agreements: Agreement[]; editable: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<Agreement | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Agreement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function toggle(a: Agreement) {
    setBusy(true);
    setErr(null);
    const { error } = await getSupabase().from("agreements").update({ active: !a.active, version: a.version + 1 }).eq("id", a.id).select("id").single();
    setBusy(false);
    if (error) { setErr(friendlyError(error)); return; }
    onChanged();
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setErr(null);
    const { error } = await getSupabase().rpc("delete_agreement", { p_agreement_id: deleting.id, p_expected_version: deleting.version });
    setBusy(false);
    if (error) { setErr(friendlyError(error)); return; }
    setDeleting(null);
    onChanged();
  }
  return (
    <Card title="Convenios" actions={editable ? <Button variant="secondary" onClick={() => setCreating(true)}>Nuevo convenio</Button> : undefined}>
      {agreements.length === 0 ? <EmptyState>Sin convenios.</EmptyState> : (
        <ul className="divide-y divide-line text-sm">
          {agreements.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 py-2">
              <div>
                <div className="font-medium">{a.name} · {Number(a.percent)}% {!a.active && <Badge tone="muted">Deshabilitado</Badge>}</div>
                <div className="text-xs text-muted">
                  {a.valid_from || a.valid_to ? `Vigente ${a.valid_from ? `desde ${formatDate(a.valid_from)}` : ""} ${a.valid_to ? `hasta ${formatDate(a.valid_to)}` : ""}` : "Sin fecha de vencimiento"}
                  {a.conditions ? ` · ${a.conditions}` : ""}
                </div>
              </div>
              {editable && (
                <span className="flex shrink-0 gap-3">
                  <button className="text-xs text-accent hover:underline" onClick={() => setEditing(a)}>Editar</button>
                  <button className="text-xs text-accent hover:underline" disabled={busy} onClick={() => toggle(a)}>{a.active ? "Deshabilitar" : "Habilitar"}</button>
                  <button className="text-xs text-danger hover:underline" onClick={() => { setErr(null); setDeleting(a); }}>Eliminar</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {err && <Alert tone="danger" className="mt-2">{err}</Alert>}
      <ConfirmDialog open={!!deleting} title="Eliminar convenio" confirmLabel="Eliminar" danger busy={busy}
        message={<>¿Eliminar el convenio <strong>{deleting?.name}</strong>? Deja de aparecer y no se ofrece más en las reservas nuevas. Las reservas que ya lo usaron conservan su descuento tal cual.</>}
        onCancel={() => setDeleting(null)} onConfirm={remove} />
      <AgreementModal open={creating || editing !== null} agreement={editing} onClose={() => { setCreating(false); setEditing(null); }} onDone={() => { setCreating(false); setEditing(null); onChanged(); }} />
    </Card>
  );
}

export function AgreementModal({ open, agreement, onClose, onDone }: { open: boolean; agreement: Agreement | null; onClose: () => void; onDone: () => void }) {
  const { ws } = useWorkspace();
  const [name, setName] = useState("");
  const [pct, setPct] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [conditions, setConditions] = useState("");
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null | undefined>(undefined);

  if (open && lastId !== (agreement?.id ?? null)) {
    setLastId(agreement?.id ?? null);
    setName(agreement?.name ?? "");
    setPct(agreement ? String(Number(agreement.percent)) : "");
    setFrom(agreement?.valid_from ?? "");
    setTo(agreement?.valid_to ?? "");
    setConditions(agreement?.conditions ?? "");
    setActive(agreement?.active ?? true);
    setError(null);
  }
  if (!open && lastId !== undefined) setLastId(undefined);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const sb = getSupabase();
    setBusy(true);
    setError(null);
    const base = { name: name.trim(), valid_from: from || null, valid_to: to || null, conditions: conditions.trim() || null, active };
    let res;
    if (agreement) {
      res = await sb.from("agreements").update({ ...base, version: agreement.version + 1 }).eq("id", agreement.id).select("id");
    } else {
      const p = Number(pct.replace(",", "."));
      if (!(p > 0 && p <= 100)) {
        setBusy(false);
        return setError("El porcentaje debe estar entre 0 y 100.");
      }
      res = await sb.from("agreements").insert({ ...base, workspace_id: ws.id, percent: p }).select("id");
    }
    setBusy(false);
    if (res.error) return setError(friendlyError(res.error));
    onDone();
  }

  return (
    <Modal open={open} onClose={onClose} title={agreement ? `Editar convenio ${agreement.name}` : "Nuevo convenio"} busy={busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <TextField label="Nombre" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Ej: Hotel Parque Bonito" />
        {agreement ? (
          <p className="text-sm text-muted">Descuento: <strong className="text-fg">{Number(agreement.percent)}%</strong>. Para cambiar el porcentaje, desactivá este convenio y creá uno nuevo: así las reservas anteriores conservan el suyo.</p>
        ) : (
          <TextField label="Descuento (%)" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} required />
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vigente desde (opcional)"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Hasta (opcional)"><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <Field label="Condiciones (opcional)"><Textarea value={conditions} onChange={(e) => setConditions(e.target.value)} maxLength={500} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Activo (se ofrece en nuevas reservas)</label>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button type="submit" loading={busy}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}


export type DiscountMode = "cascada" | "sumados" | "mayor";

/** Cómo se combinan los descuentos automáticos, con un ejemplo en números. */
export function discountExample(mode: DiscountMode) {
  const base = 100000;
  const items = [{ l: "Paquete por días", p: 5 }, { l: "Convenio", p: 30 }, { l: "Pago en efectivo", p: 10 }];
  let cur = base;
  const lines: { l: string; amt: number }[] = [];
  if (mode === "mayor") {
    const best = items.reduce((a, b) => (b.p > a.p ? b : a));
    const amt = Math.floor((base * best.p) / 100);
    lines.push({ l: `${best.l} ${best.p}%`, amt });
    cur -= amt;
  } else {
    for (const it of items) {
      const amt = Math.floor(((mode === "sumados" ? base : cur) * it.p) / 100);
      lines.push({ l: `${it.l} ${it.p}%`, amt });
      cur -= amt;
    }
  }
  return { base, lines, total: cur };
}

const MODES: { key: DiscountMode; title: string; text: string }[] = [
  { key: "cascada", title: "En cascada", text: "Se suman todos, pero cada uno se calcula sobre lo que queda después del anterior. Es el más común." },
  { key: "sumados", title: "Sumados sobre el precio", text: "Se suman todos y cada uno se calcula sobre el precio base. Es el que más descuenta." },
  { key: "mayor", title: "No acumulables", text: "Se aplica solo el de mayor porcentaje; los demás no." },
];

export function DiscountModeCard({ mode, wsVersion, editable, onChanged }: { mode: DiscountMode | null; wsVersion: number; editable: boolean; onChanged: () => void }) {
  const { ws } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<DiscountMode>(mode ?? "cascada");
  if (mode === null) {
    return <Card title="Cómo se combinan los descuentos"><p className="text-sm text-muted">Para elegirlo hay que aplicar la actualización 0032 de la base de datos.</p></Card>;
  }
  async function choose(m: DiscountMode) {
    setPreview(m);
    if (!editable || m === mode) return;
    setBusy(true);
    setErr(null);
    const { error } = await getSupabase().from("workspaces").update({ discount_mode: m, version: wsVersion + 1 }).eq("id", ws.id).select("id").single();
    setBusy(false);
    if (error) { setErr(friendlyError(error)); setPreview(mode!); return; }
    onChanged();
  }
  const ex = discountExample(preview);
  return (
    <Card title="Cómo se combinan los descuentos">
      <p className="mb-3 text-sm text-muted">Cuando a una reserva le corresponden varios descuentos a la vez (paquete por días, convenio y pago en efectivo).</p>
      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Cómo se combinan los descuentos">
        {MODES.map((m) => (
          <label key={m.key} className={cx("flex cursor-pointer gap-3 rounded-xl border p-3 text-sm", mode === m.key ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2", !editable && "cursor-default")}
            onMouseEnter={() => setPreview(m.key)} onMouseLeave={() => setPreview(mode)}>
            <input type="radio" name="discount-mode" className="mt-1" checked={mode === m.key} disabled={!editable || busy} onChange={() => choose(m.key)} />
            <span><strong>{m.title}</strong><span className="block text-muted">{m.text}</span></span>
          </label>
        ))}
      </div>
      <div className="mt-3 rounded-xl bg-surface-2 p-3 text-sm">
        <div className="mb-1 text-xs font-semibold text-muted">Ejemplo «{MODES.find((m) => m.key === preview)?.title}»: carpa de {formatMoney(ex.base)} con paquete 5%, convenio 30% y efectivo 10%</div>
        {ex.lines.map((l) => <div key={l.l} className="flex justify-between"><span>{l.l}</span><span className="tabular text-ok">− {formatMoney(l.amt)}</span></div>)}
        {preview === "mayor" && <div className="text-xs text-muted">Paquete y efectivo no se aplican (son menores).</div>}
        <div className="mt-1 flex justify-between border-t border-line pt-1 font-semibold"><span>Total</span><span className="tabular">{formatMoney(ex.total)}</span></div>
      </div>
      <p className="mt-2 text-xs text-muted">
        El descuento manual (con motivo, de un administrador) se aplica siempre, al final. Cada descuento se redondea hacia abajo al peso.
        Cambiar esto no modifica las reservas ya hechas.
      </p>
      {err && <Alert tone="danger" className="mt-2">{err}</Alert>}
    </Card>
  );
}

/** Tope de descuento: el total de descuentos de una reserva no pasa de este % del precio base. */
export function DiscountCapCard({ cap, wsVersion, editable, onChanged }: { cap: number | null | undefined; wsVersion: number; editable: boolean; onChanged: () => void }) {
  const { ws } = useWorkspace();
  const [value, setValue] = useState(cap ? String(Number(cap)) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  if (cap === undefined) {
    return <Card title="Tope de descuento"><p className="text-sm text-muted">Para usarlo hay que aplicar la actualización 0033 de la base de datos.</p></Card>;
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    const v = value.trim() === "" ? null : Number(value.replace(",", "."));
    if (v !== null && (!Number.isFinite(v) || v <= 0 || v > 100)) { setMsg({ tone: "danger", text: "Poné un porcentaje entre 1 y 100, o dejalo vacío para no tener tope." }); return; }
    setBusy(true);
    setMsg(null);
    const { error } = await getSupabase().from("workspaces").update({ discount_cap_percent: v, version: wsVersion + 1 }).eq("id", ws.id).select("id").single();
    setBusy(false);
    if (error) { setMsg({ tone: "danger", text: friendlyError(error) }); return; }
    setMsg({ tone: "ok", text: v === null ? "Listo: sin tope de descuento." : `Listo: ninguna reserva va a tener más de ${v}% de descuento en total.` });
    onChanged();
  }
  return (
    <Card title="Tope de descuento">
      <form onSubmit={save} className="flex flex-col gap-2 text-sm">
        <p className="text-muted">El total de descuentos de una reserva (paquete, convenio, efectivo y manual) no puede pasar de este porcentaje del precio. Si se pasa, se recorta empezando por el último (el manual).</p>
        <div className="flex items-end gap-2">
          <TextField label="Tope (%)" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Sin tope" disabled={!editable} className="w-32" />
          {editable && <Button type="submit" variant="secondary" loading={busy}>Guardar</Button>}
        </div>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </form>
    </Card>
  );
}
