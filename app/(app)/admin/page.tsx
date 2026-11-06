"use client";
import { useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatDateTime } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Modal, Spinner, TextField } from "@/components/ui";

/** Panel del dueño de Mi Balneario: todos los balnearios, quién puede darse de alta y pausas. */

type Balneario = {
  id: string; nombre: string; creado: string; pausado: string | null; motivo_pausa: string | null; propietario: string | null;
  usuarios: number; carpas: number; sombrillas: number; reservas: number; reservas_30d: number; ultimo_uso: string | null;
};
type Habilitacion = { correo: string; nota: string | null; creado: string; usado: string | null; balneario: string | null };
type Overview = { balnearios: Balneario[]; habilitaciones: Habilitacion[]; demos_abiertas: number };

const daysAgo = (ts: string | null) => (ts ? Math.floor((Date.now() - new Date(ts).getTime()) / 86_400_000) : null);

export default function AdminPage() {
  const { isPlatformAdmin, ws } = useWorkspace();
  const sb = getSupabase();
  const q = useLoader(async () => unwrap(await sb.rpc("admin_overview")) as Overview, [], 60_000);
  const [pausing, setPausing] = useState<Balneario | null>(null);
  const [resuming, setResuming] = useState<Balneario | null>(null);
  const [revoking, setRevoking] = useState<Habilitacion | null>(null);
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

  return (
    <>
      <PageHeader title="Panel del dueño" subtitle="Todos los balnearios que usan Mi Balneario, las altas habilitadas y las pausas." />
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {msg && <Alert tone={msg.tone} className="mb-3">{msg.text}</Alert>}
      {!d ? (q.loading && <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando…</div>) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="Balnearios" value={d.balnearios.length} note={`${d.balnearios.length - activos.length} en pausa`} />
            <Kpi label="Usados esta semana" value={usados7} note="con algún cambio en 7 días" />
            <Kpi label="Altas sin usar" value={d.habilitaciones.filter((h) => !h.usado).length} note="correos habilitados que todavía no crearon su balneario" />
            <Kpi label="Demos abiertas ahora" value={d.demos_abiertas} note="se borran solas" />
          </div>

          <Card title="Balnearios">
            {d.balnearios.length === 0 ? <EmptyState>Todavía no hay balnearios.</EmptyState> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      <th className="py-2 font-medium">Balneario</th>
                      <th className="py-2 font-medium">Propietario</th>
                      <th className="py-2 text-right font-medium">Espacios</th>
                      <th className="py-2 text-right font-medium">Usuarios</th>
                      <th className="py-2 text-right font-medium">Reservas</th>
                      <th className="py-2 font-medium">Último uso</th>
                      <th className="py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {d.balnearios.map((b) => {
                      const ago = daysAgo(b.ultimo_uso);
                      return (
                        <tr key={b.id}>
                          <td className="py-2">
                            <div className="font-medium">{b.nombre} {b.id === ws.id && <Badge tone="muted">el tuyo</Badge>}</div>
                            <div className="text-xs text-muted">Desde {formatDate(b.creado.slice(0, 10))}</div>
                            {b.pausado && <div className="mt-0.5"><Badge tone="danger">En pausa</Badge> <span className="text-xs text-muted">{b.motivo_pausa}</span></div>}
                          </td>
                          <td className="py-2 text-xs">{b.propietario ?? "—"}</td>
                          <td className="py-2 text-right tabular">{b.carpas} + {b.sombrillas}</td>
                          <td className="py-2 text-right tabular">{b.usuarios}</td>
                          <td className="py-2 text-right tabular">{b.reservas}<div className="text-xs text-muted">{b.reservas_30d} en 30 días</div></td>
                          <td className="py-2 text-xs">{b.ultimo_uso ? <>{ago === 0 ? "Hoy" : ago === 1 ? "Ayer" : `Hace ${ago} días`}<div className="text-muted">{formatDateTime(b.ultimo_uso)}</div></> : "Nunca"}</td>
                          <td className="py-2 text-right">
                            {b.id !== ws.id && (b.pausado
                              ? <Button variant="secondary" onClick={() => setResuming(b)}>Reactivar</Button>
                              : <Button variant="ghost" onClick={() => setPausing(b)}>Pausar</Button>)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs text-muted">Un balneario en pausa sigue viendo y descargando sus datos, pero no puede cargar nada nuevo. No se borra nada.</p>
          </Card>

          <SignupsCard rows={d.habilitaciones} busy={busy}
            onAdd={(email, note) => run(() => sb.rpc("admin_allow_signup", { p_email: email, p_note: note || null }), `Listo: ${email} ya puede crear su balneario (con usuario o con Google).`)}
            onRevoke={setRevoking} />
        </div>
      )}

      {pausing && <PauseModal b={pausing} busy={busy} onClose={() => setPausing(null)}
        onConfirm={async (reason) => { if (await run(() => sb.rpc("admin_set_paused", { p_workspace_id: pausing.id, p_paused: true, p_reason: reason }), `${pausing.nombre} quedó en pausa.`)) setPausing(null); }} />}
      <ConfirmDialog open={!!resuming} title="Reactivar balneario" confirmLabel="Reactivar" busy={busy}
        message={<>¿Reactivar <strong>{resuming?.nombre}</strong>? Vuelve a poder cargar reservas, cobros y todo lo demás.</>}
        onCancel={() => setResuming(null)}
        onConfirm={async () => { if (resuming && await run(() => sb.rpc("admin_set_paused", { p_workspace_id: resuming.id, p_paused: false, p_reason: null }), `${resuming.nombre} está activo de nuevo.`)) setResuming(null); }} />
      <ConfirmDialog open={!!revoking} title="Quitar habilitación" confirmLabel="Quitar" danger busy={busy}
        message={<>¿Quitar la habilitación de <strong>{revoking?.correo}</strong>? Ya no va a poder crear su balneario.</>}
        onCancel={() => setRevoking(null)}
        onConfirm={async () => { if (revoking && await run(() => sb.rpc("admin_revoke_signup", { p_email: revoking.correo }), "Habilitación quitada.")) setRevoking(null); }} />
    </>
  );
}

function Kpi({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="text-2xl font-bold tabular">{value}</div>
      <div className="text-xs text-muted">{note}</div>
    </div>
  );
}

function SignupsCard({ rows, busy, onAdd, onRevoke }: {
  rows: Habilitacion[]; busy: boolean; onAdd: (email: string, note: string) => Promise<boolean>; onRevoke: (h: Habilitacion) => void;
}) {
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await onAdd(email.trim().toLowerCase(), note.trim())) { setEmail(""); setNote(""); }
  }
  return (
    <Card title="Altas habilitadas">
      <p className="mb-3 text-sm text-muted">Cuando alguien contrata, poné acá su correo (el de Google o el que va a usar). Solo esas cuentas pueden crear un balneario; el resto ve los planes.</p>
      <form onSubmit={submit} className="mb-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <TextField label="Correo" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cliente@gmail.com" />
        <TextField label="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Ej: Balneario La Ola, plan anual" />
        <Button type="submit" loading={busy}>Habilitar</Button>
      </form>
      {rows.length === 0 ? <EmptyState>No hay correos habilitados.</EmptyState> : (
        <ul className="divide-y divide-line text-sm">
          {rows.map((h) => (
            <li key={h.correo} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="truncate font-medium">{h.correo}</div>
                <div className="text-xs text-muted">{h.nota ? `${h.nota} · ` : ""}habilitado el {formatDate(h.creado.slice(0, 10))}</div>
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
