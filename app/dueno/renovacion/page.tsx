"use client";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatMoney, parseMoney, todayISO } from "@/lib/format";
import { whatsappLink } from "@/lib/reservations";
import { mailtoLink, providerForEmail } from "@/lib/whatsapp-messages";
import { SyncNotice } from "@/components/shell";
import { Alert, Button, ConfirmDialog, EmptyState, Field, Input, Modal, Select, Spinner, Textarea, cx } from "@/components/ui";
import { KPI_ICON, Kpi, seasonYear } from "@/components/owner/board";
import { useOwner } from "@/components/owner/context";

type Plan = "anual" | "temporada";
type Estado = "pendiente" | "enviada" | "acepta" | "no_renueva";
type Row = {
  id: string; nombre: string; telefono: string | null; correo: string | null; pausado: boolean;
  actual: { plan: Plan | "mensual"; precio: number; entrada: number | null; cuota: number | null; pago_hasta: string | null };
  propuesta: { plan: Plan; precio: number; entrada: number | null; cuota: number | null; estado: Estado; nota: string | null; enviada: string | null; aplicada: string | null } | null;
};
const ESTADO: Record<Estado, { label: string; cls: string }> = {
  pendiente: { label: "Sin mandar", cls: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300" },
  enviada: { label: "Propuesta mandada", cls: "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100" },
  acepta: { label: "Renueva", cls: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100" },
  no_renueva: { label: "No renueva", cls: "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-100" },
};
const label = (s: number) => `${s - 1}/${String(s).slice(2)}`;
const roundTo = (n: number, step: number) => Math.round(n / step) * step;

/** Renovación de temporada: propuesta de precio para cada balneario, mensaje armado y aplicar el precio cuando acepta. */
export default function OwnerRenewals() {
  const sb = getSupabase();
  const hoy = todayISO();
  const m = Number(hoy.slice(5, 7));
  const [season, setSeason] = useState(m >= 4 && m <= 10 ? seasonYear(hoy) : seasonYear(hoy) + 1);
  const q = useLoader(async () => unwrap(await sb.rpc("admin_renewals", { p_season: season })) as Row[], [season], 120_000);
  const [pct, setPct] = useState("20");
  const [step, setStep] = useState(5000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [send, setSend] = useState<Row | null>(null);
  const [applyFor, setApplyFor] = useState<Row | null>(null);
  const rows = q.data ?? [];
  const sinProp = rows.filter((r) => !r.propuesta && !r.pausado);
  const count = (e: Estado) => rows.filter((r) => r.propuesta?.estado === e).length;
  const totalAcepta = rows.filter((r) => r.propuesta?.estado === "acepta").reduce((a, r) => a + Number(r.propuesta!.precio), 0);

  async function save(r: Row, p: Partial<NonNullable<Row["propuesta"]>>) {
    const cur = r.propuesta ?? suggest(r, Number(pct) || 0, step);
    const v = { ...cur, ...p };
    const { error } = await sb.rpc("admin_save_renewal", {
      p_workspace_id: r.id, p_season: season, p_plan: v.plan, p_price: v.precio, p_entry: v.entrada, p_installment: v.cuota, p_status: v.estado, p_note: v.nota,
    });
    if (error) { setMsg({ tone: "danger", text: friendlyError(error) }); return false; }
    q.reload();
    return true;
  }
  async function proposeAll() {
    setBusy(true);
    let n = 0;
    for (const r of sinProp) if (await save(r, {})) n++;
    setBusy(false);
    setMsg({ tone: "ok", text: `Listo: ${n} ${n === 1 ? "propuesta armada" : "propuestas armadas"} con +${pct}% redondeado a ${formatMoney(step)}. Revisalas y mandalas.` });
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Renovación de temporada</h1>
          <p className="text-sm text-muted">Armá la propuesta de precio para cada balneario, mandala y anotá quién renueva.</p>
        </div>
        <div className="w-40"><Select aria-label="Temporada" value={season} onChange={(e) => setSeason(Number(e.target.value))}>
          {[seasonYear(hoy), seasonYear(hoy) + 1, seasonYear(hoy) + 2].map((s) => <option key={s} value={s}>Temporada {label(s)}</option>)}
        </Select></div>
      </div>
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {q.error && /admin_renewals|schema cache|function/i.test(q.error) && !q.data && <Alert tone="warn">Falta correr la actualización 0057 en Supabase.</Alert>}
      {msg && <Alert tone={msg.tone} className="mb-3">{msg.text}</Alert>}
      {!q.data ? (q.loading && <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando…</div>) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi icon={KPI_ICON.casa} label="Balnearios" value={String(rows.length)} note={`${sinProp.length} sin propuesta`} />
            <Kpi icon={KPI_ICON.reloj} tone="sand" label="Mandadas" value={String(count("enviada"))} note="esperando respuesta" />
            <Kpi icon={KPI_ICON.ok} tone="green" label="Renuevan" value={String(count("acepta"))} note={formatMoney(totalAcepta)} />
            <Kpi icon="M6 6l12 12M18 6L6 18" tone="red" label="No renuevan" value={String(count("no_renueva"))} />
          </div>

          {sinProp.length > 0 && (
            <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-dashed border-accent/50 bg-accent-soft/40 p-4">
              <div className="w-28"><Field label="Aumento %" htmlFor="ren-pct"><Input id="ren-pct" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} /></Field></div>
              <div className="w-44"><Field label="Redondear a" htmlFor="ren-step">
                <Select id="ren-step" value={step} onChange={(e) => setStep(Number(e.target.value))}>{[1000, 5000, 10000].map((s) => <option key={s} value={s}>{formatMoney(s)}</option>)}</Select>
              </Field></div>
              <Button loading={busy} onClick={proposeAll}>Armar propuesta para los {sinProp.length} que faltan</Button>
              <p className="w-full text-xs text-muted">Toma lo que paga cada uno hoy, le suma el porcentaje y redondea. Después podés cambiar cada uno a mano.</p>
            </div>
          )}

          {rows.length === 0 ? <EmptyState>No hay balnearios con plan.</EmptyState> : (
            <ul className="grid gap-3 lg:grid-cols-2">
              {rows.map((r) => <RenewalCard key={r.id} r={r} pct={Number(pct) || 0} step={step} onSave={(p) => save(r, p)} onSend={() => setSend(r)} onApply={() => setApplyFor(r)} />)}
            </ul>
          )}
        </div>
      )}
      {send && send.propuesta && <SendModal r={send} season={season} onClose={() => setSend(null)} onSent={async () => { if (send.propuesta!.estado === "pendiente") await save(send, { estado: "enviada" }); }} />}
      <ConfirmDialog open={!!applyFor} title="Aplicar el precio nuevo" confirmLabel="Aplicar" busy={busy}
        message={<>Desde ahora <strong>{applyFor?.nombre}</strong> pasa a pagar {applyFor?.propuesta ? desc(applyFor.propuesta) : ""}. No cambia los pagos ya hechos ni las fechas.
          Hacelo cuando ya terminó de pagar la temporada actual (si todavía le falta una cuota, esa cuota pasaría a valer el precio nuevo).</>}
        onCancel={() => setApplyFor(null)}
        onConfirm={async () => {
          if (!applyFor) return;
          setBusy(true);
          const { error } = await sb.rpc("admin_apply_renewal", { p_workspace_id: applyFor.id, p_season: season });
          setBusy(false);
          setMsg(error ? { tone: "danger", text: friendlyError(error) } : { tone: "ok", text: `Precio nuevo aplicado a ${applyFor.nombre}.` });
          setApplyFor(null);
          q.reload();
        }} />
    </>
  );
}

function suggest(r: Row, pct: number, step: number): NonNullable<Row["propuesta"]> {
  const f = 1 + pct / 100;
  const plan: Plan = r.actual.plan === "anual" ? "anual" : "temporada";
  if (plan === "temporada" && r.actual.entrada != null && r.actual.cuota != null) {
    const e = roundTo(Number(r.actual.entrada) * f, step), c = roundTo(Number(r.actual.cuota) * f, step);
    return { plan, precio: e + 2 * c, entrada: e, cuota: c, estado: "pendiente", nota: null, enviada: null, aplicada: null };
  }
  const p = roundTo(Number(r.actual.precio) * f, step);
  return { plan: "anual", precio: p, entrada: null, cuota: null, estado: "pendiente", nota: null, enviada: null, aplicada: null };
}
const desc = (p: { plan: Plan; precio: number; entrada: number | null; cuota: number | null }) =>
  p.plan === "temporada" && p.entrada != null && p.cuota != null ? `entrada ${formatMoney(p.entrada)} + 2 cuotas de ${formatMoney(p.cuota)} (${formatMoney(p.precio)})` : `plan anual ${formatMoney(p.precio)}`;

function RenewalCard({ r, pct, step, onSave, onSend, onApply }: { r: Row; pct: number; step: number; onSave: (p: Partial<NonNullable<Row["propuesta"]>>) => Promise<boolean>; onSend: () => void; onApply: () => void }) {
  const p = r.propuesta;
  const [editing, setEditing] = useState(false);
  const base = p ?? suggest(r, pct, step);
  const [plan, setPlan] = useState<Plan>(base.plan);
  const [price, setPrice] = useState(String(base.precio));
  const [entry, setEntry] = useState(String(base.entrada ?? ""));
  const [inst, setInst] = useState(String(base.cuota ?? ""));
  const [busy, setBusy] = useState(false);
  const actual = r.actual.plan === "temporada" && r.actual.entrada != null && r.actual.cuota != null
    ? `entrada ${formatMoney(r.actual.entrada)} + 2 × ${formatMoney(r.actual.cuota)}` : `${r.actual.plan} ${formatMoney(r.actual.precio)}`;
  const up = p ? Math.round(((Number(p.precio) - Number(r.actual.precio)) / Math.max(1, Number(r.actual.precio))) * 100) : null;
  return (
    <li className={cx("flex flex-col gap-3 rounded-2xl border bg-surface p-4", p?.estado === "acepta" ? "border-emerald-400/60" : p?.estado === "no_renueva" ? "border-rose-400/60" : "border-line")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-semibold">{r.nombre}{r.pausado ? " (en pausa)" : ""}</div>
          <div className="text-xs text-muted">Hoy paga: {actual}</div>
        </div>
        {p && <span className={cx("shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold", ESTADO[p.estado].cls)}>{ESTADO[p.estado].label}</span>}
      </div>
      {!editing && p ? (
        <div className="rounded-xl bg-surface-2 px-3 py-2 text-sm">
          Propuesta: <strong>{desc(p)}</strong>{up != null && <span className="text-xs text-muted"> · {up >= 0 ? "+" : ""}{up}%</span>}
          {p.aplicada && <span className="ml-1 text-xs text-ok">· ya aplicado</span>}
        </div>
      ) : editing || !p ? (
        <div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface p-1 text-sm">
            {(["temporada", "anual"] as const).map((k) => (
              <button key={k} type="button" onClick={() => setPlan(k)} className={cx("rounded-md px-3 py-1 font-semibold", plan === k ? "bg-accent text-accent-fg" : "text-muted")}>{k === "temporada" ? "Temporada" : "Anual"}</button>
            ))}
          </div>
          {plan === "anual" ? <Input aria-label="Precio anual" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /> : (
            <div className="grid grid-cols-2 gap-2">
              <Input aria-label="Entrada" placeholder="Entrada" inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} />
              <Input aria-label="Cada cuota" placeholder="Cada cuota" inputMode="decimal" value={inst} onChange={(e) => setInst(e.target.value)} />
            </div>
          )}
          <Button loading={busy} onClick={async () => {
            setBusy(true);
            const ok = await onSave(plan === "anual" ? { plan, precio: parseMoney(price) ?? 0, entrada: null, cuota: null } : { plan, precio: 0, entrada: parseMoney(entry), cuota: parseMoney(inst) });
            setBusy(false);
            if (ok) setEditing(false);
          }}>{p ? "Guardar" : "Guardar propuesta"}</Button>
        </div>
      ) : null}
      {p && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={onSend}>Mandar propuesta</Button>
          <Select aria-label="Estado" value={p.estado} onChange={(e) => onSave({ estado: e.target.value as Estado })} className="w-auto">
            {(Object.keys(ESTADO) as Estado[]).map((k) => <option key={k} value={k}>{ESTADO[k].label}</option>)}
          </Select>
          {!editing && <Button variant="ghost" onClick={() => setEditing(true)}>Cambiar precio</Button>}
          {p.estado === "acepta" && !p.aplicada && <Button onClick={onApply}>Aplicar precio nuevo</Button>}
        </div>
      )}
    </li>
  );
}

