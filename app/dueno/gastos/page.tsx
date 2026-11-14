"use client";
import { useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatMoney, parseMoney, todayISO } from "@/lib/format";
import { SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Spinner, TextField, cx } from "@/components/ui";
import { KPI_ICON, Kpi } from "@/components/owner/board";

type Gasto = { id: string; fecha: string; concepto: string; categoria: Cat; importe: number; notas: string | null; anulado: string | null; motivo_anulacion: string | null };
type Data = { anio: number; gastos: Gasto[]; por_mes: { mes: number; gastos: number; cobrado: number }[]; por_categoria: Partial<Record<Cat, number>>; anios: number[] };
type Cat = "servidores" | "dominio_correo" | "publicidad" | "herramientas" | "viajes" | "impuestos" | "otros";

const CATS: Record<Cat, { label: string; color: string }> = {
  servidores: { label: "Servidores y hosting", color: "#2f80b7" },
  dominio_correo: { label: "Dominio y correo", color: "#5aa9c9" },
  publicidad: { label: "Publicidad", color: "#d99a2b" },
  herramientas: { label: "Herramientas y suscripciones", color: "#7b6cc4" },
  viajes: { label: "Viajes y visitas", color: "#3a9d6e" },
  impuestos: { label: "Impuestos y comisiones", color: "#c0584a" },
  otros: { label: "Otros", color: "#8a8f93" },
};
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** Gastos del negocio Mi Balneario, por año, contra lo cobrado. */
export default function OwnerExpenses() {
  const sb = getSupabase();
  const thisYear = Number(todayISO().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const q = useLoader(async () => unwrap(await sb.rpc("admin_expenses", { p_year: year })) as Data, [year], 120_000);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [voiding, setVoiding] = useState<Gasto | null>(null);
  const d = q.data;
  const years = Array.from(new Set([thisYear, thisYear - 1, ...(d?.anios ?? [])])).sort((a, b) => b - a);
  const gastado = d?.por_mes.reduce((a, m) => a + Number(m.gastos), 0) ?? 0;
  const cobrado = d?.por_mes.reduce((a, m) => a + Number(m.cobrado), 0) ?? 0;
  const max = Math.max(1, ...(d?.por_mes.flatMap((m) => [Number(m.gastos), Number(m.cobrado)]) ?? []));
  const cats = d ? (Object.entries(d.por_categoria) as [Cat, number][]).sort((a, b) => b[1] - a[1]) : [];

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Gastos</h1>
          <p className="text-sm text-muted">Lo que gastás en Mi Balneario (servidores, dominio, publicidad…) y lo que te queda en el año.</p>
        </div>
        <div className="w-32"><Select aria-label="Año" value={year} onChange={(e) => setYear(Number(e.target.value))}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</Select></div>
      </div>
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {msg && <Alert tone={msg.tone} className="mb-3">{msg.text}</Alert>}
      {q.error && /admin_expenses|schema cache|function/i.test(q.error) && !d && <p className="text-sm text-muted">Falta correr la actualización 0055 en Supabase.</p>}
      {!d ? (q.loading && <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando…</div>) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Kpi icon={KPI_ICON.plata} tone="green" label={`Cobrado en ${year}`} value={formatMoney(cobrado)} note="pagos de los balnearios" />
            <Kpi icon="M3 17l6-6 4 4 8-8M14 7h7v7" tone="red" label={`Gastado en ${year}`} value={formatMoney(gastado)} note={`${d.gastos.filter((g) => !g.anulado).length} gastos`} />
            <Kpi icon={KPI_ICON.ok} tone={cobrado - gastado >= 0 ? "sea" : "red"} label="Te queda" value={formatMoney(cobrado - gastado)} note="cobrado − gastado" />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <NewExpense onSaved={(t) => { setMsg({ tone: "ok", text: t }); q.reload(); }} onError={(t) => setMsg({ tone: "danger", text: t })} year={year} />
            <section className="rounded-2xl border border-line bg-surface p-4 lg:col-span-2">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold">Mes a mes</h2>
                <span className="flex gap-3 text-xs text-muted">
                  <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: "var(--color-ok)" }} />Cobrado</span>
                  <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-rose-400 align-middle" />Gastado</span>
                </span>
              </div>
              <div className="flex h-48 items-end gap-1.5" role="img" aria-label={`Cobrado y gastado por mes en ${year}`}>
                {d.por_mes.map((m) => (
                  <div key={m.mes} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${MESES[m.mes - 1]}: cobrado ${formatMoney(m.cobrado)} · gastado ${formatMoney(m.gastos)}`}>
                    <div className="flex h-full w-full items-end justify-center gap-0.5">
                      <div className="w-1/2 max-w-4 rounded-t" style={{ height: `${Math.max(m.cobrado > 0 ? 3 : 0, (Number(m.cobrado) / max) * 100)}%`, background: "var(--color-ok)" }} />
                      <div className="w-1/2 max-w-4 rounded-t bg-rose-400" style={{ height: `${Math.max(m.gastos > 0 ? 3 : 0, (Number(m.gastos) / max) * 100)}%` }} />
                    </div>
                    <span className="text-[10px] text-muted">{MESES[m.mes - 1]}</span>
                  </div>
                ))}
              </div>
              {cats.length > 0 && (
                <div className="mt-4">
                  <div className="flex h-3 overflow-hidden rounded-full">
                    {cats.map(([c, v]) => <div key={c} style={{ width: `${(v / gastado) * 100}%`, background: CATS[c].color }} title={`${CATS[c].label}: ${formatMoney(v)}`} />)}
                  </div>
                  <ul className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                    {cats.map(([c, v]) => (
                      <li key={c} className="flex items-center justify-between gap-2">
                        <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: CATS[c].color }} />{CATS[c].label}</span>
                        <span className="tabular">{formatMoney(v)} <span className="text-xs text-muted">({Math.round((v / gastado) * 100)}%)</span></span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          </div>

          <Card title={`Gastos de ${year}`}>
            {d.gastos.length === 0 ? <EmptyState>Todavía no cargaste gastos de {year}.</EmptyState> : (
              <ul className="divide-y divide-line">
                {d.gastos.map((g) => (
                  <li key={g.id} className={cx("flex flex-wrap items-center gap-3 py-2.5", g.anulado && "opacity-60")}>
                    <span className="h-8 w-1.5 shrink-0 rounded-full" style={{ background: CATS[g.categoria].color }} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className={cx("font-medium", g.anulado && "line-through")}>{g.concepto}</div>
                      <div className="text-xs text-muted">{formatDate(g.fecha)} · {CATS[g.categoria].label}{g.notas ? ` · ${g.notas}` : ""}</div>
                      {g.anulado && <div className="text-xs text-muted">Anulado{g.motivo_anulacion ? `: ${g.motivo_anulacion}` : ""}</div>}
                    </div>
                    <span className={cx("tabular font-semibold", g.anulado && "line-through")}>{formatMoney(g.importe)}</span>
                    {g.anulado ? <Badge tone="muted">Anulado</Badge> : <Button variant="ghost" onClick={() => setVoiding(g)}>Anular</Button>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
      {voiding && <VoidModal g={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); setMsg({ tone: "ok", text: "Gasto anulado. Queda en la lista tachado." }); q.reload(); }} />}
    </>
  );
}

function NewExpense({ year, onSaved, onError }: { year: number; onSaved: (t: string) => void; onError: (t: string) => void }) {
  const today = todayISO();
  const [date, setDate] = useState(today);
  const [concept, setConcept] = useState("");
  const [cat, setCat] = useState<Cat>("servidores");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const a = parseMoney(amount);
    if (concept.trim().length < 2) return setErr("Poné el concepto.");
    if (a == null || a <= 0) return setErr("Poné el importe.");
    if (!date) return setErr("Poné la fecha.");
    setErr(null);
    setBusy(true);
    const { error } = await getSupabase().rpc("admin_add_expense", { p_date: date, p_concept: concept.trim(), p_category: cat, p_amount: a, p_notes: notes.trim() || null });
    setBusy(false);
    if (error) return onError(friendlyError(error));
    setConcept(""); setAmount(""); setNotes("");
    onSaved(`Gasto «${concept.trim()}» de ${formatMoney(a)} guardado${date.slice(0, 4) !== String(year) ? ` (en ${date.slice(0, 4)})` : ""}.`);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-base font-semibold">Nuevo gasto</h2>
      <TextField label="Concepto" placeholder="Ej.: Vercel, dominio, publicidad en Instagram" value={concept} onChange={(e) => setConcept(e.target.value)} maxLength={120} />
      <div className="grid grid-cols-2 gap-2">
        <TextField label="Importe" inputMode="decimal" placeholder="$" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <TextField label="Fecha" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <Field label="Categoría" htmlFor="gasto-cat">
        <Select id="gasto-cat" value={cat} onChange={(e) => setCat(e.target.value as Cat)}>
          {(Object.keys(CATS) as Cat[]).map((c) => <option key={c} value={c}>{CATS[c].label}</option>)}
        </Select>
      </Field>
      <TextField label="Notas (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      {err && <p className="text-sm text-danger">{err}</p>}
      <Button type="submit" loading={busy}>Guardar gasto</Button>
    </form>
  );
}

function VoidModal({ g, onClose, onDone }: { g: Gasto; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open title="Anular gasto" onClose={onClose} busy={busy}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button variant="danger" loading={busy} onClick={async () => {
          setBusy(true);
          const { error } = await getSupabase().rpc("admin_void_expense", { p_id: g.id, p_reason: reason.trim() || null });
          setBusy(false);
          if (error) return setErr(friendlyError(error));
          onDone();
        }}>Anular</Button></>}>
      <p className="mb-3 text-sm">¿Anular <strong>{g.concepto}</strong> ({formatMoney(g.importe)} del {formatDate(g.fecha)})? Deja de sumar, pero queda en la lista tachado.</p>
      <Field label="Motivo (opcional)" htmlFor="void-reason"><Input id="void-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: lo cargué dos veces" /></Field>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </Modal>
  );
}
