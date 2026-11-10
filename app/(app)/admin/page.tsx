"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatDateTime, formatMoney, parseMoney } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Input, Modal, Select, Spinner, TextField, cx } from "@/components/ui";

/** Panel del dueño de Mi Balneario: balnearios, planes y cobros, altas habilitadas y pausas. */

type PlanKind = "mensual" | "temporada";
type PlanInfo = {
  plan: PlanKind; precio: number; estado: string; pago_hasta: string | null; vencido: boolean; debito: boolean;
  proximo_debito: string | null; ultimo_estado: "aprobado" | "rechazado" | null; ultimo_pago: string | null;
};
type Balneario = {
  id: string; nombre: string; creado: string; pausado: string | null; motivo_pausa: string | null; propietario: string | null;
  usuarios: number; carpas: number; sombrillas: number; max_carpas?: number | null; max_sombrillas?: number | null; reservas: number; reservas_30d: number; ultimo_uso: string | null;
  plan: PlanInfo | null;
};
type Habilitacion = { correo: string; nota: string | null; creado: string; usado: string | null; balneario: string | null; plan: PlanKind | null; precio: number | null; carpas?: number | null; sombrillas?: number | null };
type Aviso = { id: string; tipo: "cancelada" | "pago_rechazado"; balneario: string; workspace_id: string; importe: number | null; detalle: string | null; fecha: string };
type Overview = {
  balnearios: Balneario[]; habilitaciones: Habilitacion[]; avisos: Aviso[]; hoy: string; demos_abiertas: number;
  precios: { mensual: number; temporada: number; dias_gracia: number };
};

const daysAgo = (ts: string | null) => (ts ? Math.floor((Date.now() - new Date(ts).getTime()) / 86_400_000) : null);
const PLAN_LABEL: Record<PlanKind, string> = { mensual: "Mensual", temporada: "Temporada" };
const daysBetween = (a: string, b: string) => Math.round((new Date(b + "T12:00:00Z").getTime() - new Date(a + "T12:00:00Z").getTime()) / 86_400_000);

function planBadge(p: PlanInfo | null, hoy: string) {
  if (!p) return <Badge tone="info">Sin plan</Badge>;
  if (p.estado === "exenta") return <Badge tone="ok">Sin vencimiento</Badge>;
  if (p.vencido) return <Badge tone="danger">Vencido · solo lectura</Badge>;
  if (p.ultimo_estado === "rechazado") return <Badge tone="danger">Débito rechazado</Badge>;
  if (p.estado === "cancelada") return <Badge tone="warn">No renueva</Badge>;
  if (p.debito) return <Badge tone="ok">Débito activo</Badge>;
  if (p.pago_hasta && daysBetween(hoy, p.pago_hasta) <= 7) return <Badge tone="warn">Vence pronto</Badge>;
  if (p.estado === "pendiente") return <Badge tone="warn">Sin activar</Badge>;
  return <Badge tone="info">Pago manual</Badge>;
}

type FilterKey = "todos" | "atencion" | "al_dia" | "pausa" | "sin_plan";
const needsAttention = (b: Balneario, hoy: string) => {
  const p = b.plan;
  if (!p || p.estado === "exenta") return false;
  return p.vencido || p.ultimo_estado === "rechazado" || (!p.debito && !!p.pago_hasta && daysBetween(hoy, p.pago_hasta) <= 7);
};
const FILTERS: { key: FilterKey; label: string; test: (b: Balneario, hoy: string) => boolean }[] = [
  { key: "todos", label: "Todos", test: () => true },
  { key: "atencion", label: "Para atender", test: (b, hoy) => needsAttention(b, hoy) },
  { key: "al_dia", label: "Al día", test: (b, hoy) => !!b.plan && !b.pausado && !needsAttention(b, hoy) },
  { key: "pausa", label: "En pausa", test: (b) => !!b.pausado },
  { key: "sin_plan", label: "Sin plan", test: (b) => !b.plan },
];

