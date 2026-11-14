"use client";
import { useState, type DragEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDate, todayISO } from "@/lib/format";
import { SyncNotice } from "@/components/shell";
import { Alert, Button, Field, Modal, Select, Spinner, TextField, Textarea, cx } from "@/components/ui";

type Tipo = "post" | "carrusel" | "reel" | "historia";
type Estado = "idea" | "preparando" | "listo" | "publicado";
type Pub = { id: string; titulo: string; tipo: Tipo; estado: Estado; fecha: string | null; descripcion: string | null; hashtags: string | null; notas: string | null; version: number };

const TIPO: Record<Tipo, { label: string; cls: string; dot: string }> = {
  post: { label: "Post", cls: "bg-sky-100 text-sky-900 dark:bg-sky-900/50 dark:text-sky-100", dot: "bg-sky-500" },
  carrusel: { label: "Carrusel", cls: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100", dot: "bg-amber-500" },
  reel: { label: "Reel", cls: "bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-900/50 dark:text-fuchsia-100", dot: "bg-fuchsia-500" },
  historia: { label: "Historia", cls: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100", dot: "bg-emerald-500" },
};
const ESTADO: Record<Estado, string> = { idea: "Idea", preparando: "Preparando", listo: "Listo para subir", publicado: "Publicado" };
const DIAS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Calendario de publicaciones de Instagram: banco de ideas, fechas, descripciones y hashtags. */
export default function OwnerInstagram() {
  const sb = getSupabase();
  const q = useLoader(async () => unwrap(await sb.rpc("admin_ig_posts")) as Pub[], [], 120_000);
  const hoy = todayISO();
  const [month, setMonth] = useState(hoy.slice(0, 7));
  const [edit, setEdit] = useState<Pub | { fecha: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const posts = q.data ?? [];
  const ideas = posts.filter((p) => !p.fecha);
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const start = new Date(first); start.setUTCDate(1 - ((first.getUTCDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setUTCDate(start.getUTCDate() + i); return iso(d); });
  const weeks = days.slice(35).every((d) => d.slice(0, 7) !== month) ? days.slice(0, 35) : days;
  const byDay = (d: string) => posts.filter((p) => p.fecha === d);
  const shift = (n: number) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); setMonth(iso(d).slice(0, 7)); };
  const inMonth = posts.filter((p) => p.fecha?.startsWith(month));
  const next = posts.filter((p) => p.fecha && p.fecha >= hoy && p.estado !== "publicado").slice(0, 6);

  async function move(id: string, fecha: string | null) {
    const { error } = await sb.rpc("admin_move_ig_post", { p_id: id, p_date: fecha, p_status: null });
    if (error) setErr(friendlyError(error)); else q.reload();
  }
  const drop = (fecha: string | null) => (e: DragEvent) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/plain"); if (id) move(id, fecha); };
  const dragOver = (k: string) => (e: DragEvent) => { e.preventDefault(); setOver(k); };
  const Chip = ({ p }: { p: Pub }) => (
    <button type="button" draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", p.id)} onClick={(e) => { e.stopPropagation(); setEdit(p); }}
      title={`${TIPO[p.tipo].label} · ${ESTADO[p.estado]}`}
      className={cx("flex w-full cursor-grab items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-left text-[11px] font-medium", TIPO[p.tipo].cls, p.estado === "publicado" && "opacity-55 line-through")}>
      {p.estado === "listo" && <span aria-hidden>✓</span>}<span className="truncate">{p.titulo}</span>
    </button>
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Instagram</h1>
          <p className="text-sm text-muted">Tus ideas, cuándo publicarlas y la descripción lista para copiar. Arrastrá una idea a un día para agendarla.</p>
        </div>
        <Button onClick={() => setEdit({ fecha: null })}>Nueva idea</Button>
      </div>
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {q.error && /admin_ig|schema cache|function/i.test(q.error) && !q.data && <Alert tone="warn">Falta correr la actualización 0058 en Supabase.</Alert>}
      {err && <Alert tone="danger" className="mb-3">{err}</Alert>}
      {!q.data ? (q.loading && <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando…</div>) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
          <section className="rounded-2xl border border-line bg-surface p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <button type="button" onClick={() => shift(-1)} className="rounded-lg px-3 py-1 text-lg hover:bg-surface-2" aria-label="Mes anterior">‹</button>
              <div className="text-center">
                <div className="font-semibold">{MESES[m - 1]} {y}</div>
                <div className="text-xs text-muted">{inMonth.length} {inMonth.length === 1 ? "publicación" : "publicaciones"} · {inMonth.filter((p) => p.estado === "publicado").length} publicadas</div>
              </div>
              <button type="button" onClick={() => shift(1)} className="rounded-lg px-3 py-1 text-lg hover:bg-surface-2" aria-label="Mes siguiente">›</button>
            </div>
            <div className="overflow-x-auto">
              <div className="grid min-w-[560px] grid-cols-7 gap-1">
                {DIAS.map((d) => <div key={d} className="pb-1 text-center text-[11px] font-semibold uppercase text-muted">{d}</div>)}
                {weeks.map((d) => {
                  const list = byDay(d);
                  return (
                    <div key={d} role="button" tabIndex={0} onClick={() => setEdit({ fecha: d })} onKeyDown={(e) => { if (e.key === "Enter") setEdit({ fecha: d }); }}
                      onDragOver={dragOver(d)} onDragLeave={() => setOver(null)} onDrop={drop(d)}
                      className={cx("flex min-h-[86px] flex-col gap-0.5 rounded-lg border p-1 text-left transition-colors",
                        d.slice(0, 7) !== month ? "border-transparent bg-surface-2/40 opacity-50" : "border-line hover:bg-surface-2",
                        d === hoy && "ring-2 ring-accent/50", over === d && "bg-accent-soft")}>
                      <span className={cx("text-[11px] tabular", d === hoy ? "font-bold text-accent" : "text-muted")}>{Number(d.slice(8))}</span>
                      {list.slice(0, 3).map((p) => <Chip key={p.id} p={p} />)}
                      {list.length > 3 && <span className="text-[10px] text-muted">+{list.length - 3} más</span>}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted">
              {(Object.keys(TIPO) as Tipo[]).map((k) => <span key={k} className="flex items-center gap-1"><span className={cx("h-2 w-2 rounded-full", TIPO[k].dot)} />{TIPO[k].label}</span>)}
            </div>
          </section>
          <aside className="flex flex-col gap-4">
            <section onDragOver={dragOver("ideas")} onDragLeave={() => setOver(null)} onDrop={drop(null)}
              className={cx("rounded-2xl border border-dashed border-line bg-surface p-3", over === "ideas" && "bg-accent-soft")}>
              <h2 className="mb-2 text-sm font-semibold">Banco de ideas <span className="font-normal text-muted">({ideas.length})</span></h2>
              {ideas.length === 0 ? <p className="text-xs text-muted">Anotá acá lo que se te ocurra, sin fecha. Después lo arrastrás al calendario.</p> : (
                <div className="flex flex-col gap-1">{ideas.map((p) => <Chip key={p.id} p={p} />)}</div>
              )}
            </section>
            <section className="rounded-2xl border border-line bg-surface p-3">
              <h2 className="mb-2 text-sm font-semibold">Próximas</h2>
              {next.length === 0 ? <p className="text-xs text-muted">Nada agendado todavía.</p> : (
                <ul className="flex flex-col gap-1.5">
                  {next.map((p) => (
                    <li key={p.id}>
                      <button type="button" onClick={() => setEdit(p)} className="flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left text-sm hover:bg-surface-2">
                        <span className={cx("h-2 w-2 shrink-0 rounded-full", TIPO[p.tipo].dot)} />
                        <span className="w-12 shrink-0 text-xs tabular text-muted">{formatDate(p.fecha).slice(0, 5)}</span>
                        <span className="truncate">{p.titulo}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      )}
      {edit && <PostModal p={"id" in edit ? edit : null} fecha={edit.fecha} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); q.reload(); }} />}
    </>
  );
}

function PostModal({ p, fecha, onClose, onSaved }: { p: Pub | null; fecha: string | null; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({ titulo: p?.titulo ?? "", tipo: p?.tipo ?? "post", estado: p?.estado ?? (fecha ? "preparando" : "idea"), fecha: p?.fecha ?? fecha ?? "",
    descripcion: p?.descripcion ?? "", hashtags: p?.hashtags ?? "", notas: p?.notas ?? "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const f = (k: keyof typeof v) => ({ value: v[k], onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }) });
  const full = [v.descripcion.trim(), v.hashtags.trim()].filter(Boolean).join("\n\n");
  async function save() {
    if (v.titulo.trim().length < 2) return setErr("Poné la idea.");
    setBusy(true);
    const { error } = await getSupabase().rpc("admin_save_ig_post", { p_id: p?.id ?? null, p_version: p?.version ?? null, p: v });
    setBusy(false);
    if (error) return setErr(friendlyError(error));
    onSaved();
  }
  return (
    <Modal open wide title={p ? "Publicación" : fecha ? `Nueva publicación · ${formatDate(fecha)}` : "Nueva idea"} onClose={onClose} busy={busy}
      footer={<>
        {p && <Button variant="ghost" className="mr-auto text-danger" onClick={async () => {
          if (!confirmDel) return setConfirmDel(true);
          const { error } = await getSupabase().rpc("admin_delete_ig_post", { p_id: p.id });
          if (error) return setErr(friendlyError(error));
          onSaved();
        }}>{confirmDel ? "¿Seguro? Tocá de nuevo" : "Borrar"}</Button>}
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button loading={busy} onClick={save}>Guardar</Button>
      </>}>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <TextField label="Idea" {...f("titulo")} maxLength={140} placeholder="Ej.: Reel «Un día en el balneario»" />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Tipo" htmlFor="ig-tipo"><Select id="ig-tipo" {...f("tipo")}>{(Object.keys(TIPO) as Tipo[]).map((k) => <option key={k} value={k}>{TIPO[k].label}</option>)}</Select></Field>
            <Field label="Estado" htmlFor="ig-estado"><Select id="ig-estado" {...f("estado")}>{(Object.keys(ESTADO) as Estado[]).map((k) => <option key={k} value={k}>{ESTADO[k]}</option>)}</Select></Field>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1"><TextField label="Fecha (vacía = banco de ideas)" type="date" {...f("fecha")} /></div>
            {v.fecha && <Button variant="ghost" onClick={() => setV({ ...v, fecha: "" })}>Sin fecha</Button>}
          </div>
          <Field label="Notas (qué grabar, qué imágenes usar…)" htmlFor="ig-notas"><Textarea id="ig-notas" rows={4} {...f("notas")} maxLength={2000} /></Field>
        </div>
        <div className="flex flex-col gap-3">
          <Field label="Descripción" htmlFor="ig-desc">
            <Textarea id="ig-desc" rows={9} {...f("descripcion")} maxLength={2200} placeholder="El texto que va abajo de la publicación." />
          </Field>
          <TextField label="Hashtags" {...f("hashtags")} maxLength={600} placeholder="#balneario #playa #mibalneario" />
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span className={full.length > 2200 ? "text-danger" : ""}>{full.length} / 2200 caracteres</span>
            <Button variant="secondary" disabled={!full} onClick={async () => {
              try { await navigator.clipboard.writeText(full); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setErr("No se pudo copiar. Seleccioná el texto y copialo a mano."); }
            }}>{copied ? "¡Copiado!" : "Copiar descripción + hashtags"}</Button>
          </div>
        </div>
      </div>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </Modal>
  );
}
