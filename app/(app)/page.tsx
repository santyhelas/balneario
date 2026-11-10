"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { formatDate, formatMoney } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { useStatus, type ResItem } from "@/components/status";
import { WeekAhead } from "@/components/week-ahead";
import { ICON_HELP, Icon, NAV } from "@/components/shell";
import { SupportModal } from "@/components/support";
import { Alert, Button, Spinner, cx } from "@/components/ui";
import { CloseCashModal, OpenCashModal, type CashSummary } from "@/components/cash";
import { WeatherStrip } from "@/components/weather";
import { useTourActive } from "@/components/demo-tour";
import { ArrivalButtons, type ArrivalState } from "@/components/arrival";

type Tone = "accent" | "ok" | "danger" | "warn" | "orange" | "neutral";
const TONE: Record<Tone, { box: string; label: string; value: string }> = {
  accent: { box: "border-accent/40", label: "text-accent", value: "text-accent" },
  ok: { box: "border-ok/40", label: "text-ok", value: "text-ok" },
  danger: { box: "border-danger/40", label: "text-danger", value: "text-danger" },
  warn: { box: "border-warn/40", label: "text-warn", value: "text-warn" },
  orange: { box: "border-orange-500/40", label: "text-orange-500", value: "text-orange-500" },
  neutral: { box: "border-line", label: "text-muted", value: "text-fg" },
};
const icon = (href: string) => NAV.find((n) => n.href === href)!.icon;