export default function AdminPage() {
  const { isPlatformAdmin, ws } = useWorkspace();
  const sb = getSupabase();
  const q = useLoader(async () => unwrap(await sb.rpc("admin_overview")) as Overview, [], 60_000);
  const [pausing, setPausing] = useState<Balneario | null>(null);
  const [resuming, setResuming] = useState<Balneario | null>(null);
  const [deleting, setDeleting] = useState<Balneario | null>(null);
  const [revoking, setRevoking] = useState<Habilitacion | null>(null);
  const [planFor, setPlanFor] = useState<Balneario | null>(null);
  const [limitsFor, setLimitsFor] = useState<Balneario | null>(null);
  const [payFor, setPayFor] = useState<Balneario | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"balnearios" | "altas" | "precios">("balnearios");
  const [filter, setFilter] = useState<FilterKey>("todos");
  const [search, setSearch] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  if (!isPlatformAdmin && !q.data && q.error) {
    return (
      <>
        <PageHeader title="Panel del dueño" />
        <Alert tone="warn">Esta sección es solo para el dueño de Mi Balneario.</Alert>
      </>
    );
  }

  async function run(fn: () => PromiseLike<{ error: unknown }>, ok: string) {
    setBusy(true);
    setMsg(null);
    const { error } = await fn();
    setBusy(false);
    if (error) { setMsg({ tone: "danger", text: friendlyError(error) }); return false; }
    setMsg({ tone: "ok", text: ok });
    q.reload();
    return true;
  }

  // Mail al cliente para que elija su usuario y contraseña (la habilitación ya quedó guardada).
  async function invite(email: string, afterAdd: boolean) {
    setBusy(true);
    let r: { ok?: boolean; tipo?: string; error?: string } = {};
    try {
      const res = await fetch("/api/admin/invitar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      r = await res.json().catch(() => ({ error: "Respuesta inválida del servidor." }));
    } catch {
      r = { error: "No hay conexión con el servidor." };
    }
    setBusy(false);
    const head = afterAdd ? `${email} ya está habilitado. ` : "";
    if (r.ok) {
      setMsg({ tone: "ok", text: `${head}Le mandamos un mail a ${email} para que elija su usuario y contraseña${r.tipo === "ya_tenia_cuenta" ? " (ya tenía cuenta: también puede entrar directo con Google)" : ""}.` });
    } else {
      setMsg({ tone: "danger", text: `${head}Pero no se pudo mandar el mail: ${r.error ?? "error desconocido"} Igual puede entrar con Google usando ese correo.` });
    }
  }

  const d = q.data;
  const activos = d?.balnearios.filter((b) => !b.pausado) ?? [];
  const usados7 = activos.filter((b) => (daysAgo(b.ultimo_uso) ?? 99) <= 7).length;
  const conPlan = d?.balnearios.filter((b) => b.plan && b.plan.estado !== "exenta") ?? [];
  const vencidos = conPlan.filter((b) => b.plan!.vencido);
  const porVencer = d ? conPlan.filter((b) => !b.plan!.vencido && !b.plan!.debito && b.plan!.pago_hasta && daysBetween(d.hoy, b.plan!.pago_hasta) <= 7) : [];
  // Lo que entra por mes si todos los que tienen débito activo siguen (temporada: dividido 4 meses).
  const mensualizado = conPlan.filter((b) => b.plan!.estado === "activa" || b.plan!.estado === "manual")
    .reduce((a, b) => a + (b.plan!.plan === "mensual" ? Number(b.plan!.precio) : Number(b.plan!.precio) / 4), 0);

  return (
    <>
      <PageHeader title="Panel del dueño" subtitle="Los balnearios que usan Mi Balneario, sus planes, las altas habilitadas y las pausas." />
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {msg && <Alert tone={msg.tone} className="mb-3">{msg.text}</Alert>}
      {!d ? (q.loading && <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando…</div>) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="Balnearios" value={String(d.balnearios.length)} note={`${usados7} usados esta semana · ${d.balnearios.length - activos.length} en pausa`} />
            <Kpi label="Planes al día" value={String(conPlan.length - vencidos.length)} note={`${conPlan.filter((b) => b.plan!.debito).length} con débito automático`} />
            <Kpi label="Vencidos / por vencer" value={`${vencidos.length} / ${porVencer.length}`} note="por vencer: en 7 días y sin débito" tone={vencidos.length ? "danger" : undefined} />
            <Kpi label="Ingreso por mes (aprox.)" value={formatMoney(mensualizado)} note="mensuales + temporadas ÷ 4" />
          </div>

          {(d.avisos.length > 0 || vencidos.length > 0 || porVencer.length > 0) && (
            <Card title="Avisos">
              <ul className="divide-y divide-line text-sm">
                {vencidos.map((b) => (
                  <li key={`v${b.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span><Badge tone="danger">Solo lectura</Badge> <strong>{b.nombre}</strong>: plan vencido el {formatDate(b.plan!.pago_hasta)}.</span>
                    <Button variant="secondary" onClick={() => setPayFor(b)}>Registrar pago</Button>
                  </li>
                ))}
                {d.avisos.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <Badge tone={a.tipo === "pago_rechazado" ? "danger" : "warn"}>{a.tipo === "pago_rechazado" ? "Débito rechazado" : "Canceló"}</Badge>{" "}
                      <strong>{a.balneario}</strong>: {a.detalle}{a.importe != null ? ` (${formatMoney(a.importe)})` : ""}
                      <span className="block text-xs text-muted">{formatDateTime(a.fecha)}</span>
                    </span>
                    <Button variant="ghost" onClick={() => run(() => sb.rpc("admin_mark_seen", { p_event_id: a.id }), "Aviso marcado como visto.")}>Visto</Button>
                  </li>
                ))}
                {porVencer.map((b) => (
                  <li key={`p${b.id}`} className="py-2"><Badge tone="warn">Vence pronto</Badge> <strong>{b.nombre}</strong>: pago hasta el {formatDate(b.plan!.pago_hasta)}, sin débito automático.</li>
                ))}
              </ul>
            </Card>
          )}

          {/* Pestañas: así nada queda apretado ni cortado */}
          <div className="-mx-1 flex gap-1 overflow-x-auto border-b border-line px-1" role="tablist">
            {([["balnearios", `Balnearios (${d.balnearios.length})`], ["altas", `Altas habilitadas (${d.habilitaciones.filter((h) => !h.usado).length} sin usar)`], ["precios", "Precios"]] as const).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={tab === k ? "-mb-px shrink-0 whitespace-nowrap rounded-t-lg border border-b-0 border-line bg-surface px-4 py-2 text-sm font-semibold text-accent" : "shrink-0 whitespace-nowrap px-4 py-2 text-sm text-muted hover:text-fg"}>
                {l}
              </button>
            ))}
          </div>

          {tab === "balnearios" && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-full sm:w-72"><Input type="search" aria-label="Buscar balneario" placeholder="Buscar por nombre o correo…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
                {FILTERS.map((f) => (
                  <button key={f.key} type="button" onClick={() => setFilter(f.key)}
                    className={filter === f.key ? "rounded-full border border-accent bg-accent-soft px-3 py-1 text-sm font-semibold text-accent" : "rounded-full border border-line px-3 py-1 text-sm hover:bg-surface-2"}>
                    {f.label} <span className="tabular text-muted">{d.balnearios.filter((b) => f.test(b, d.hoy)).length}</span>
                  </button>
                ))}
              </div>
              {(() => {
                const t = search.trim().toLowerCase();
                const list = d.balnearios.filter((b) => FILTERS.find((f) => f.key === filter)!.test(b, d.hoy))
                  .filter((b) => !t || b.nombre.toLowerCase().includes(t) || (b.propietario ?? "").toLowerCase().includes(t));
                if (d.balnearios.length === 0) return <EmptyState>Todavía no hay balnearios.</EmptyState>;
                if (list.length === 0) return <EmptyState>Ningún balneario con ese filtro.</EmptyState>;
                return (
                  <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                    {list.map((b) => (
                      <BalnearioCard key={b.id} b={b} hoy={d.hoy} mine={b.id === ws.id}
                        onPlan={() => setPlanFor(b)} onPay={() => setPayFor(b)} onLimits={() => setLimitsFor(b)}
                        onPause={() => setPausing(b)} onResume={() => setResuming(b)} onDelete={() => setDeleting(b)} />
                    ))}
                  </div>
                );
              })()}
              <p className="text-xs text-muted">
                Con el plan vencido (o en pausa) el balneario ve y descarga sus datos, pero no carga nada nuevo; no se borra nada.
                Hay {d.precios.dias_gracia} días de gracia después del vencimiento. Demos abiertas ahora: {d.demos_abiertas}.
              </p>
            </>
          )}

          {tab === "altas" && (
            <SignupsCard rows={d.habilitaciones} busy={busy} prices={d.precios}
              onAdd={async (email, note, plan, price, tents, umbrellas) => {
                const ok = await run(() => sb.rpc("admin_allow_signup", { p_email: email, p_note: note || null, p_plan: plan, p_price: price, p_tents: tents, p_umbrellas: umbrellas }),
                  `Listo: ${email} ya puede crear su balneario.`);
                if (ok) await invite(email, true);
                return ok;
              }}
              onInvite={(email) => invite(email, false)}
              onRevoke={setRevoking} />
          )}

          {tab === "precios" && (
            <div className="max-w-xl">
              <PricesCard prices={d.precios} busy={busy}
                onSave={(m, t) => run(() => sb.rpc("admin_set_prices", { p_mensual: m, p_temporada: t }), "Precios guardados. Se usan para los clientes nuevos.")} />
            </div>
          )}
        </div>
      )}

      {limitsFor && <LimitsModal b={limitsFor} busy={busy} onClose={() => setLimitsFor(null)}
        onSave={async (t, u) => { if (await run(() => sb.rpc("admin_set_space_limits", { p_workspace_id: limitsFor.id, p_tents: t, p_umbrellas: u }), `Cantidad de ${limitsFor.nombre} guardada.`)) setLimitsFor(null); }} />}
      {deleting && <DeleteModal b={deleting} busy={busy} onClose={() => setDeleting(null)}
        onConfirm={async (name) => {
          const ok = await run(() => sb.rpc("admin_delete_workspace", { p_workspace_id: deleting.id, p_confirm_name: name }), `${deleting.nombre} se eliminó. Quedó guardada una copia por si hay que recuperarlo.`);
          if (ok) setDeleting(null);
        }} />}
      {pausing && <PauseModal b={pausing} busy={busy} onClose={() => setPausing(null)}
        onConfirm={async (reason) => { if (await run(() => sb.rpc("admin_set_paused", { p_workspace_id: pausing.id, p_paused: true, p_reason: reason }), `${pausing.nombre} quedó en pausa.`)) setPausing(null); }} />}
      {planFor && d && <PlanModal b={planFor} prices={d.precios} busy={busy} onClose={() => setPlanFor(null)}
        onSave={async (plan, price, exempt) => { if (await run(() => sb.rpc("admin_set_plan", { p_workspace_id: planFor.id, p_plan: plan, p_price: price, p_exempt: exempt }), `Plan de ${planFor.nombre} guardado.`)) setPlanFor(null); }} />}
      {payFor && <PaymentModal b={payFor} busy={busy} onClose={() => setPayFor(null)}
        onSave={async (amount, until, note) => { if (await run(() => sb.rpc("admin_register_payment", { p_workspace_id: payFor.id, p_amount: amount, p_until: until, p_note: note || null }), `Pago de ${payFor.nombre} registrado.`)) setPayFor(null); }} />}
      <ConfirmDialog open={!!resuming} title="Reactivar balneario" confirmLabel="Reactivar" busy={busy}
        message={<>¿Reactivar <strong>{resuming?.nombre}</strong>? Vuelve a poder cargar reservas, cobros y todo lo demás (si su plan está al día).</>}
        onCancel={() => setResuming(null)}
        onConfirm={async () => { if (resuming && await run(() => sb.rpc("admin_set_paused", { p_workspace_id: resuming.id, p_paused: false, p_reason: null }), `${resuming.nombre} está activo de nuevo.`)) setResuming(null); }} />
      <ConfirmDialog open={!!revoking} title="Quitar habilitación" confirmLabel="Quitar" danger busy={busy}
        message={<>¿Quitar la habilitación de <strong>{revoking?.correo}</strong>? Ya no va a poder crear su balneario.</>}
        onCancel={() => setRevoking(null)}
        onConfirm={async () => { if (revoking && await run(() => sb.rpc("admin_revoke_signup", { p_email: revoking.correo }), "Habilitación quitada.")) setRevoking(null); }} />
    </>
  );
}

function Kpi({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "danger" }) {
  return (
    <div className={tone === "danger" ? "rounded-xl border border-danger/40 bg-surface p-3" : "rounded-xl border border-line bg-surface p-3"}>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={tone === "danger" ? "text-2xl font-bold tabular text-danger" : "text-2xl font-bold tabular"}>{value}</div>
      <div className="text-xs text-muted">{note}</div>
    </div>
  );
}

function PlanFields({ plan, setPlan, price, setPrice }: { plan: PlanKind; setPlan: (p: PlanKind) => void; price: string; setPrice: (v: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="flex flex-col gap-1 text-sm font-medium">Plan
        <Select value={plan} onChange={(e) => setPlan(e.target.value as PlanKind)}>
          <option value="mensual">Mensual</option>
          <option value="temporada">Temporada (1/12 al 31/3)</option>
        </Select>
      </label>
      <TextField label="Precio" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
    </div>
  );
}

function SignupsCard({ rows, busy, prices, onAdd, onRevoke, onInvite }: {
  rows: Habilitacion[]; busy: boolean; prices: Overview["precios"];
  onAdd: (email: string, note: string, plan: PlanKind, price: number, tents: number | null, umbrellas: number | null) => Promise<boolean>; onRevoke: (h: Habilitacion) => void;
  onInvite: (email: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [tents, setTents] = useState("");
  const [umbrellas, setUmbrellas] = useState("");
  const [note, setNote] = useState("");
  const [plan, setPlan] = useState<PlanKind>("temporada");
  const [price, setPrice] = useState(String(prices.temporada || ""));
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = parseMoney(price);
    if (p == null || p < 0) return setErr("Poné el precio del plan.");
    const t = tents.trim() === "" ? null : Number(tents);
    const u = umbrellas.trim() === "" ? null : Number(umbrellas);
    if ((t != null && (!Number.isInteger(t) || t < 0 || t > 600)) || (u != null && (!Number.isInteger(u) || u < 0 || u > 300))) return setErr("Carpas: de 0 a 600; sombrillas: de 0 a 300.");
    setErr(null);
    if (await onAdd(email.trim().toLowerCase(), note.trim(), plan, p, t, u)) { setEmail(""); setNote(""); setTents(""); setUmbrellas(""); }
  }
  return (
    <Card title="Altas habilitadas">
      <p className="mb-3 text-sm text-muted">Cuando alguien contrata, poné su correo (el de Google o el que va a usar) y su plan. Le llega un mail para elegir su usuario y contraseña; también puede entrar con Google con ese mismo correo. Al crear su balneario tiene {prices.dias_gracia} días para activar el débito.</p>
      <div className="grid gap-6 lg:grid-cols-2">
      <form onSubmit={submit} className="flex flex-col gap-2">
        <TextField label="Correo" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cliente@gmail.com" />
        <PlanFields plan={plan} setPlan={(v) => { setPlan(v); setPrice(String((v === "mensual" ? prices.mensual : prices.temporada) || "")); }} price={price} setPrice={setPrice} />
        <div className="grid grid-cols-2 gap-2">
          <TextField label="Carpas contratadas" type="number" inputMode="numeric" min={0} max={600} value={tents} onChange={(e) => setTents(e.target.value)} placeholder="Ej: 90" />
          <TextField label="Sombrillas contratadas" type="number" inputMode="numeric" min={0} max={300} value={umbrellas} onChange={(e) => setUmbrellas(e.target.value)} placeholder="Ej: 10" />
        </div>
        <p className="-mt-1 text-xs text-muted">Es el máximo que va a poder tener activas. Si lo dejás vacío, el máximo es lo que cargue al crear su balneario.</p>
        <TextField label="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Ej: Balneario La Ola" />
        {err && <Alert tone="danger">{err}</Alert>}
        <Button type="submit" loading={busy}>Habilitar</Button>
      </form>
      {rows.length === 0 ? <EmptyState>No hay correos habilitados.</EmptyState> : (
        <ul className="divide-y divide-line self-start text-sm">
          {rows.map((h) => (
            <li key={h.correo} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="truncate font-medium">{h.correo}</div>
                <div className="text-xs text-muted">
                  {h.plan ? `${PLAN_LABEL[h.plan]}${h.precio != null ? ` ${formatMoney(h.precio)}` : ""} · ` : ""}{h.carpas != null || h.sombrillas != null ? `${h.carpas ?? "—"} carpas + ${h.sombrillas ?? "—"} sombrillas · ` : ""}{h.nota ? `${h.nota} · ` : ""}habilitado el {formatDate(h.creado.slice(0, 10))}
                </div>
              </div>
              {h.usado
                ? <Badge tone="ok">Creó {h.balneario ?? "su balneario"}</Badge>
                : <span className="flex items-center gap-2"><Badge tone="warn">Sin usar</Badge><Button variant="ghost" disabled={busy} onClick={() => onInvite(h.correo)}>Reenviar mail</Button><Button variant="ghost" onClick={() => onRevoke(h)}>Quitar</Button></span>}
            </li>
          ))}
        </ul>
      )}
      </div>
    </Card>
  );
}

function PricesCard({ prices, busy, onSave }: { prices: Overview["precios"]; busy: boolean; onSave: (m: number, t: number) => Promise<boolean> }) {
  const [m, setM] = useState(String(prices.mensual || ""));
  const [t, setT] = useState(String(prices.temporada || ""));
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="Precios de los planes">
      <p className="mb-3 text-sm text-muted">Son los precios que se proponen al habilitar un cliente nuevo. Cambiarlos no modifica lo que ya paga cada balneario.</p>
      <div className="grid grid-cols-2 gap-2">
        <TextField label="Mensual" inputMode="decimal" value={m} onChange={(e) => setM(e.target.value)} />
        <TextField label="Temporada" inputMode="decimal" value={t} onChange={(e) => setT(e.target.value)} />
      </div>
      {err && <Alert tone="danger" className="mt-2">{err}</Alert>}
      <Button className="mt-3" loading={busy} onClick={() => {
        const a = parseMoney(m); const b = parseMoney(t);
        if (a == null || b == null || a < 0 || b < 0) return setErr("Poné los dos precios.");
        setErr(null); onSave(a, b);
      }}>Guardar precios</Button>
    </Card>
  );
}

function PlanModal({ b, prices, busy, onClose, onSave }: {
  b: Balneario; prices: Overview["precios"]; busy: boolean; onClose: () => void; onSave: (plan: PlanKind, price: number, exempt: boolean) => void;
}) {
  const [plan, setPlan] = useState<PlanKind>(b.plan?.plan ?? "temporada");
  const [price, setPrice] = useState(String(b.plan?.precio ?? (prices.temporada || "")));
  const [exempt, setExempt] = useState(b.plan?.estado === "exenta");
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} busy={busy} title={`Plan de ${b.nombre}`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button loading={busy} onClick={() => {
        const p = parseMoney(price);
        if (p == null || p < 0) return setErr("Poné el precio.");
        onSave(plan, p, exempt);
      }}>Guardar</Button></>}>
      <PlanFields plan={plan} setPlan={setPlan} price={price} setPrice={setPrice} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={exempt} onChange={(e) => setExempt(e.target.checked)} /> Sin vencimiento (no paga, por ejemplo el tuyo)</label>
      {b.plan?.debito && <p className="text-xs text-muted">Tiene débito automático activo: el precio nuevo se cobra recién cuando vuelva a activar el débito. Mercado Pago sigue cobrando el importe que autorizó.</p>}
      {!b.plan && <p className="text-xs text-muted">Arranca con vencimiento hoy: tiene los días de gracia para activar el débito o para que registres su pago.</p>}
      {err && <Alert tone="danger">{err}</Alert>}
    </Modal>
  );
}

function PaymentModal({ b, busy, onClose, onSave }: { b: Balneario; busy: boolean; onClose: () => void; onSave: (amount: number, until: string | null, note: string) => void }) {
  const [amount, setAmount] = useState(String(b.plan?.precio ?? ""));
  const [until, setUntil] = useState("");
  const [note, setNote] = useState("Transferencia");
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} busy={busy} title={`Registrar pago · ${b.nombre}`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button loading={busy} onClick={() => {
        const a = parseMoney(amount);
        if (a == null || a < 0) return setErr("Poné el importe.");
        onSave(a, until || null, note.trim());
      }}>Registrar</Button></>}>
      <p className="text-sm text-muted">Para pagos por fuera de Mercado Pago (transferencia, efectivo). {b.plan?.plan === "mensual" ? "Suma un mes" : "Cubre la temporada (hasta el 31/3)"}, salvo que elijas otra fecha.</p>
      <TextField label="Importe" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <TextField label="Pago hasta (opcional)" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
      <TextField label="Nota" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      {err && <Alert tone="danger">{err}</Alert>}
    </Modal>
  );
}

function PauseModal({ b, busy, onClose, onConfirm }: { b: Balneario; busy: boolean; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Modal open onClose={onClose} busy={busy} title={`Pausar ${b.nombre}`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>Pausar</Button></>}>
      <p className="text-sm text-muted">Van a poder seguir entrando, ver y descargar sus datos, pero no cargar reservas, cobros ni cambios hasta que lo reactives. No se borra nada.</p>
      <TextField label="Motivo (lo ven ellos)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Ej: Falta el pago de noviembre" />
    </Modal>
  );
}

function LimitsModal({ b, busy, onClose, onSave }: { b: Balneario; busy: boolean; onClose: () => void; onSave: (t: number | null, u: number | null) => void }) {
  const [t, setT] = useState(b.max_carpas != null ? String(b.max_carpas) : "");
  const [u, setU] = useState(b.max_sombrillas != null ? String(b.max_sombrillas) : "");
  const [err, setErr] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const tn = t.trim() === "" ? null : Number(t);
    const un = u.trim() === "" ? null : Number(u);
    if ((tn != null && (!Number.isInteger(tn) || tn < 0)) || (un != null && (!Number.isInteger(un) || un < 0))) return setErr("Poné números enteros (o dejalo vacío para sin límite).");
    setErr(null);
    onSave(tn, un);
  }
  return (
    <Modal open onClose={onClose} title={`Cantidad contratada · ${b.nombre}`} busy={busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-muted">Hoy tiene activas {b.carpas} carpas y {b.sombrillas} sombrillas. El balneario puede desactivar las que quiera, pero no tener más activas que este máximo.</p>
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Máximo de carpas" type="number" inputMode="numeric" min={0} value={t} onChange={(e) => setT(e.target.value)} placeholder="sin límite" />
          <TextField label="Máximo de sombrillas" type="number" inputMode="numeric" min={0} value={u} onChange={(e) => setU(e.target.value)} placeholder="sin límite" />
        </div>
        {((t !== "" && Number(t) < b.carpas) || (u !== "" && Number(u) < b.sombrillas)) && (
          <Alert tone="warn">Es menos de lo que tiene activo hoy: no se le desactiva nada, pero no va a poder activar ni agregar hasta quedar por debajo.</Alert>
        )}
        {err && <Alert tone="danger">{err}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button type="submit" loading={busy}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Ficha de un balneario: todo a la vista en filas con su nombre, y las acciones abajo. */
/** Eliminar un balneario con todos sus datos: hay que escribir su nombre para confirmar. */
function DeleteModal({ b, busy, onClose, onConfirm }: { b: Balneario; busy: boolean; onClose: () => void; onConfirm: (name: string) => void }) {
  const [name, setName] = useState("");
  const ok = name.trim() === b.nombre.trim();
  return (
    <Modal open onClose={onClose} busy={busy} title={`Eliminar ${b.nombre}`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button variant="danger" loading={busy} disabled={!ok} onClick={() => onConfirm(name)}>Eliminar para siempre</Button></>}>
      <Alert tone="danger">
        Se borran el balneario, sus usuarios, clientes, reservas, pagos, caja y todo su historial. Ellos dejan de poder entrar.
        {b.pausado ? "" : " Si solo querés frenarlo (por ejemplo, por falta de pago), usá «Pausar»: se puede reactivar."}
      </Alert>
      <p className="text-sm text-muted">Se guarda una copia completa en la base por si hay que recuperarlo.</p>
      <TextField label={`Para confirmar, escribí: ${b.nombre}`} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
    </Modal>
  );
}

function BalnearioCard({ b, hoy, mine, onPlan, onPay, onLimits, onPause, onResume, onDelete }: {
  b: Balneario; hoy: string; mine: boolean; onPlan: () => void; onPay: () => void; onLimits: () => void; onPause: () => void; onResume: () => void; onDelete: () => void;
}) {
  const p = b.plan;
  const ago = daysAgo(b.ultimo_uso);
  const used = b.ultimo_uso ? (ago === 0 ? "Hoy" : ago === 1 ? "Ayer" : `Hace ${ago} días`) : "Nunca";
  const Row = ({ k, children }: { k: string; children: ReactNode }) => (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-xs text-muted">{k}</dt>
      <dd className="min-w-0 text-right text-sm">{children}</dd>
    </div>
  );
  const bar = (n: number, max: number | null | undefined) => max ? (
    <span className="ml-2 inline-block h-1.5 w-16 overflow-hidden rounded-full bg-surface-2 align-middle">
      <span className={n >= max ? "block h-full bg-warn" : "block h-full bg-accent"} style={{ width: `${Math.min(100, (n / max) * 100)}%` }} />
    </span>
  ) : null;
  return (
    <div className={cx("flex flex-col rounded-2xl border bg-surface p-4", b.pausado ? "border-danger/40" : needsAttention(b, hoy) ? "border-warn/50" : "border-line")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold" title={b.nombre}>{b.nombre}</h3>
          <p className="truncate text-xs text-muted" title={b.propietario ?? ""}>{b.propietario ?? "Sin propietario"}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {planBadge(p, hoy)}
          {mine && <Badge tone="info">El tuyo</Badge>}
          {b.pausado && <Badge tone="danger">En pausa</Badge>}
        </div>
      </div>
      {b.pausado && b.motivo_pausa && <p className="mt-2 rounded-lg bg-danger-soft px-2 py-1 text-xs">{b.motivo_pausa}</p>}
      <dl className="mt-3 divide-y divide-line border-y border-line">
        <Row k="Plan">{p && p.estado !== "exenta" ? <>{PLAN_LABEL[p.plan]} · <b className="tabular">{formatMoney(p.precio)}</b></> : p ? "Sin vencimiento" : "—"}</Row>
        {p && p.estado !== "exenta" && (
          <Row k={p.debito ? "Próximo débito" : "Pagado hasta"}>
            <span className="tabular">{formatDate(p.debito && p.proximo_debito ? p.proximo_debito : p.pago_hasta)}</span>
          </Row>
        )}
        <Row k="Carpas">
          <button type="button" onClick={onLimits} className="tabular hover:underline" title="Cambiar la cantidad contratada">
            {b.carpas}{b.max_carpas != null ? ` de ${b.max_carpas}` : ""}
          </button>{bar(b.carpas, b.max_carpas)}
        </Row>
        <Row k="Sombrillas">
          <button type="button" onClick={onLimits} className="tabular hover:underline" title="Cambiar la cantidad contratada">
            {b.sombrillas}{b.max_sombrillas != null ? ` de ${b.max_sombrillas}` : ""}
          </button>{bar(b.sombrillas, b.max_sombrillas)}
        </Row>
        <Row k="Reservas"><span className="tabular">{b.reservas}</span> <span className="text-xs text-muted">({b.reservas_30d} en 30 días)</span></Row>
        <Row k="Último uso"><span title={b.ultimo_uso ? formatDateTime(b.ultimo_uso) : undefined}>{used}</span></Row>
        <Row k="Usuarios · alta"><span className="tabular">{b.usuarios}</span> · {formatDate(b.creado.slice(0, 10))}</Row>
      </dl>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={onPlan}>{p ? "Cambiar plan" : "Asignar plan"}</Button>
        {p && p.estado !== "exenta" ? <Button variant="secondary" onClick={onPay}>Registrar pago</Button> : <Button variant="secondary" onClick={onLimits}>Cantidad de carpas</Button>}
        {p && p.estado !== "exenta" && <Button variant="ghost" onClick={onLimits}>Cantidad de carpas</Button>}
        {!mine && (b.pausado
          ? <Button variant="primary" onClick={onResume}>Reactivar</Button>
          : <Button variant="ghost" className="text-danger" onClick={onPause}>Pausar</Button>)}
        {!mine && <Button variant="ghost" className="text-danger" onClick={onDelete}>Eliminar</Button>}
      </div>
    </div>
  );
}
