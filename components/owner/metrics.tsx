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
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="text-xs text-muted">{summary}</span>
      </div>
      <div className="flex h-44 items-end gap-1.5" role="img" aria-label={`${title}: ${data.map((d) => `${d.label} ${format(d.value)}`).join(", ")}`}>
        {data.map((d, i) => (
          <div key={i} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${d.label}: ${format(d.value)}`}>
            <span className="text-[10px] tabular text-muted">{d.value ? format(d.value) : ""}</span>
            <div className="w-full max-w-10 rounded-t-md transition-all" style={{ height: `${Math.max(d.value ? 4 : 1, (d.value / max) * 100)}%`, background: color, opacity: i === data.length - 1 ? 1 : 0.55 }} />
            <span className="text-[10px] text-muted">{d.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function OwnerMetrics() {
  const sb = getSupabase();
  const q = useLoader(async () => unwrap(await sb.rpc("admin_metrics")) as Metrics, [], 5 * 60_000);
  if (q.error && /admin_metrics|function|schema cache/i.test(q.error) && !q.data) {
    return <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-muted">Para ver los gráficos falta correr la actualización 0054 en Supabase.</p>;
  }
  const m = q.data;
  if (!m) return q.loading ? <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando métricas…</div> : <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />;
  const t = m.totales;
  const mesActual = m.ingresos_por_mes[m.ingresos_por_mes.length - 1]?.importe ?? 0;
  const ultimas4 = m.demo_por_semana.slice(-4).reduce((a, d) => a + d.cantidad, 0);
  const altas12 = m.altas_por_mes.reduce((a, d) => a + d.cantidad, 0);
  return (
    <div className="flex flex-col gap-4">
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi icon={KPI_ICON.plata} tone="green" label={`Cobrado en ${m.hoy.slice(0, 4)}`} value={formatMoney(t.cobrado_anio)} note={`este mes: ${formatMoney(mesActual)}`} />
        <Kpi icon={KPI_ICON.carpa} tone="sand" label="Carpas y sombrillas" value={`${t.carpas} · ${t.sombrillas}`} note="que se manejan con el sistema" />
        <Kpi icon={KPI_ICON.calendario} label="Reservas cargadas" value={t.reservas.toLocaleString("es-AR")} note={`${t.reservas_30d.toLocaleString("es-AR")} en los últimos 30 días`} />
        <Kpi icon={KPI_ICON.personas} label="Clientes de los balnearios" value={t.clientes.toLocaleString("es-AR")} note={`${t.demo_total.toLocaleString("es-AR")} visitas a la demo en total`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Bars title="Lo que cobraste por mes" summary="pagos registrados y débitos aprobados · últimos 12 meses" color="var(--color-ok)"
          data={m.ingresos_por_mes.map((d) => ({ label: mesCorto(d.mes), value: Number(d.importe) }))} format={compact} />
        <Bars title="Visitas a la demo por semana" summary={`${ultimas4} en las últimas 4 semanas`} color="var(--color-accent)"
          data={m.demo_por_semana.map((d) => ({ label: diaMes(d.semana), value: d.cantidad }))} format={(n) => String(n)} />
        <Bars title="Balnearios nuevos por mes" summary={`${altas12} en los últimos 12 meses`} color="#d99a2b"
          data={m.altas_por_mes.map((d) => ({ label: mesCorto(d.mes), value: d.cantidad }))} format={(n) => String(n)} />
      </div>
    </div>
  );
}
