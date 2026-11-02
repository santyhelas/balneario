"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { formatDate, formatMoney } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, EmptyState, Spinner } from "@/components/ui";
import { CloseCashModal, OpenCashModal, type CashSummary } from "@/components/cash";

type Counts = { total_activos: number; ocupados: number; cortesias: number; disponibles: number; mantenimiento: number; desactivados: number };
type ResItem = { reservation_id: string; number: number; customer: string; phone: string | null; start_date: string; end_date: string; spaces: string | null; due_amount: number; is_courtesy: boolean };
type Summary = {
  fecha: string;
  espacios: Partial<Record<"carpa" | "sombrilla", Counts>>;
  ingresan_hoy: ResItem[];
  finalizan_hoy: ResItem[];
  clientes_con_deuda: number;
  ingresos_hoy: { efectivo: number; transferencia: number; tarjeta: number; total: number };
  gastos_hoy: number;
  caja: { estado: "sin_abrir" | "abierta" | "cerrada"; session_id?: string };
  caja_anterior_sin_cerrar: { session_id: string; fecha: string } | null;
};

export default function DashboardPage() {
  const { ws } = useWorkspace();
  const sb = getSupabase();
  const { data, error, loading, reload, stale, updatedAt } = useLoader<Summary>(
    async () => unwrap(await sb.rpc("dashboard_summary", { p_workspace_id: ws.id })) as Summary,
    [ws.id],
  );
  const [openCash, setOpenCash] = useState(false);
  const [askedToday, setAskedToday] = useState(false);
  const [closing, setClosing] = useState<CashSummary | null>(null);

  // Al iniciar un día sin caja abierta, la pide una sola vez (no insiste si se cierra la ventana).
  useEffect(() => {
    if (data && data.caja.estado === "sin_abrir" && !data.caja_anterior_sin_cerrar && !askedToday) {
      setOpenCash(true);
      setAskedToday(true);
    }
  }, [data, askedToday]);

  async function startClosePrevious() {
    if (!data?.caja_anterior_sin_cerrar) return;
    const res = await sb.rpc("cash_session_summary", { p_session_id: data.caja_anterior_sin_cerrar.session_id });
    if (!res.error) setClosing(res.data as CashSummary);
  }

  if (!data && loading) {
    return <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando panel…</div>;
  }

  const carpa = data?.espacios.carpa;
  const sombrilla = data?.espacios.sombrilla;
  const endingWithDebt = data?.finalizan_hoy.filter((r) => Number(r.due_amount) > 0) ?? [];

  return (
    <>
      <PageHeader title="Panel del día" subtitle={data ? formatDate(data.fecha) : undefined} actions={<Button variant="secondary" onClick={reload} loading={loading}>Actualizar</Button>} />
      <SyncNotice error={error} stale={stale} updatedAt={updatedAt} onRetry={reload} />

      {data && (
        <div className="flex flex-col gap-4">
          {/* Alertas prioritarias */}
          {data.caja_anterior_sin_cerrar && (
            <Alert tone="danger" className="flex flex-wrap items-center justify-between gap-2">
              <span>La caja del <strong>{formatDate(data.caja_anterior_sin_cerrar.fecha)}</strong> quedó sin cerrar. Cerrala para poder abrir la de hoy.</span>
              <Button variant="danger" onClick={startClosePrevious}>Cerrar esa caja</Button>
            </Alert>
          )}
          {endingWithDebt.length > 0 && (
            <Alert tone="danger">
              <strong>Atención:</strong> {endingWithDebt.length === 1 ? "un cliente termina" : `${endingWithDebt.length} clientes terminan`} hoy con deuda:{" "}
              {endingWithDebt.map((r) => `${r.customer} (${r.spaces}) ${formatMoney(r.due_amount)}`).join(" · ")}
            </Alert>
          )}
          {data.caja.estado === "sin_abrir" && !data.caja_anterior_sin_cerrar && (
            <Alert tone="warn" className="flex flex-wrap items-center justify-between gap-2">
              <span>La caja de hoy todavía no está abierta. Sin caja abierta no se pueden registrar cobros ni gastos.</span>
              <Button onClick={() => setOpenCash(true)}>Abrir caja</Button>
            </Alert>
          )}

          {/* Indicadores */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Carpas ocupadas" value={carpa ? `${carpa.ocupados} / ${carpa.total_activos}` : "0"} note={carpa?.cortesias ? `${carpa.cortesias} por cortesía` : undefined} />
            <Stat label="Carpas disponibles" value={String(carpa?.disponibles ?? 0)} />
            <Stat label="Sombrillas ocupadas" value={sombrilla ? `${sombrilla.ocupados} / ${sombrilla.total_activos}` : "0"} note={sombrilla?.cortesias ? `${sombrilla.cortesias} por cortesía` : undefined} />
            <Stat label="Sombrillas disponibles" value={String(sombrilla?.disponibles ?? 0)} />
            <Stat label="En mantenimiento" value={String((carpa?.mantenimiento ?? 0) + (sombrilla?.mantenimiento ?? 0))} />
            <Stat label="Clientes con deuda" value={String(data.clientes_con_deuda)} tone={data.clientes_con_deuda > 0 ? "warn" : undefined} />
            <Stat label="Cobrado hoy" value={formatMoney(data.ingresos_hoy.total)} note={`Efectivo ${formatMoney(data.ingresos_hoy.efectivo)} · Transf. ${formatMoney(data.ingresos_hoy.transferencia)} · Tarjeta ${formatMoney(data.ingresos_hoy.tarjeta)}`} />
            <Stat label="Gastos de hoy" value={formatMoney(data.gastos_hoy)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Ingresan hoy" actions={<Badge>{data.ingresan_hoy.length}</Badge>}>
              <ResList items={data.ingresan_hoy} empty="Nadie ingresa hoy." />
            </Card>
            <Card title="Finalizan hoy" actions={<Badge>{data.finalizan_hoy.length}</Badge>}>
              <ResList items={data.finalizan_hoy} empty="Nadie termina su estadía hoy." />
            </Card>
          </div>

          <Card title="Caja" actions={<Link className="text-sm text-accent hover:underline" href="/caja">Ir a caja →</Link>}>
            <p className="text-sm">
              Estado:{" "}
              {data.caja.estado === "abierta" ? <Badge tone="ok">Abierta</Badge> : data.caja.estado === "cerrada" ? <Badge tone="muted">Cerrada</Badge> : <Badge tone="warn">Sin abrir</Badge>}
            </p>
          </Card>
        </div>
      )}

      <OpenCashModal open={openCash} workspaceId={ws.id} onClose={() => setOpenCash(false)} onDone={() => { setOpenCash(false); reload(); }} />
      <CloseCashModal open={closing !== null} summary={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); reload(); }} />
    </>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "warn" }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`tabular mt-1 text-xl font-semibold ${tone === "warn" ? "text-warn" : ""}`}>{value}</div>
      {note && <div className="mt-1 text-xs text-muted">{note}</div>}
    </div>
  );
}

function ResList({ items, empty }: { items: ResItem[]; empty: string }) {
  if (items.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <ul className="divide-y divide-line">
      {items.map((r) => (
        <li key={r.reservation_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <div>
            <div className="font-medium">{r.customer} <span className="text-muted">· #{r.number}</span></div>
            <div className="text-xs text-muted">
              {r.spaces} · {formatDate(r.start_date)} al {formatDate(r.end_date)}
              {r.phone ? ` · ${r.phone}` : ""}
            </div>
          </div>
          {r.is_courtesy ? (
            <Badge tone="info">Cortesía</Badge>
          ) : Number(r.due_amount) > 0 ? (
            <Badge tone="danger">Debe {formatMoney(r.due_amount)}</Badge>
          ) : (
            <Badge tone="ok">Pagado</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}
