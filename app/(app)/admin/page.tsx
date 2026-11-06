"use client";
import { useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatDateTime, formatMoney, parseMoney } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Modal, Select, Spinner, TextField } from "@/components/ui";

/** Panel del dueño de Mi Balneario: balnearios, planes y cobros, altas habilitadas y pausas. */

type PlanKind = "mensual" | "temporada";
type PlanInfo = {
  plan: PlanKind; precio: number; estado: string; pago_hasta: string | null; vencido: boolean; debito: boolean;
  proximo_debito: string | null; ultimo_estado: "aprobado" | "rechazado" | null; ultimo_pago: string | null;
};
type Balneario = {
  id: string; nombre: string; creado: string; pausado: string | null; motivo_pausa: string | null; propietario: string | null;
  usuarios: number; carpas: number; sombrillas: number; reservas: number; reservas_30d: number; ultimo_uso: string | null;
  plan: PlanInfo | null;
};
type Habilitacion = { correo: string; nota: string | null; creado: string; usado: string | null; balneario: string | null; plan: PlanKind | null; precio: number | null };
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

export default function AdminPage() {
  const { isPlatformAdmin, ws } = useWorkspace();
  const sb = getSupabase();
  const q = useLoader(async () => unwrap(await sb.rpc("admin_overview")) as Overview, [], 60_000);
  const [pausing, setPausing] = useState<Balneario | null>(null);
  const [resuming, setResuming] = useState<Balneario | null>(null);
  const [revoking, setRevoking] = useState<Habilitacion | null>(null);
  const [planFor, setPlanFor] = useState<Balneario | null>(null);
  const [payFor, setPayFor] = useState<Balneario | null>(null);
  const [busy, setBusy] = useState(false);
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

          <Card title="Balnearios">
            {d.balnearios.length === 0 ? <EmptyState>Todavía no hay balnearios.</EmptyState> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      <th className="py-2 font-medium">Balneario</th>
                      <th className="py-2 font-medium">Plan</th>
                      <th className="py-2 text-right font-medium">Espacios</th>
                      <th className="py-2 text-right font-medium">Reservas</th>
                      <th className="py-2 font-medium">Último uso</th>
                      <th className="py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {d.balnearios.map((b) => {
                      const ago = daysAgo(b.ultimo_uso);
                      const p = b.plan;
                      return (
                        <tr key={b.id} className="align-top">
                          <td className="py-2">
                            <div className="font-medium">{b.nombre} {b.id === ws.id && <Badge tone="info">el tuyo</Badge>}</div>
                            <div className="text-xs text-muted">{b.propietario ?? "—"} · desde {formatDate(b.creado.slice(0, 10))} · {b.usuarios} usuario{b.usuarios === 1 ? "" : "s"}</div>
                            {b.pausado && <div className="mt-0.5"><Badge tone="danger">En pausa</Badge> <span className="text-xs text-muted">{b.motivo_pausa}</span></div>}
                          </td>
                          <td className="py-2">
                            {planBadge(p, d.hoy)}
                            {p && p.estado !== "exenta" && (
                              <div className="mt-0.5 text-xs text-muted">
                                {PLAN_LABEL[p.plan]} · {formatMoney(p.precio)}<br />
                                {p.debito && p.proximo_debito ? `Próximo débito ${formatDate(p.proximo_debito)} · ` : ""}pago hasta {formatDate(p.pago_hasta)}
                              </div>
                            )}
                          </td>
                          <td className="py-2 text-right tabular">{b.carpas} + {b.sombrillas}</td>
                          <td className="py-2 text-right tabular">{b.reservas}<div className="text-xs text-muted">{b.reservas_30d} en 30 días</div></td>
                          <td className="py-2 text-xs">{b.ultimo_uso ? <>{ago === 0 ? "Hoy" : ago === 1 ? "Ayer" : `Hace ${ago} días`}<div className="text-muted">{formatDateTime(b.ultimo_uso)}</div></> : "Nunca"}</td>
                          <td className="py-2">
                            <div className="flex flex-wrap justify-end gap-1">
                              <Button variant="ghost" onClick={() => setPlanFor(b)}>{p ? "Cambiar plan" : "Asignar plan"}</Button>
                              {p && p.estado !== "exenta" && <Button variant="ghost" onClick={() => setPayFor(b)}>Registrar pago</Button>}
                              {b.id !== ws.id && (b.pausado
                                ? <Button variant="secondary" onClick={() => setResuming(b)}>Reactivar</Button>
                                : <Button variant="ghost" onClick={() => setPausing(b)}>Pausar</Button>)}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs text-muted">
              Con el plan vencido (o en pausa) el balneario ve y descarga sus datos, pero no carga nada nuevo; no se borra nada.
              Hay {d.precios.dias_gracia} días de gracia después del vencimiento. Demos abiertas ahora: {d.demos_abiertas}.
            </p>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <SignupsCard rows={d.habilitaciones} busy={busy} prices={d.precios}
              onAdd={(email, note, plan, price) => run(() => sb.rpc("admin_allow_signup", { p_email: email, p_note: note || null, p_plan: plan, p_price: price }),
                `Listo: ${email} ya puede crear su balneario (con usuario o con Google).`)}
              onRevoke={setRevoking} />
            <PricesCard prices={d.precios} busy={busy}
              onSave={(m, t) => run(() => sb.rpc("admin_set_prices", { p_mensual: m, p_temporada: t }), "Precios guardados. Se usan para los clientes nuevos.")} />
          </div>
        </div>
      )}

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

function SignupsCard({ rows, busy, prices, onAdd, onRevoke }: {
  rows: Habilitacion[]; busy: boolean; prices: Overview["precios"];
  onAdd: (email: string, note: string, plan: PlanKind, price: number) => Promise<boolean>; onRevoke: (h: Habilitacion) => void;
}) {
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [plan, setPlan] = useState<PlanKind>("temporada");
  const [price, setPrice] = useState(String(prices.temporada || ""));
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = parseMoney(price);
    if (p == null || p < 0) return setErr("Poné el precio del plan.");
    setErr(null);
    if (await onAdd(email.trim().toLowerCase(), note.trim(), plan, p)) { setEmail(""); setNote(""); }
  }
  return (
    <Card title="Altas habilitadas">
      <p className="mb-3 text-sm text-muted">Cuando alguien contrata, poné su correo (el de Google o el que va a usar) y su plan. Solo esas cuentas pueden crear un balneario. Al crearlo tiene {prices.dias_gracia} días para activar el débito.</p>
      <form onSubmit={submit} className="mb-4 flex flex-col gap-2">
        <TextField label="Correo" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cliente@gmail.com" />
        <PlanFields plan={plan} setPlan={(v) => { setPlan(v); setPrice(String((v === "mensual" ? prices.mensual : prices.temporada) || "")); }} price={price} setPrice={setPrice} />
        <TextField label="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Ej: Balneario La Ola" />
        {err && <Alert tone="danger">{err}</Alert>}
        <Button type="submit" loading={busy}>Habilitar</Button>
      </form>
      {rows.length === 0 ? <EmptyState>No hay correos habilitados.</EmptyState> : (
        <ul className="divide-y divide-line text-sm">
          {rows.map((h) => (
            <li key={h.correo} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="truncate font-medium">{h.correo}</div>
                <div className="text-xs text-muted">
                  {h.plan ? `${PLAN_LABEL[h.plan]}${h.precio != null ? ` ${formatMoney(h.precio)}` : ""} · ` : ""}{h.nota ? `${h.nota} · ` : ""}habilitado el {formatDate(h.creado.slice(0, 10))}
                </div>
              </div>
              {h.usado
                ? <Badge tone="ok">Creó {h.balneario ?? "su balneario"}</Badge>
                : <span className="flex items-center gap-2"><Badge tone="warn">Sin usar</Badge><Button variant="ghost" onClick={() => onRevoke(h)}>Quitar</Button></span>}
            </li>
          ))}
        </ul>
      )}
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