export default function DashboardPage() {
  const { ws, isGuest, role, guideDone } = useWorkspace();
  const st = useStatus();
  const data = st.summary;
  // En la demo, el pedido de abrir la caja espera a que termine el tutorial.
  const demoTour = useTourActive(isGuest);
  const guideTour = useTourActive(!isGuest && role === "propietario", "guia", !guideDone);
  const newsTour = useTourActive(isGuest, "novedades", false);
  const touring = demoTour || guideTour || newsTour;
  const [cash, setCash] = useState<CashSummary | null>(null);
  const [openCash, setOpenCash] = useState(false);
  const [askedToday, setAskedToday] = useState(false);
  const [closing, setClosing] = useState<CashSummary | null>(null);
  const [supportOpen, setSupportOpen] = useState(false);

  // Llegó / no vino de los que empiezan hoy (se lee aparte para no tocar el resumen del día).
  const [arrivals, setArrivals] = useState<Record<string, ArrivalState>>({});
  const arrivalIds = (data?.ingresan_hoy ?? []).map((r) => r.reservation_id).sort().join(",");
  useEffect(() => {
    if (!arrivalIds) { setArrivals({}); return; }
    getSupabase().from("reservations").select("id, arrival_status").in("id", arrivalIds.split(","))
      .then(({ data: rows, error }) => {
        if (error) return; // sin la actualización 0025 no hay columna: no se muestran los botones
        setArrivals(Object.fromEntries((rows as { id: string; arrival_status: ArrivalState }[]).map((r) => [r.id, r.arrival_status])));
      });
  }, [arrivalIds, st.updatedAt]);

  // Detalle de la caja de hoy (efectivo de apertura, entradas y salidas por medio)
  const sessionId = data?.caja.session_id;
  useEffect(() => {
    if (!sessionId) {
      setCash(null);
      return;
    }
    getSupabase().rpc("cash_session_summary", { p_session_id: sessionId }).then(({ data: d }) => setCash((d as CashSummary) ?? null));
  }, [sessionId, st.updatedAt]);

  // Al iniciar un día sin caja abierta, la pide una sola vez (no insiste si se cierra la ventana).
  useEffect(() => {
    if (touring) return;
    if (data && data.caja.estado === "sin_abrir" && !data.caja_anterior_sin_cerrar && !askedToday) {
      setOpenCash(true);
      setAskedToday(true);
    }
  }, [data, askedToday, touring]);

  async function startClosePrevious() {
    if (!data?.caja_anterior_sin_cerrar) return;
    const res = await getSupabase().rpc("cash_session_summary", { p_session_id: data.caja_anterior_sin_cerrar.session_id });
    if (!res.error) setClosing(res.data as CashSummary);
  }

  if (!data) {
    return st.error
      ? <Alert tone="danger">No se pudo cargar el panel: {st.error} <button className="underline" onClick={st.reload}>Reintentar</button></Alert>
      : <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando panel…</div>;
  }

  const carpa = data.espacios.carpa;
  const sombrilla = data.espacios.sombrilla;
  const total = (carpa?.total_activos ?? 0) + (sombrilla?.total_activos ?? 0);
  const ocupados = (carpa?.ocupados ?? 0) + (sombrilla?.ocupados ?? 0);
  const disponibles = (carpa?.disponibles ?? 0) + (sombrilla?.disponibles ?? 0);
  const mant = (carpa?.mantenimiento ?? 0) + (sombrilla?.mantenimiento ?? 0);
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  const endingWithDebt = data.finalizan_hoy.filter((r) => Number(r.due_amount) > 0);
  const cashIn = Number(cash?.por_medio.efectivo?.entradas ?? 0);
  const cashOut = Number(cash?.por_medio.efectivo?.salidas ?? 0);
  const saldo = Number(data.saldo_pendiente_total ?? st.debts.reduce((s, d) => s + d.due, 0));

  return (
    <div className="flex flex-col gap-4">
      {st.error && <Alert tone="danger">No se pudo actualizar ({st.error}). Los datos pueden estar desactualizados. <button className="underline" onClick={st.reload}>Reintentar</button></Alert>}

      {/* Encabezado: nombre del balneario, resumen del día y el clima */}
      <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#0b6a87] via-[#0a5670] to-[#0d2533] p-5 text-white shadow-sm md:p-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">Panel de control operativo</div>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight md:text-3xl">{ws.name}</h1>
        <p className="mt-1 text-sm text-cyan-50/90">
          {formatDate(data.fecha)} · {carpa?.total_activos ?? 0} carpas y {sombrilla?.total_activos ?? 0} sombrillas · {pct(ocupados)}% de ocupación hoy
          {st.futureCount > 0 ? ` · ${st.futureCount} ${st.futureCount === 1 ? "reserva futura" : "reservas futuras"}` : ""}
        </p>
        <WeatherStrip onDark className="mt-4" />
      </section>

      {/* Avisos prioritarios */}
      {data.caja_anterior_sin_cerrar && (
        <Alert tone="danger" className="flex flex-wrap items-center justify-between gap-2">
          <span>La caja del <strong>{formatDate(data.caja_anterior_sin_cerrar.fecha)}</strong> quedó sin cerrar. Cerrala para poder abrir la de hoy.</span>
          <Button variant="danger" onClick={startClosePrevious}>Cerrar esa caja</Button>
        </Alert>
      )}
      {data.caja.estado === "sin_abrir" && !data.caja_anterior_sin_cerrar && (
        <Alert tone="warn" className="flex flex-wrap items-center justify-between gap-2">
          <span>La caja de hoy no está abierta. Sin caja abierta no se pueden registrar cobros ni gastos.</span>
          <Button onClick={() => setOpenCash(true)}>Abrir caja</Button>
        </Alert>
      )}
      {endingWithDebt.length > 0 && (
        <Alert tone="danger">
          <strong>Atención:</strong> {endingWithDebt.length === 1 ? "un cliente termina" : `${endingWithDebt.length} clientes terminan`} hoy con deuda:{" "}
          {endingWithDebt.map((r) => <Link key={r.reservation_id} href={`/reservas/${r.reservation_id}`} className="underline">{r.customer} ({r.spaces}) {formatMoney(r.due_amount)}</Link>).reduce<ReactNode[]>((acc, el, i) => (i ? [...acc, " · ", el] : [el]), [])}
        </Alert>
      )}

      {/* Indicadores, en dos grupos: la playa y la plata del día */}
      <div data-tour="panel-stats" className="grid gap-4 xl:grid-cols-2">
        <StatGroup title="Hoy en la playa">
          <Stat tone="ok" label="Libres" value={String(disponibles)} note={`${pct(disponibles)}% del balneario${mant ? ` · ${mant} en mantenimiento` : ""}`} icon="M20 6L9 17l-5-5" href="/mapa" />
          <Stat tone="danger" label="Ocupadas" value={String(ocupados)} note={`${pct(ocupados)}% ocupado${(carpa?.cortesias ?? 0) + (sombrilla?.cortesias ?? 0) ? ` · ${(carpa?.cortesias ?? 0) + (sombrilla?.cortesias ?? 0)} cortesía` : ""}`} icon="M3 20h18M6 20V9l6-5 6 5v11" href="/mapa" />
          <Stat tone="accent" label="Llegan hoy" value={String(data.ingresan_hoy.length)} note="Empiezan su estadía" icon="M12 7v5l3 3M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" href="/reservas" />
          <Stat tone="orange" label="Se van hoy" value={String(data.finalizan_hoy.length)} note={endingWithDebt.length ? `${endingWithDebt.length} con deuda` : "Último día"} icon="M12 8v4M12 16h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" href="/reservas" />
        </StatGroup>
        <StatGroup title="La plata de hoy">
          <Stat tone="ok" label="Cobrado" value={formatMoney(data.ingresos_hoy.total)} note={`Efectivo ${formatMoney(data.ingresos_hoy.efectivo)} · Otros ${formatMoney(data.ingresos_hoy.otros_medios)}`} icon="M7 17L17 7M9 7h8v8" href="/cobros" />
          <Stat tone="danger" label="Gastado" value={formatMoney(data.gastos_hoy)} note={cash ? `En efectivo ${formatMoney(cashOut)}` : "Sin caja abierta"} icon="M7 7l10 10M17 9v8H9" href="/gastos" />
          <Stat tone="neutral" label="Efectivo en caja" value={cash ? formatMoney(cash.efectivo_esperado) : "—"} note={cash ? `Movimiento del día ${formatMoney(cashIn - cashOut)}` : "Caja sin abrir"} icon={icon("/caja")} href="/caja" />
          <Stat tone="warn" label="Falta cobrar" value={formatMoney(saldo)} note={`${st.debts.length} ${st.debts.length === 1 ? "reserva con saldo" : "reservas con saldo"}`} icon="M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 2 2.5 4.5 3 4.5 1.3 4.5 3-2 3-4.5 3-4.5-1.3-4.5-3" href="/cobros" />
        </StatGroup>
      </div>

      <div data-tour="semana"><WeekAhead /></div>

      {/* Accesos rápidos: lo que no está en la barra de arriba */}
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-widest text-muted">Accesos rápidos</h2>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Shortcut href="/disponibilidad" tone="orange" icon="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3" title="Disponibilidad" sub="Qué hay libre y cuándo" />
          <Shortcut href="/reservas" tone="violet" icon="M5 12h14M13 6l6 6-6 6" title="Cambiar de carpa" sub="Elegí la reserva" />
          <Shortcut href="/clientes" tone="accent" icon={icon("/clientes")} title="Buscar cliente" sub="Historial y contacto" />
          <Shortcut href="/renovacion" tone="ok" icon={icon("/renovacion")} title="Renovación" sub="Clientes del año pasado" />
          <Shortcut href="/reportes" tone="teal" icon={icon("/reportes")} title="Reportes" sub="Ocupación y plata" />
          <button onClick={() => setSupportOpen(true)} className="flex items-center gap-3 rounded-xl border border-line p-3 text-left hover:bg-surface-2">
            <span className={cx("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", SHORTCUT_TONE.slate)}><Icon d={ICON_HELP} /></span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold">Consultas</span>
              <span className="block truncate text-xs text-muted">Escribinos</span>
            </span>
          </button>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ResCard title={`Inician hoy (${data.ingresan_hoy.length})`} tone="accent" items={data.ingresan_hoy} empty="No hay ingresos previstos para hoy."
          right={(() => {
            const marked = data.ingresan_hoy.filter((r) => arrivals[r.reservation_id]).length;
            return data.ingresan_hoy.length && Object.keys(arrivals).length ? `${marked} de ${data.ingresan_hoy.length} marcados` : formatDate(data.fecha);
          })()}
          arrivals={arrivals} onArrival={(id, v) => setArrivals((a) => ({ ...a, [id]: v }))} />
        <ResCard title={`Finalizan hoy (${data.finalizan_hoy.length})`} tone="orange" items={data.finalizan_hoy} empty="No hay finalizaciones previstas para hoy." right="Liberación de espacios" />
      </div>

      <SupportModal open={supportOpen} onClose={() => setSupportOpen(false)} />
      <OpenCashModal open={openCash} workspaceId={ws.id} onClose={() => setOpenCash(false)} onDone={() => { setOpenCash(false); st.reload(); }} />
      <CloseCashModal open={closing !== null} summary={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); st.reload(); }} />
    </div>
  );
}

