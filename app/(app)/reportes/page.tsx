"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { addDays, formatDate, formatMoney, todayISO } from "@/lib/format";
import { METHOD_LABEL } from "@/lib/methods";
import { downloadCsv } from "@/lib/csv";
import { useWorkspace } from "@/components/workspace";
import { SeasonCompare } from "@/components/season-compare";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Button, Card, EmptyState, Field, Input, Spinner, cx } from "@/components/ui";

type Report = {
  ocupacion: { dia: string; carpas: number; sombrillas: number; cortesias: number }[];
  activos: { carpas: number; sombrillas: number };
  contratado: { reservas: number; precio_lista: number; descuentos: number; total: number; cortesias: number; cortesias_dias: number; cortesias_valor: number; canceladas: number };
  caja_movimientos: { categoria: string; medio: string; sentido: string; importe: number; cantidad: number }[];
  cobrado_por_dia: { dia: string; cobrado: number; gastos: number }[];
  gastos: { categoria: string; importe: number; cantidad: number; efectivo: number | null }[];
  cierres: { fecha: string; apertura: number; esperado: number; contado: number; diferencia: number; notas: string | null }[];
  descuentos: { tipo: string; detalle: string; importe: number; cantidad: number }[];
  deudas: { reserva: number; reservation_id: string; cliente: string; telefono: string | null; desde: string; hasta: string; total: number; saldo: number }[];
  frecuentes: { cliente: string; customer_id: string; telefono: string | null; reservas: number; dias: number; pagado: number; ultima: string }[];
};

const n = (v: unknown) => Number(v ?? 0);

function seasonRange(today: string): [string, string] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const start = m >= 7 ? y : y - 1;
  return [`${start}-12-01`, `${start + 1}-03-31`];
}

