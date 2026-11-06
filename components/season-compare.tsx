"use client";
import { useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { formatMoney, todayISO } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import { useWorkspace } from "@/components/workspace";
import { Button, Card, Select, Spinner, cx } from "@/components/ui";

/** Comparación de dos temporadas, mes por mes (la temporada va de julio a junio). */

type Month = { mes: string; dias_ocupados: number; dias_posibles: number; reservas: number; contratado: number; cobrado: number; gastos: number };
type Season = { temporada: string; espacios: number; meses: Month[] };
type Metric = "ocupacion" | "contratado" | "cobrado" | "gastos" | "reservas";

const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const METRICS: { key: Metric; label: string }[] = [
  { key: "ocupacion", label: "Ocupación" },
  { key: "contratado", label: "Contratado" },
  { key: "cobrado", label: "Cobrado" },
  { key: "gastos", label: "Gastos" },
  { key: "reservas", label: "Reservas" },
];

const num = (v: unknown) => Number(v ?? 0);
const seasonLabel = (y: number) => `${y}/${String(y + 1).slice(2)}`;
/** Posición del mes dentro de la temporada (julio = 0 … junio = 11). */
const seasonIndex = (ym: string) => (Number(ym.slice(5, 7)) + 5) % 12;

function value(m: Month, k: Metric): number {
  if (k === "ocupacion") return num(m.dias_posibles) ? (num(m.dias_ocupados) / num(m.dias_posibles)) * 100 : 0;
  return num(m[k === "reservas" ? "reservas" : k]);
}
const fmt = (k: Metric, v: number) => (k === "ocupacion" ? `${v.toFixed(0)}%` : k === "reservas" ? String(Math.round(v)) : formatMoney(v));

function totals(ms: Month[]) {
  const t = ms.reduce((a, m) => ({
    dias_ocupados: a.dias_ocupados + num(m.dias_ocupados), dias_posibles: a.dias_posibles + num(m.dias_posibles),
    reservas: a.reservas + num(m.reservas), contratado: a.contratado + num(m.contratado), cobrado: a.cobrado + num(m.cobrado), gastos: a.gastos + num(m.gastos),
  }), { dias_ocupados: 0, dias_posibles: 0, reservas: 0, contratado: 0, cobrado: 0, gastos: 0 });
  return { ...t, mes: "total" } as Month;
}

function Change({ a, b, metric }: { a: number; b: number; metric: Metric }) {
  if (metric === "ocupacion") {
    const d = a - b;
    if (Math.abs(d) < 0.5) return <span className="text-muted">igual</span>;
    return <span className={d > 0 ? "text-ok" : "text-danger"}>{d > 0 ? "+" : "−"}{Math.abs(d).toFixed(0)} pts</span>;
  }
  if (!b) return <span className="text-muted">{a ? "nuevo" : "—"}</span>;
  const pct = ((a - b) / b) * 100;
  if (Math.abs(pct) < 0.5) return <span className="text-muted">igual</span>;
  // En gastos, subir es malo.
  const good = metric === "gastos" ? pct < 0 : pct > 0;
  return <span className={good ? "text-ok" : "text-danger"}>{pct > 0 ? "+" : "−"}{Math.abs(pct).toFixed(0)}%</span>;
}

export function SeasonCompare() {
  const { ws } = useWorkspace();
  const sb = getSupabase();
  const today = todayISO(ws.timezone);
  const y = Number(today.slice(0, 4));
  const current = Number(today.slice(5, 7)) >= 7 ? y : y - 1;
  const [a, setA] = useState(current);
  const [b, setB] = useState(current - 1);
  const [metric, setMetric] = useState<Metric>("ocupacion");
  const inProgress = a === current;
  const [toDate, setToDate] = useState(true);

  const q = useLoader(async () => {
    const [ra, rb] = await Promise.all([
      sb.rpc("season_stats", { p_workspace_id: ws.id, p_start_year: a }),
      sb.rpc("season_stats", { p_workspace_id: ws.id, p_start_year: b }),
    ]);
    if (ra.error?.code === "PGRST202" || ra.error?.code === "42883") return null; // falta la actualización 0029
    return { a: unwrap(ra) as Season, b: unwrap(rb) as Season };
  }, [ws.id, a, b], 0);

  const view = useMemo(() => {
    if (!q.data) return null;
    const cut = inProgress && toDate ? seasonIndex(today.slice(0, 7)) : 11;
    const rows = q.data.a.meses.map((ma, i) => ({ i, ma, mb: q.data!.b.meses[i] }))
      .filter((r) => r.i <= cut)
      // Solo los meses en los que pasó algo en alguna de las dos temporadas.
      .filter((r) => [r.ma, r.mb].some((m) => num(m.dias_ocupados) || num(m.reservas) || num(m.cobrado) || num(m.gastos)));
    const ta = totals(rows.map((r) => r.ma));
    const tb = totals(rows.map((r) => r.mb));
    const max = Math.max(1, ...rows.flatMap((r) => [value(r.ma, metric), value(r.mb, metric)]));
    return { rows, ta, tb, max, cut };
  }, [q.data, metric, inProgress, toDate, today]);

  const years = Array.from({ length: 6 }, (_, i) => current - i);

  if (q.data === null) {
    return <Card title="Comparar temporadas"><p className="text-sm text-muted">Para comparar temporadas hay que aplicar la actualización 0029 de la base de datos.</p></Card>;
  }

  return (
    <Card title="Comparar temporadas"
      actions={view && view.rows.length > 0 ? (
        <Button variant="secondary" onClick={() => downloadCsv(`temporadas_${a}_vs_${b}.csv`,
          ["Mes", ...METRICS.flatMap((m) => [`${m.label} ${seasonLabel(a)}`, `${m.label} ${seasonLabel(b)}`])],
          view.rows.map((r) => [MONTHS[Number(r.ma.mes.slice(5, 7)) - 1], ...METRICS.flatMap((m) => [Math.round(value(r.ma, m.key) * 100) / 100, Math.round(value(r.mb, m.key) * 100) / 100])]))}>CSV</Button>
      ) : undefined}>
      <div className="mb-3 flex flex-wrap items-end gap-2 print:hidden">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">Temporada
          <Select value={a} onChange={(e) => setA(Number(e.target.value))} className="w-auto">{years.map((v) => <option key={v} value={v}>{seasonLabel(v)}</option>)}</Select>
        </label>
        <span className="pb-2 text-sm text-muted">contra</span>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">Temporada
          <Select value={b} onChange={(e) => setB(Number(e.target.value))} className="w-auto">{[...years, current - 6].filter((v) => v !== a).map((v) => <option key={v} value={v}>{seasonLabel(v)}</option>)}</Select>
        </label>
        {inProgress && (
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={toDate} onChange={(e) => setToDate(e.target.checked)} /> Solo hasta este mes
          </label>
        )}
      </div>

      {!view ? <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Calculando…</div> : view.rows.length === 0 ? (
        <p className="text-sm text-muted">No hay movimientos en ninguna de las dos temporadas{inProgress && toDate ? " hasta este mes" : ""}.</p>
      ) : (
        <>
          {/* Resumen */}
          <div className="mb-4 overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 font-medium"></th>
                  <th className="py-1 text-right font-semibold text-accent">{seasonLabel(a)}</th>
                  <th className="py-1 text-right font-medium">{seasonLabel(b)}</th>
                  <th className="py-1 text-right font-medium">Cambio</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {METRICS.map((m) => (
                  <tr key={m.key}>
                    <td className="py-1.5">{m.label}{m.key === "ocupacion" ? " promedio" : ""}</td>
                    <td className="py-1.5 text-right font-semibold tabular">{fmt(m.key, value(view.ta, m.key))}</td>
                    <td className="py-1.5 text-right tabular text-muted">{fmt(m.key, value(view.tb, m.key))}</td>
                    <td className="py-1.5 text-right tabular"><Change a={value(view.ta, m.key)} b={value(view.tb, m.key)} metric={m.key} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mes por mes */}
          <div className="mb-2 flex flex-wrap gap-1 print:hidden" role="tablist" aria-label="Qué comparar mes por mes">
            {METRICS.map((m) => (
              <button key={m.key} type="button" role="tab" aria-selected={metric === m.key} onClick={() => setMetric(m.key)}
                className={cx("rounded-lg border px-2.5 py-1 text-sm", metric === m.key ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line hover:bg-surface-2")}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="mb-2 flex gap-4 text-xs text-muted" aria-hidden>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-accent" /> {seasonLabel(a)}</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-muted/40" /> {seasonLabel(b)}</span>
          </div>
          <ul className="flex flex-col gap-2">
            {view.rows.map((r) => {
              const va = value(r.ma, metric);
              const vb = value(r.mb, metric);
              return (
                <li key={r.ma.mes} className="grid grid-cols-[2.5rem_1fr_auto] items-center gap-x-3 text-sm">
                  <span className="font-medium">{MONTHS[Number(r.ma.mes.slice(5, 7)) - 1]}</span>
                  <div className="flex flex-col gap-1" title={`${seasonLabel(a)}: ${fmt(metric, va)} · ${seasonLabel(b)}: ${fmt(metric, vb)}`}>
                    <div className="h-3 rounded-r bg-accent" style={{ width: `${Math.max(va ? 1 : 0, (va / view.max) * 100)}%` }} />
                    <div className="h-3 rounded-r bg-muted/40" style={{ width: `${Math.max(vb ? 1 : 0, (vb / view.max) * 100)}%` }} />
                  </div>
                  <span className="flex flex-col text-right text-xs leading-[1rem] tabular">
                    <span className="font-semibold">{fmt(metric, va)}</span>
                    <span className="text-muted">{fmt(metric, vb)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-muted">
            Contratado: reservas que empiezan en ese mes. Cobrado: lo que entró a la caja ese mes. La ocupación se calcula con las {q.data?.a.espacios ?? 0} carpas y sombrillas activas hoy.
          </p>
        </>
      )}
    </Card>
  );
}