function Stat({ tone, label, value, note, icon, href, valueTone }: { tone: Tone; label: string; value: string; note?: string; icon: string; href: string; valueTone?: Tone }) {
  const t = TONE[tone];
  return (
    <Link href={href} className={cx("group rounded-2xl border bg-surface p-4 transition hover:-translate-y-0.5 hover:shadow-md", t.box)}>
      <div className="flex items-start justify-between gap-2">
        <span className={cx("text-sm font-semibold", t.label)}>{label}</span>
        <Icon d={icon} className={cx("h-5 w-5", t.label)} />
      </div>
      <div className={cx("tabular mt-2 truncate text-2xl font-extrabold md:text-3xl xl:text-2xl 2xl:text-3xl", TONE[valueTone ?? tone].value)}>{value}</div>
      {note && <div className="mt-1 text-xs text-muted">{note}</div>}
    </Link>
  );
}

const SHORTCUT_TONE: Record<string, string> = {
  accent: "bg-accent-soft text-accent",
  ok: "bg-ok-soft text-ok",
  danger: "bg-danger-soft text-danger",
  orange: "bg-orange-500/15 text-orange-500",
  violet: "bg-violet-500/15 text-violet-500",
  teal: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
  slate: "bg-surface-2 text-fg",
};

function StatGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-bold uppercase tracking-widest text-muted">{title}</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{children}</div>
    </section>
  );
}