export default function ReportesPage() {
  const { ws } = useWorkspace();
  const sb = getSupabase();
  const today = todayISO(ws.timezone);
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const valid = from <= to;

  const q = useLoader<Report | null>(async () => {
    if (!valid) return null;
    return unwrap(await sb.rpc("report_summary", { p_workspace_id: ws.id, p_from: from, p_to: to })) as Report;
  }, [ws.id, from, to], 0);
  const r = q.data;

  const calc = useMemo(() => {
    if (!r) return null;
    const total = n(r.activos.carpas) + n(r.activos.sombrillas);
    const days = r.ocupacion.length || 1;
    const occDays = r.ocupacion.map((d) => ({ ...d, total: n(d.carpas) + n(d.sombrillas), pct: total ? ((n(d.carpas) + n(d.sombrillas)) / total) * 100 : 0 }));
    const avg = occDays.reduce((s, d) => s + d.pct, 0) / days;
    const peak = occDays.reduce((m, d) => (d.pct > m.pct ? d : m), occDays[0] ?? { dia: from, pct: 0, total: 0, carpas: 0, sombrillas: 0, cortesias: 0 });
    // Semanas (de lunes a domingo)
    const weeks = new Map<string, { sum: number; days: number }>();
    occDays.forEach((d) => {
      const dt = new Date(d.dia + "T00:00:00Z");
      const monday = addDays(d.dia, -((dt.getUTCDay() + 6) % 7));
      const w = weeks.get(monday) ?? { sum: 0, days: 0 };
      w.sum += d.pct;
      w.days += 1;
      weeks.set(monday, w);
    });
    const months = new Map<string, { sum: number; days: number }>();
    occDays.forEach((d) => {
      const k = d.dia.slice(0, 7);
      const m = months.get(k) ?? { sum: 0, days: 0 };
      m.sum += d.pct;
      m.days += 1;
      months.set(k, m);
    });
    const sign: Record<string, number> = { cobro: 1, otro_ingreso: 1, anulacion_devolucion: 1, devolucion: -1, anulacion_cobro: -1 };
    const byMethod = new Map<string, number>();
    let cobrado = 0;
    let gastosCaja = 0;
    r.caja_movimientos.forEach((m) => {
      if (sign[m.categoria] !== undefined) {
        cobrado += sign[m.categoria] * n(m.importe);
        byMethod.set(m.medio, (byMethod.get(m.medio) ?? 0) + sign[m.categoria] * n(m.importe));
      }
      if (m.categoria === "gasto") gastosCaja += n(m.importe);
      if (m.categoria === "anulacion_gasto") gastosCaja -= n(m.importe);
    });
    const gastos = r.gastos.reduce((s, g) => s + n(g.importe), 0);
    const diffs = r.cierres.reduce((s, c) => s + n(c.diferencia), 0);
    const deuda = r.deudas.reduce((s, d) => s + n(d.saldo), 0);
    return { total, occDays, avg, peak, weeks: [...weeks.entries()], months: [...months.entries()], cobrado, byMethod: [...byMethod.entries()], gastos, gastosCaja, diffs, deuda };
  }, [r, from]);

  const presets: [string, () => void][] = [
    ["Hoy", () => { setFrom(today); setTo(today); }],
    ["7 días", () => { setFrom(addDays(today, -6)); setTo(today); }],
    ["Este mes", () => { setFrom(today.slice(0, 8) + "01"); setTo(today); }],
    ["Temporada", () => { const [a, b] = seasonRange(today); setFrom(a); setTo(b); }],
  ];

  return (
    <>
      <PageHeader
        title="Reportes"
        subtitle="Todo sale de los registros reales. «Contratado» es el precio de las reservas; «Cobrado» es el dinero que entró a la caja."
        actions={<Button variant="secondary" onClick={() => window.print()}>Imprimir / PDF</Button>}
      />
      <div className="mb-4 flex flex-wrap items-end gap-2 print:hidden">
        <Field label="Desde"><Input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-auto" /></Field>
        <Field label="Hasta"><Input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="w-auto" /></Field>
        {presets.map(([l, f]) => <Button key={l} variant="secondary" onClick={f}>{l}</Button>)}
      </div>
      <p className="mb-3 hidden text-sm print:block">{ws.name} · Período {formatDate(from)} al {formatDate(to)}</p>
      {!valid && <p className="text-sm text-danger">La fecha «hasta» no puede ser anterior a «desde».</p>}
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {q.loading && !r && valid && <div className="flex items-center gap-2 text-muted"><Spinner small /> Calculando…</div>}

      {r && calc && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Ocupación promedio" value={`${calc.avg.toFixed(0)}%`} note={`Pico ${calc.peak.pct.toFixed(0)}% el ${formatDate(calc.peak.dia)}`} />
            <Kpi label="Contratado" value={formatMoney(r.contratado.total)} note={`${r.contratado.reservas} reservas que comienzan en el período`} />
            <Kpi label="Cobrado (caja)" value={formatMoney(calc.cobrado)} tone="ok" note="Neto de devoluciones y anulaciones" />
            <Kpi label="Gastos" value={formatMoney(calc.gastos)} tone="danger" note={`Resultado: ${formatMoney(calc.cobrado - calc.gastos)}`} />
            <Kpi label="Deuda pendiente hoy" value={formatMoney(calc.deuda)} tone="danger" note={`${r.deudas.length} reservas`} />
            <Kpi label="Diferencias de caja" value={formatMoney(calc.diffs)} tone={calc.diffs !== 0 ? "warn" : undefined} note={`${r.cierres.length} cierres`} />
          </div>

          <Card title="Ocupación diaria" tour="reportes" actions={<CsvBtn onClick={() => downloadCsv(`ocupacion_${from}_${to}.csv`, ["Fecha", "Carpas ocupadas", "Sombrillas ocupadas", "Cortesías", "% ocupación"], calc.occDays.map((d) => [formatDate(d.dia), n(d.carpas), n(d.sombrillas), n(d.cortesias), Math.round(d.pct)]))} />}>
            {calc.occDays.length === 0 ? <EmptyState>Sin datos.</EmptyState> : (
              <>
                <div className="flex h-40 items-end gap-px overflow-x-auto rounded-lg bg-surface-2 p-2" role="img" aria-label="Gráfico de ocupación diaria">
                  {calc.occDays.map((d) => (
                    <div key={d.dia} className="group relative flex h-full min-w-[6px] flex-1 flex-col justify-end" title={`${formatDate(d.dia)}: ${d.total} ocupados (${d.pct.toFixed(0)}%)`}>
                      <div className="print-bar rounded-t-sm bg-accent" style={{ height: `${Math.max(d.pct, d.total ? 2 : 0)}%` }} />
                    </div>
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-xs text-muted"><span>{formatDate(from)}</span><span>{calc.total} espacios activos</span><span>{formatDate(to)}</span></div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <MiniTable title="Por semana (desde el lunes)" rows={calc.weeks.map(([k, v]) => [formatDate(k), `${(v.sum / v.days).toFixed(0)}%`])} />
                  <MiniTable title="Por mes" rows={calc.months.map(([k, v]) => [`${k.slice(5, 7)}/${k.slice(0, 4)}`, `${(v.sum / v.days).toFixed(0)}%`])} />
                </div>
              </>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Contratado vs. cobrado">
              <dl className="flex flex-col gap-1 text-sm">
                <Row l="Precio de lista" v={formatMoney(r.contratado.precio_lista)} />
                <Row l="− Descuentos" v={formatMoney(r.contratado.descuentos)} />
                <Row l="= Contratado" v={formatMoney(r.contratado.total)} strong />
                <Row l="Cobrado en caja en el período" v={formatMoney(calc.cobrado)} strong />
                <Row l="Reservas canceladas" v={String(r.contratado.canceladas)} />
              </dl>
              <h3 className="mb-1 mt-4 text-sm font-semibold">Cobrado por medio de pago</h3>
              {calc.byMethod.length === 0 ? <p className="text-sm text-muted">Sin cobros.</p> : (
                <dl className="flex flex-col gap-1 text-sm">{calc.byMethod.map(([m, v]) => <Row key={m} l={METHOD_LABEL[m] ?? m} v={formatMoney(v)} />)}</dl>
              )}
            </Card>
            <Card title="Entradas y salidas por día" actions={<CsvBtn onClick={() => downloadCsv(`caja_${from}_${to}.csv`, ["Fecha", "Cobrado neto", "Gastos"], r.cobrado_por_dia.map((d) => [formatDate(d.dia), n(d.cobrado), n(d.gastos)]))} />}>
              {r.cobrado_por_dia.length === 0 ? <EmptyState>No hubo cajas abiertas en el período.</EmptyState> : (
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted"><tr><th className="py-1">Fecha</th><th className="text-right">Cobrado</th><th className="text-right">Gastos</th></tr></thead>
                    <tbody className="divide-y divide-line tabular">
                      {r.cobrado_por_dia.map((d) => <tr key={d.dia}><td className="py-1">{formatDate(d.dia)}</td><td className="text-right text-ok">{formatMoney(d.cobrado)}</td><td className="text-right text-danger">{formatMoney(d.gastos)}</td></tr>)}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Gastos por categoría" actions={<CsvBtn onClick={() => downloadCsv(`gastos_categoria_${from}_${to}.csv`, ["Categoría", "Cantidad", "Importe", "En efectivo"], r.gastos.map((g) => [g.categoria, n(g.cantidad), n(g.importe), n(g.efectivo)]))} />}>
              {r.gastos.length === 0 ? <EmptyState>Sin gastos.</EmptyState> : (
                <ul className="flex flex-col gap-2 text-sm">
                  {r.gastos.map((g) => (
                    <li key={g.categoria}>
                      <div className="flex justify-between"><span>{g.categoria} <span className="text-muted">({g.cantidad})</span></span><span className="tabular font-medium">{formatMoney(g.importe)}</span></div>
                      <div className="mt-1 h-2 rounded-full bg-surface-2"><div className="print-bar h-2 rounded-full bg-danger/70" style={{ width: `${calc.gastos ? (n(g.importe) / calc.gastos) * 100 : 0}%` }} /></div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Descuentos, convenios y cortesías" actions={<CsvBtn onClick={() => downloadCsv(`descuentos_${from}_${to}.csv`, ["Tipo", "Detalle", "Veces", "Importe"], r.descuentos.map((d) => [d.tipo, d.detalle, n(d.cantidad), n(d.importe)]))} />}>
              {r.descuentos.length === 0 ? <EmptyState>Sin descuentos en el período.</EmptyState> : (
                <dl className="flex flex-col gap-1 text-sm">{r.descuentos.map((d, i) => <Row key={i} l={`${d.detalle} (${d.cantidad})`} v={formatMoney(d.importe)} />)}</dl>
              )}
              <div className="mt-3 rounded-lg bg-surface-2 p-3 text-sm">
                <strong>Cortesías familiares:</strong> {r.contratado.cortesias} reservas · {r.contratado.cortesias_dias} días · valor de lista {formatMoney(r.contratado.cortesias_valor)} (no generan ingreso ni deuda).
              </div>
            </Card>
          </div>

          <Card title="Cierres de caja" actions={<CsvBtn onClick={() => downloadCsv(`cierres_${from}_${to}.csv`, ["Fecha", "Apertura", "Esperado", "Contado", "Diferencia", "Notas"], r.cierres.map((c) => [formatDate(c.fecha), n(c.apertura), n(c.esperado), n(c.contado), n(c.diferencia), c.notas ?? ""]))} />}>
            {r.cierres.length === 0 ? <EmptyState>Sin cierres en el período.</EmptyState> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted"><tr><th className="py-1 pr-3">Fecha</th><th className="pr-3 text-right">Apertura</th><th className="pr-3 text-right">Esperado</th><th className="pr-3 text-right">Contado</th><th className="text-right">Diferencia</th></tr></thead>
                  <tbody className="divide-y divide-line tabular">
                    {r.cierres.map((c) => (
                      <tr key={c.fecha}><td className="py-1 pr-3">{formatDate(c.fecha)}</td><td className="pr-3 text-right">{formatMoney(c.apertura)}</td><td className="pr-3 text-right">{formatMoney(c.esperado)}</td><td className="pr-3 text-right">{formatMoney(c.contado)}</td>
                        <td className={cx("text-right font-medium", n(c.diferencia) !== 0 && "text-warn")}>{formatMoney(c.diferencia)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Deudas pendientes" actions={<CsvBtn onClick={() => downloadCsv(`deudas_${today}.csv`, ["Reserva", "Cliente", "Teléfono", "Desde", "Hasta", "Total", "Saldo"], r.deudas.map((d) => [d.reserva, d.cliente, d.telefono ?? "", formatDate(d.desde), formatDate(d.hasta), n(d.total), n(d.saldo)]))} />}>
              {r.deudas.length === 0 ? <EmptyState>No hay deudas.</EmptyState> : (
                <ul className="divide-y divide-line text-sm">
                  {r.deudas.map((d) => (
                    <li key={d.reservation_id} className="flex justify-between gap-2 py-1.5">
                      <Link href={`/reservas/${d.reservation_id}`} className="hover:underline">#{d.reserva} · {d.cliente} <span className="text-xs text-muted">({formatDate(d.desde)}–{formatDate(d.hasta)})</span></Link>
                      <span className="tabular font-medium text-danger">{formatMoney(d.saldo)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Clientes frecuentes" actions={<CsvBtn onClick={() => downloadCsv(`clientes_frecuentes.csv`, ["Cliente", "Teléfono", "Reservas", "Días", "Pagado", "Última"], r.frecuentes.map((f) => [f.cliente, f.telefono ?? "", n(f.reservas), n(f.dias), n(f.pagado), formatDate(f.ultima)]))} />}>
              {r.frecuentes.length === 0 ? <EmptyState>Todavía no hay clientes con 2 o más reservas.</EmptyState> : (
                <ul className="divide-y divide-line text-sm">
                  {r.frecuentes.map((f) => (
                    <li key={f.customer_id} className="flex justify-between gap-2 py-1.5">
                      <span>{f.cliente} <span className="text-xs text-muted">· {f.reservas} reservas · {f.dias} días</span></span>
                      <span className="tabular">{formatMoney(f.pagado)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
      <div className="mt-4" data-tour="temporadas"><SeasonCompare /></div>
    </>
  );
}

function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "ok" | "danger" | "warn" }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={cx("tabular mt-1 truncate text-xl font-bold", tone === "ok" && "text-ok", tone === "danger" && "text-danger", tone === "warn" && "text-warn")}>{value}</div>
      {note && <div className="mt-0.5 text-xs text-muted">{note}</div>}
    </div>
  );
}
function Row({ l, v, strong }: { l: string; v: string; strong?: boolean }) {
  return <div className={cx("flex justify-between gap-3", strong && "font-semibold")}><dt className={strong ? "" : "text-muted"}>{l}</dt><dd className="tabular">{v}</dd></div>;
}
function MiniTable({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold text-muted">{title}</h3>
      <ul className="max-h-40 overflow-y-auto text-sm">{rows.map(([a, b]) => <li key={a} className="flex justify-between border-b border-line py-0.5 last:border-0"><span>{a}</span><span className="tabular">{b}</span></li>)}</ul>
    </div>
  );
}
function CsvBtn({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} className="text-xs font-medium text-accent hover:underline print:hidden">Exportar CSV</button>;
}