function SendModal({ r, season, onClose, onSent }: { r: Row; season: number; onClose: () => void; onSent: () => void }) {
  const { email } = useOwner();
  const p = r.propuesta!;
  const detalle = p.plan === "temporada" && p.entrada != null && p.cuota != null
    ? `• Entrada: *${formatMoney(p.entrada)}* (al confirmar)\n• 2 cuotas de *${formatMoney(p.cuota)}* (vencen el 1/2 y el 1/3)\nTotal de la temporada: ${formatMoney(p.precio)}`
    : `• Plan anual: *${formatMoney(p.precio)}*`;
  const [text, setText] = useState(`¡Hola! Te escribo de Mi Balneario por ${r.nombre}.\nSe viene la temporada ${label(season)} y te paso la propuesta para seguir usando el sistema:\n${detalle}\nIncluye todas las actualizaciones y la ayuda de siempre. ¿Seguimos? Cualquier duda, te llamo.`);
  const wa = whatsappLink(r.telefono, text);
  return (
    <Modal open title={`Propuesta · ${r.nombre}`} onClose={onClose}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cerrar</Button>
        {r.correo && <a href={mailtoLink(r.correo, `Mi Balneario: temporada ${label(season)}`, text.replace(/\*/g, ""), providerForEmail(email), email)} target="_blank" rel="noopener noreferrer" onClick={onSent}><Button variant="secondary">Mandar por correo</Button></a>}
        {wa && <a href={wa} target="_blank" rel="noopener noreferrer" onClick={onSent}><Button>Abrir WhatsApp</Button></a>}
      </>}>
      <p className="mb-2 text-xs text-muted">Al mandarla queda como «Propuesta mandada».{!r.telefono && " El balneario no tiene teléfono cargado."}</p>
      <Textarea rows={9} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label="Mensaje" />
    </Modal>
  );
}