function Shortcut({ href, tone, icon, title, sub }: { href: string; tone: string; icon: string; title: string; sub: string }) {
  return (
    <Link href={href} className="flex items-center gap-3 rounded-xl border border-line p-3 hover:bg-surface-2">
      <span className={cx("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", SHORTCUT_TONE[tone])}><Icon d={icon} /></span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold">{title}</span>
        <span className="block truncate text-xs text-muted">{sub}</span>
      </span>
    </Link>
  );
}

function ResCard({ title, tone, items, empty, right, arrivals, onArrival }: {
  title: string; tone: Tone; items: ResItem[]; empty: string; right: string;
  arrivals?: Record<string, ArrivalState>; onArrival?: (id: string, v: ArrivalState) => void;
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2 border-b border-line pb-2">
        <h2 className={cx("flex items-center gap-2 text-sm font-bold uppercase tracking-wide", TONE[tone].label)}>
          <Icon d="M12 7v5l3 3M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" className="h-4 w-4" />{title}
        </h2>
        <span className="text-xs text-muted">{right}</span>
      </div>
      {items.length === 0 ? <p className="py-6 text-center text-sm text-muted">{empty}</p> : (
        <ul className="flex flex-col gap-2">
          {items.map((r) => {
            const debt = Number(r.due_amount) > 0;
            return (
              <li key={r.reservation_id}>
                <Link href={`/reservas/${r.reservation_id}`}
                  className={cx("flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 text-sm hover:opacity-90",
                    r.is_courtesy ? "border-violet-500/40 bg-violet-500/10" : debt ? "border-danger/40 bg-danger-soft" : "border-ok/40 bg-ok-soft")}>
                  <div className="min-w-0">
                    <div className="truncate font-bold">{r.customer} <span className="font-normal text-muted">· #{r.number}</span></div>
                    <div className="text-xs text-muted">{r.spaces} · {formatDate(r.start_date)} al {formatDate(r.end_date)}{r.phone ? ` · ${r.phone}` : ""}</div>
                  </div>
                  <span className={cx("rounded-full px-2.5 py-1 text-xs font-bold", r.is_courtesy ? "bg-violet-500/20 text-violet-600 dark:text-violet-300" : debt ? "bg-danger text-bg" : "bg-ok text-bg")}>
                    {r.is_courtesy ? "Cortesía" : debt ? `Debe ${formatMoney(r.due_amount)}` : "Pagado"}
                  </span>
                </Link>
                {arrivals && onArrival && r.reservation_id in arrivals && (
                  <div className="mt-1 flex items-center gap-2 pl-1 text-xs text-muted">
                    <span>¿Vino?</span>
                    <ArrivalButtons reservationId={r.reservation_id} state={arrivals[r.reservation_id]} onChanged={(v) => onArrival(r.reservation_id, v)} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
