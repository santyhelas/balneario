"use client";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { formatMoney } from "@/lib/format";
import { SyncNotice } from "@/components/shell";
import { Spinner } from "@/components/ui";
import { KPI_ICON, Kpi } from "@/components/owner/board";

type Metrics = {
  hoy: string;
  ingresos_por_mes: { mes: string; importe: number }[];
  altas_por_mes: { mes: string; cantidad: number }[];
  demo_por_semana: { semana: string; cantidad: number }[];
  totales: { carpas: number; sombrillas: number; reservas: number; reservas_30d: number; clientes: number; demo_total: number; cobrado_anio: number };
};

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const mesCorto = (ym: string) => MESES[Number(ym.slice(5, 7)) - 1];
const diaMes = (d: string) => `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}`;
const compact = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toLocaleString("es-AR", { maximumFractionDigits: 1 })} M` : n >= 1000 ? `$${Math.round(n / 1000)} mil` : `$${n}`);

/** Gráfico de barras simple: el valor arriba de cada barra y la etiqueta abajo. La última barra (la actual) va más fuerte. */
function Bars({ data, format, color, title, summary }: { data: { label: string; value: number }[]; format: (n: number) => string; color: string; title: string; summary: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      <span className="mb-2 truncate text-[11px] text-muted" title={summary}>{summary}</span>
      <div className="flex h-32 items-end gap-1" role="img" aria-label={`${title}: ${data.map((d) => `${d.label} ${format(d.value)}`).join(", ")}`}>
        {data.map((d, i) => (
          <div key={i} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-0.5" title={`${d.label}: ${format(d.value)}`}>
            <span className="text-[9px] tabular text-muted">{d.value && (i === data.length - 1 || d.value === max) ? format(d.value) : ""}</span>
            <div className="w-full max-w-6 rounded-t" style={{ height: `${Math.max(d.value ? 4 : 1, (d.value / max) * 100)}%`, background: color, opacity: i === data.length - 1 ? 1 : 0.55 }} />
            <span className="text-[9px] text-muted">{d.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export type MetricsQuery = ReturnType<typeof useOwnerMetrics>;
export function useOwnerMetrics() {
  const sb = getSupabase();
  return useLoader(async () => unwrap(await sb.rpc("admin_metrics")) as Metrics, [], 5 * 60_000);
}
const missing = (q: MetricsQuery) => !!q.error && /admin_metrics|function|schema cache/i.test(q.error) && !q.data;

/** Cuatro indicadores chicos (van en la misma fila que los del panel). */
export function MetricsKpis({ q }: { q: MetricsQuery }) {
  const m = q.data;
  if (!m) return null;
  const t = m.totales;
  const mesActual = m.ingresos_por_mes[m.ingresos_por_mes.length - 1]?.importe ?? 0;
  return (
    <>
      <Kpi small icon={KPI_ICON.plata} tone="green" label={`Cobrado en ${m.hoy.slice(0, 4)}`} value={formatMoney(t.cobrado_anio)} note={`este mes: ${formatMoney(mesActual)}`} />
      <Kpi small icon={KPI_ICON.carpa} tone="sand" label="Carpas · sombrillas" value={`${t.carpas} · ${t.sombrillas}`} note="que se manejan con el sistema" />
      <Kpi small icon={KPI_ICON.calendario} label="Reservas" value={t.reservas.toLocaleString("es-AR")} note={`${t.reservas_30d.toLocaleString("es-AR")} en 30 días`} />
      <Kpi small icon={KPI_ICON.personas} label="Clientes" value={t.clientes.toLocaleString("es-AR")} note={`${t.demo_total.toLocaleString("es-AR")} visitas a la demo`} />
    </>
  );
}

/** Los tres gráficos, uno al lado del otro. */
export function MetricsCharts({ q }: { q: MetricsQuery }) {
  if (missing(q)) return <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-muted">Para ver los gráficos falta correr la actualización 0054 en Supabase.</p>;
  const m = q.data;
  if (!m) return q.loading ? <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando métricas…</div> : <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />;
  const ultimas4 = m.demo_por_semana.slice(-4).reduce((a, d) => a + d.cantidad, 0);
  const altas12 = m.altas_por_mes.reduce((a, d) => a + d.cantidad, 0);
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Bars title="Cobrado por mes" summary="últimos 12 meses" color="var(--color-ok)"
        data={m.ingresos_por_mes.map((d) => ({ label: mesCorto(d.mes), value: Number(d.importe) }))} format={compact} />
      <Bars title="Visitas a la demo" summary={`por semana · ${ultimas4} en 4 semanas`} color="var(--color-accent)"
        data={m.demo_por_semana.map((d) => ({ label: diaMes(d.semana), value: d.cantidad }))} format={(n) => String(n)} />
      <Bars title="Balnearios nuevos" summary={`por mes · ${altas12} en 12 meses`} color="#d99a2b"
        data={m.altas_por_mes.map((d) => ({ label: mesCorto(d.mes), value: d.cantidad }))} format={(n) => String(n)} />
    </div>
  );
}
