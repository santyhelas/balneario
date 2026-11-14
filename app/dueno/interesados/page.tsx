"use client";
import Link from "next/link";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { whatsappLink } from "@/lib/reservations";
import { SyncNotice } from "@/components/shell";
import { Alert, Button, EmptyState, Field, Input, Modal, Select, Spinner, TextField, Textarea, cx } from "@/components/ui";
import { KPI_ICON, Kpi } from "@/components/owner/board";

type Estado = "nuevo" | "contactado" | "propuesta" | "demo" | "cerrado" | "perdido";
type Lead = { id: string; nombre: string; balneario: string | null; telefono: string | null; correo: string | null; ciudad: string | null; origen: string | null;
  estado: Estado; notas: string | null; proximo_contacto: string | null; creado: string; actualizado: string; cerrado: string | null; version: number };
type Data = { hoy: string; interesados: Lead[]; embudo: { mes: string; demo: number; consultas: number; clientes: number }[] };

const ESTADOS: Record<Estado, { label: string; cls: string }> = {
  nuevo: { label: "Nuevo", cls: "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100" },
  contactado: { label: "Contactado", cls: "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-100" },
  propuesta: { label: "Propuesta enviada", cls: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100" },
  demo: { label: "Probando la demo", cls: "bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-100" },
  cerrado: { label: "Cliente", cls: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100" },
  perdido: { label: "No avanzó", cls: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300" },
};
const ORIGEN: Record<string, string> = { whatsapp: "WhatsApp", instagram: "Instagram", correo: "Correo", demo: "Desde la demo", recomendacion: "Recomendación", visita: "Visita en persona", otro: "Otro" };
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** Los que piden presupuesto, en qué quedó cada uno y el embudo demo → consulta → cliente. */
export default function OwnerLeads() {
  const sb = getSupabase();
  const q = useLoader(async () => unwrap(await sb.rpc("admin_leads")) as Data, [], 120_000);
  const [filter, setFilter] = useState<Estado | "activos" | "todos">("activos");
  const [edit, setEdit] = useState<Lead | "nuevo" | null>(null);
  const [search, setSearch] = useState("");
  const d = q.data;
  const t = search.trim().toLowerCase();
  const list = (d?.interesados ?? []).filter((l) => (filter === "todos" ? true : filter === "activos" ? !["cerrado", "perdido"].includes(l.estado) : l.estado === filter))
    .filter((l) => !t || [l.nombre, l.balneario, l.telefono, l.correo, l.ciudad].some((x) => (x ?? "").toLowerCase().includes(t)))
    .sort((a, b) => (a.proximo_contacto ?? "9999").localeCompare(b.proximo_contacto ?? "9999") || b.actualizado.localeCompare(a.actualizado));
  const hoy = d?.hoy ?? "";
  const tocaHoy = (d?.interesados ?? []).filter((l) => l.proximo_contacto && l.proximo_contacto <= hoy && !["cerrado", "perdido"].includes(l.estado));
  const tot = (d?.embudo ?? []).reduce((a, m) => ({ demo: a.demo + m.demo, consultas: a.consultas + m.consultas, clientes: a.clientes + m.clientes }), { demo: 0, consultas: 0, clientes: 0 });
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Interesados</h1>
          <p className="text-sm text-muted">Los que te piden presupuesto y en qué quedó cada uno, para que no se te pierda ninguno.</p>
        </div>
        <Button onClick={() => setEdit("nuevo")}>Agregar interesado</Button>
      </div>
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {q.error && /admin_leads|schema cache|function/i.test(q.error) && !d && <Alert tone="warn">Falta correr la actualización 0056 en Supabase.</Alert>}
      {!d ? (q.loading && <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando…</div>) : (
        <div className="flex flex-col gap-4">
          {/* Embudo de los últimos 12 meses */}
          <section className="rounded-2xl border border-line bg-surface p-4">
            <h2 className="mb-3 text-base font-semibold">De la demo a la venta <span className="text-xs font-normal text-muted">· últimos 12 meses</span></h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <Kpi icon={KPI_ICON.ojo} label="Entraron a la demo" value={String(tot.demo)} />
              <Kpi icon={KPI_ICON.personas} tone="sand" label="Te consultaron" value={String(tot.consultas)} note={`${pct(tot.consultas, tot.demo)} de los que vieron la demo`} />
              <Kpi icon={KPI_ICON.ok} tone="green" label="Se hicieron clientes" value={String(tot.clientes)} note={`${pct(tot.clientes, tot.consultas)} de los que consultaron`} />
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[520px] text-center text-xs">
                <thead><tr className="text-muted"><th className="py-1 text-left font-medium">Mes</th>{d.embudo.map((m) => <th key={m.mes} className="font-medium">{MESES[Number(m.mes.slice(5, 7)) - 1]}</th>)}</tr></thead>
                <tbody className="tabular">
                  {([["Demo", "demo", "bg-sky-500"], ["Consultas", "consultas", "bg-amber-500"], ["Clientes", "clientes", "bg-emerald-500"]] as const).map(([l, k, c]) => {
                    const max = Math.max(1, ...d.embudo.map((m) => m[k]));
                    return (
                      <tr key={k}>
                        <td className="py-1 text-left text-muted">{l}</td>
                        {d.embudo.map((m) => (
                          <td key={m.mes} className="px-0.5 py-1">
                            <div className={cx("mx-auto rounded-md text-white", m[k] ? c : "bg-surface-2 text-muted")} style={{ opacity: m[k] ? 0.45 + 0.55 * (m[k] / max) : 1 }}>{m[k] || "·"}</div>
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-muted">«Consultas» son los interesados que cargás acá; «Clientes», los balnearios nuevos del mes.</p>
          </section>

          {tocaHoy.length > 0 && (
            <Alert tone="warn">Hoy te toca contactar a: {tocaHoy.map((l) => l.nombre + (l.balneario ? ` (${l.balneario})` : "")).join(", ")}.</Alert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="w-full sm:w-64"><Input type="search" aria-label="Buscar interesado" placeholder="Buscar…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
            {(["activos", ...Object.keys(ESTADOS), "todos"] as (Estado | "activos" | "todos")[]).map((k) => (
              <button key={k} type="button" onClick={() => setFilter(k)}
                className={filter === k ? "rounded-full border border-accent bg-accent-soft px-3 py-1 text-sm font-semibold text-accent" : "rounded-full border border-line px-3 py-1 text-sm hover:bg-surface-2"}>
                {k === "activos" ? "En curso" : k === "todos" ? "Todos" : ESTADOS[k as Estado].label}{" "}
                <span className="tabular text-muted">{d.interesados.filter((l) => (k === "todos" ? true : k === "activos" ? !["cerrado", "perdido"].includes(l.estado) : l.estado === k)).length}</span>
              </button>
            ))}
          </div>

          {list.length === 0 ? <EmptyState>{d.interesados.length ? "Ninguno con ese filtro." : "Cargá acá a cada uno que te pida presupuesto."}</EmptyState> : (
            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {list.map((l) => {
                const wa = whatsappLink(l.telefono, `¡Hola ${l.nombre.split(" ")[0]}! Te escribo de Mi Balneario.`);
                return (
                  <li key={l.id} className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{l.nombre}</div>
                        <div className="truncate text-xs text-muted">{[l.balneario, l.ciudad].filter(Boolean).join(" · ") || "—"}</div>
                      </div>
                      <span className={cx("shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold", ESTADOS[l.estado].cls)}>{ESTADOS[l.estado].label}</span>
                    </div>
                    {l.notas && <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted">{l.notas}</p>}
                    <div className="text-xs text-muted">
                      {l.origen ? `${ORIGEN[l.origen]} · ` : ""}desde el {formatDate(l.creado.slice(0, 10))}
                      {l.proximo_contacto && !["cerrado", "perdido"].includes(l.estado) && (
                        <span className={cx("ml-1 font-semibold", l.proximo_contacto <= hoy ? "text-danger" : "text-fg")}> · contactar el {formatDate(l.proximo_contacto)}</span>
                      )}
                    </div>
                    <div className="mt-auto flex flex-wrap gap-2 pt-1">
                      <Button variant="secondary" onClick={() => setEdit(l)}>Editar</Button>
                      {wa && <a href={wa} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-green-600/40 bg-green-50 px-3 py-1.5 text-sm font-semibold text-green-800 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-200">WhatsApp</a>}
                      {l.estado === "cerrado" && l.correo && (
                        <Link href={`/dueno/altas?correo=${encodeURIComponent(l.correo)}&nota=${encodeURIComponent(l.balneario ?? l.nombre)}`}
                          className="rounded-lg border border-accent/40 bg-accent-soft px-3 py-1.5 text-sm font-semibold text-accent">Habilitar su balneario</Link>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {edit && <LeadModal lead={edit === "nuevo" ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); q.reload(); }} />}
    </>
  );
}

function LeadModal({ lead, onClose, onSaved }: { lead: Lead | null; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({
    nombre: lead?.nombre ?? "", balneario: lead?.balneario ?? "", telefono: lead?.telefono ?? "", correo: lead?.correo ?? "", ciudad: lead?.ciudad ?? "",
    origen: lead?.origen ?? "whatsapp", estado: lead?.estado ?? "nuevo", notas: lead?.notas ?? "", proximo_contacto: lead?.proximo_contacto ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const f = (k: keyof typeof v) => ({ value: v[k], onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }) });
  async function save() {
    if (v.nombre.trim().length < 2) return setErr("Poné el nombre.");
    setBusy(true);
    const { error } = await getSupabase().rpc("admin_save_lead", { p_id: lead?.id ?? null, p_version: lead?.version ?? null, p: v });
    setBusy(false);
    if (error) return setErr(friendlyError(error));
    onSaved();
  }
  return (
    <Modal open wide title={lead ? `Editar · ${lead.nombre}` : "Nuevo interesado"} onClose={onClose} busy={busy}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button loading={busy} onClick={save}>Guardar</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Nombre" {...f("nombre")} maxLength={100} />
        <TextField label="Balneario" {...f("balneario")} maxLength={100} />
        <TextField label="Teléfono" {...f("telefono")} maxLength={40} inputMode="tel" />
        <TextField label="Correo" type="email" {...f("correo")} maxLength={120} />
        <TextField label="Ciudad / playa" {...f("ciudad")} maxLength={80} />
        <Field label="Cómo llegó" htmlFor="lead-origen">
          <Select id="lead-origen" {...f("origen")}>{Object.entries(ORIGEN).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        </Field>
        <Field label="En qué quedó" htmlFor="lead-estado">
          <Select id="lead-estado" {...f("estado")}>{(Object.keys(ESTADOS) as Estado[]).map((k) => <option key={k} value={k}>{ESTADOS[k].label}</option>)}</Select>
        </Field>
        <TextField label="Volver a contactar el" type="date" {...f("proximo_contacto")} />
        <div className="sm:col-span-2">
          <Field label="Notas" htmlFor="lead-notas"><Textarea id="lead-notas" rows={4} {...f("notas")} maxLength={2000} placeholder="Ej.: 60 carpas, quiere probar en diciembre. Le mandé la propuesta el 10/11." /></Field>
        </div>
      </div>
      {v.estado === "cerrado" && <p className="mt-2 text-xs text-muted">Con el correo cargado, en la ficha aparece «Habilitar su balneario».</p>}
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </Modal>
  );
}
