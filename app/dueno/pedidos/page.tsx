"use client";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { SyncNotice } from "@/components/shell";
import { Alert, Button, EmptyState, Field, Input, Modal, Select, Spinner, TextField, Textarea, cx } from "@/components/ui";

type Estado = "pendiente" | "en_curso" | "hecho" | "descartado";
type Voto = { id: string; balneario_id: string | null; quien: string | null; nota: string | null; fecha: string };
type Pedido = { id: string; titulo: string; detalle: string | null; estado: Estado; creado: string; hecho: string | null; votos: Voto[] };
const ESTADOS: Record<Estado, { label: string; cls: string }> = {
  pendiente: { label: "Pendiente", cls: "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100" },
  en_curso: { label: "Lo estoy haciendo", cls: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100" },
  hecho: { label: "Hecho", cls: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100" },
  descartado: { label: "Descartado", cls: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300" },
};

/** Lo que piden los clientes, quién lo pidió y cuántos: para decidir qué hacer primero. */
export default function OwnerRequests() {
  const sb = getSupabase();
  const q = useLoader(async () => unwrap(await sb.rpc("admin_requests")) as Pedido[], [], 120_000);
  const bal = useLoader(async () => ((unwrap(await sb.rpc("admin_overview")) as { balnearios: { id: string; nombre: string }[] }).balnearios), [], 600_000);
  const [edit, setEdit] = useState<Pedido | "nuevo" | null>(null);
  const [voteFor, setVoteFor] = useState<Pedido | null>(null);
  const [show, setShow] = useState<"abiertos" | "todos">("abiertos");
  const [msg, setMsg] = useState<string | null>(null);
  const list = (q.data ?? []).filter((p) => show === "todos" || p.estado === "pendiente" || p.estado === "en_curso");
  const max = Math.max(1, ...(q.data ?? []).map((p) => p.votos.length));

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pedidos</h1>
          <p className="text-sm text-muted">Lo que te piden los balnearios (y los interesados). Arriba, lo que más gente pide.</p>
        </div>
        <Button onClick={() => setEdit("nuevo")}>Nuevo pedido</Button>
      </div>
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {q.error && /admin_requests|schema cache|function/i.test(q.error) && !q.data && <Alert tone="warn">Falta correr la actualización 0057 en Supabase.</Alert>}
      {msg && <Alert tone="danger" className="mb-3">{msg}</Alert>}
      <div className="mb-3 flex gap-2">
        {(["abiertos", "todos"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setShow(k)}
            className={show === k ? "rounded-full border border-accent bg-accent-soft px-3 py-1 text-sm font-semibold text-accent" : "rounded-full border border-line px-3 py-1 text-sm hover:bg-surface-2"}>
            {k === "abiertos" ? "Pendientes y en curso" : "Todos"}
          </button>
        ))}
      </div>
      {!q.data ? (q.loading && <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando…</div>) : list.length === 0 ? <EmptyState>No hay pedidos{show === "abiertos" ? " pendientes" : ""}.</EmptyState> : (
        <ul className="flex flex-col gap-3">
          {list.map((p) => (
            <li key={p.id} className={cx("flex gap-4 rounded-2xl border border-line bg-surface p-4", (p.estado === "hecho" || p.estado === "descartado") && "opacity-70")}>
              <div className="flex w-16 shrink-0 flex-col items-center justify-center rounded-xl bg-accent-soft py-2 text-accent">
                <span className="text-2xl font-extrabold tabular leading-none">{p.votos.length}</span>
                <span className="text-[10px] font-medium">{p.votos.length === 1 ? "lo pidió" : "lo pidieron"}</span>
                <span className="mt-1 h-1 w-10 overflow-hidden rounded-full bg-white/60 dark:bg-black/30"><span className="block h-full bg-accent" style={{ width: `${(p.votos.length / max) * 100}%` }} /></span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">{p.titulo}</h2>
                  <span className={cx("rounded-full px-2.5 py-0.5 text-xs font-semibold", ESTADOS[p.estado].cls)}>{ESTADOS[p.estado].label}</span>
                </div>
                {p.detalle && <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted">{p.detalle}</p>}
                {p.votos.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.votos.map((v) => (
                      <span key={v.id} title={`${formatDate(v.fecha.slice(0, 10))}${v.nota ? ` · ${v.nota}` : ""}`} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-0.5 text-xs">
                        {v.quien ?? "—"}
                        <button type="button" aria-label={`Quitar a ${v.quien}`} className="text-muted hover:text-danger" onClick={async () => {
                          const { error } = await sb.rpc("admin_delete_vote", { p_id: v.id });
                          if (error) setMsg(friendlyError(error)); else q.reload();
                        }}>×</button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => setVoteFor(p)}>+ Alguien más lo pide</Button>
                  <Button variant="ghost" onClick={() => setEdit(p)}>Editar</Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {edit && <RequestModal p={edit === "nuevo" ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); q.reload(); }} />}
      {voteFor && <VoteModal p={voteFor} balnearios={bal.data ?? []} onClose={() => setVoteFor(null)} onSaved={() => { setVoteFor(null); q.reload(); }} />}
    </>
  );
}

function RequestModal({ p, onClose, onSaved }: { p: Pedido | null; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(p?.titulo ?? "");
  const [detail, setDetail] = useState(p?.detalle ?? "");
  const [status, setStatus] = useState<Estado>(p?.estado ?? "pendiente");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open title={p ? "Editar pedido" : "Nuevo pedido"} onClose={onClose} busy={busy}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button loading={busy} onClick={async () => {
        setBusy(true);
        const { error } = await getSupabase().rpc("admin_save_request", { p_id: p?.id ?? null, p_title: title, p_detail: detail, p_status: status });
        setBusy(false);
        if (error) return setErr(friendlyError(error));
        onSaved();
      }}>Guardar</Button></>}>
      <div className="flex flex-col gap-3">
        <TextField label="Qué piden" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} placeholder="Ej.: Lista de espera cuando no hay carpas" />
        <Field label="Detalle (opcional)" htmlFor="ped-det"><Textarea id="ped-det" rows={4} value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={2000} /></Field>
        <Field label="Estado" htmlFor="ped-est"><Select id="ped-est" value={status} onChange={(e) => setStatus(e.target.value as Estado)}>{(Object.keys(ESTADOS) as Estado[]).map((k) => <option key={k} value={k}>{ESTADOS[k].label}</option>)}</Select></Field>
        {!p && <p className="text-xs text-muted">Después de guardarlo, con «+ Alguien más lo pide» anotás quién lo pidió.</p>}
        {err && <p className="text-sm text-danger">{err}</p>}
      </div>
    </Modal>
  );
}

function VoteModal({ p, balnearios, onClose, onSaved }: { p: Pedido; balnearios: { id: string; nombre: string }[]; onClose: () => void; onSaved: () => void }) {
  const [ws, setWs] = useState("");
  const [who, setWho] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const taken = new Set(p.votos.map((v) => v.balneario_id));
  return (
    <Modal open title={`¿Quién pide «${p.titulo}»?`} onClose={onClose} busy={busy}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button loading={busy} onClick={async () => {
        setBusy(true);
        const { error } = await getSupabase().rpc("admin_vote_request", { p_request_id: p.id, p_workspace_id: ws || null, p_who: ws ? null : who, p_note: note || null });
        setBusy(false);
        if (error) return setErr(friendlyError(error));
        onSaved();
      }}>Agregar</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Balneario cliente" htmlFor="voto-ws">
          <Select id="voto-ws" value={ws} onChange={(e) => setWs(e.target.value)}>
            <option value="">— Otro (escribilo abajo) —</option>
            {balnearios.filter((b) => !taken.has(b.id)).map((b) => <option key={b.id} value={b.id}>{b.nombre}</option>)}
          </Select>
        </Field>
        {!ws && <TextField label="Quién (un interesado, otro balneario…)" value={who} onChange={(e) => setWho(e.target.value)} maxLength={100} />}
        <Field label="Nota (opcional)" htmlFor="voto-nota"><Input id="voto-nota" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Ej.: lo pidió por WhatsApp el 12/11" /></Field>
        {err && <p className="text-sm text-danger">{err}</p>}
      </div>
    </Modal>
  );
}
