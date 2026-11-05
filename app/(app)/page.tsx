"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { formatDate, formatMoney } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { useStatus, type ResItem, type Notice } from "@/components/status";
import { WeekAhead } from "@/components/week-ahead";
import { Icon, NAV } from "@/components/shell";
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
  const { ws, isGuest } = useWorkspace();
  const st = useStatus();
  const data = st.summary;
  // En la demo, el pedido de abrir la caja espera a que termine el tutorial.
  const touring = useTourActive(isGuest);
  const [cash, setCash] = useState<CashSummary | null>(null);
  const [openCash, setOpenCash] = useState(false);
  const [askedToday, setAskedToday] = useState(false);
  const [closing, setClosing] = useState<CashSummary | null>(null);

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

      {/* Banner con el nombre del balneario */}
      <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#0b6a87] via-[#0a5670] to-[#0d2533] p-5 text-white shadow-sm md:p-7">
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="max-w-2xl">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">Panel de control operativo</div>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight md:text-3xl">{ws.name}</h1>
            <p className="mt-1 text-sm text-cyan-50/90">
              {formatDate(data.fecha)} · {carpa?.total_activos ?? 0} carpas y {sombrilla?.total_activos ?? 0} sombrillas activas · {pct(ocupados)}% de ocupación hoy.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/reservas/nueva" className="flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-[#0b6a87] hover:opacity-90"><Icon d="M12 5v14M5 12h14" className="h-4 w-4" />Crear reserva</Link>
            <Link href="/mapa" className="flex items-center gap-2 rounded-xl border border-white/40 bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/20"><Icon d={icon("/mapa")} className="h-4 w-4" />Ver mapa</Link>
            <Link href="/caja" className="flex items-center gap-2 rounded-xl border border-white/40 bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/20"><Icon d={icon("/caja")} className="h-4 w-4" />Caja diaria</Link>
          </div>
        </div>
      </section>

      <WeatherStrip />

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

      {/* Indicadores */}
      <div data-tour="panel-stats" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat tone="neutral" label="Total espacios" value={String(total)} note={`${carpa?.total_activos ?? 0} carpas · ${sombrilla?.total_activos ?? 0} sombrillas${mant ? ` · ${mant} en mant.` : ""}`} icon={icon("/mapa")} href="/mapa" />
        <Stat tone="ok" label="Disponibles hoy" value={String(disponibles)} note={`${pct(disponibles)}% del balneario libre`} icon="M20 6L9 17l-5-5" href="/mapa" />
        <Stat tone="danger" label="Ocupados hoy" value={String(ocupados)} note={`${pct(ocupados)}% de ocupación${(carpa?.cortesias ?? 0) + (sombrilla?.cortesias ?? 0) ? ` · ${(carpa?.cortesias ?? 0) + (sombrilla?.cortesias ?? 0)} cortesía` : ""}`} icon="M3 20h18M6 20V9l6-5 6 5v11" href="/mapa" />
        <Stat tone="warn" label="Reservas futuras" value={String(st.futureCount)} note="Confirmadas, aún no ingresan" icon={icon("/disponibilidad")} href="/reservas" />
        <Stat tone="accent" label="Inician hoy" value={String(data.ingresan_hoy.length)} note="Ingresos programados" icon="M12 7v5l3 3M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" href="/reservas" />
        <Stat tone="orange" label="Terminan hoy" value={String(data.finalizan_hoy.length)} note={endingWithDebt.length ? `${endingWithDebt.length} con deuda` : "Salidas del día"} icon="M12 8v4M12 16h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" href="/reservas" />
        <Stat tone="neutral" label="Cobros del día" value={formatMoney(data.ingresos_hoy.total)} valueTone="ok" note={`Efvo: ${formatMoney(data.ingresos_hoy.efectivo)} · Otros: ${formatMoney(data.ingresos_hoy.otros_medios)}`} icon="M7 17L17 7M9 7h8v8" href="/cobros" />
        <Stat tone="neutral" label="Gastos del día" value={formatMoney(data.gastos_hoy)} valueTone="danger" note={cash ? `Salidas en efectivo: ${formatMoney(cashOut)}` : "Sin caja abierta"} icon="M7 7l10 10M17 9v8H9" href="/gastos" />
        <Stat tone="neutral" label="Flujo neto caja (efvo)" value={cash ? formatMoney(cashIn - cashOut) : "—"} note={cash ? `En caja: ${formatMoney(cash.efectivo_esperado)}` : "Caja sin abrir"} icon={icon("/caja")} href="/caja" />
        <Stat tone="danger" label="Saldos a cobrar" value={formatMoney(saldo)} note={`${st.debts.length} ${st.debts.length === 1 ? "reserva adeudada" : "reservas adeudadas"}`} icon="M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 2 2.5 4.5 3 4.5 1.3 4.5 3-2 3-4.5 3-4.5-1.3-4.5-3" href="/cobros" />
      </div>

      <div data-tour="semana"><WeekAhead /></div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* Accesos directos */}
        <section className="rounded-2xl border border-line bg-surface p-4">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-widest text-muted">Accesos directos operativos</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <Shortcut href="/reservas/nueva" tone="accent" icon="M12 5v14M5 12h14" title="Nueva reserva" sub="Asignar carpa o sombrilla" />
            <Shortcut href="/cobros" tone="ok" icon={icon("/cobros")} title="Registrar cobro" sub="Seña o saldo pendiente" />
            <Shortcut href="/gastos?nuevo=1" tone="danger" icon="M5 12h14" title="Registrar gasto" sub="Insumos, personal, servicios" />
            <Shortcut href="/disponibilidad" tone="orange" icon="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3" title="Consultar disponibilidad" sub="Planificación por fechas" />
            <Shortcut href="/reservas" tone="violet" icon="M5 12h14M13 6l6 6-6 6" title="Cambiar ubicación" sub="Elegí la reserva y reubicá" />
            <Shortcut href="/caja" tone="teal" icon={icon("/caja")} title="Caja diaria" sub="Arqueo y movimientos" />
          </div>
        </section>

        {/* Notificaciones */}
        <section className="rounded-2xl border border-line bg-surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-widest">Notificaciones operativas</h2>
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold">{st.notices.filter((n) => n.tone !== "info").length} activas</span>
          </div>
          <NoticeList notices={st.notices.filter((n) => n.tone !== "info")} />
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ResCard title={`Inician hoy (${data.ingresan_hoy.length})`} tone="accent" items={data.ingresan_hoy} empty="No hay ingresos previstos para hoy."
          right={(() => {
            const marked = data.ingresan_hoy.filter((r) => arrivals[r.reservation_id]).length;
            return data.ingresan_hoy.length && Object.keys(arrivals).length ? `${marked} de ${data.ingresan_hoy.length} marcados` : formatDate(data.fecha);
          })()}
          arrivals={arrivals} onArrival={(id, v) => setArrivals((a) => ({ ...a, [id]: v }))} />
        <ResCard title={`Finalizan hoy (${data.finalizan_hoy.length})`} tone="orange" items={data.finalizan_hoy} empty="No hay finalizaciones previstas para hoy." right="Liberación de espacios" />
      </div>

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
      <div className={cx("tabular mt-2 truncate text-2xl font-extrabold md:text-3xl", TONE[valueTone ?? tone].value)}>{value}</div>
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
};

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

function NoticeList({ notices }: { notices: Notice[] }) {
  const { markRead } = useStatus();
  if (notices.length === 0) return <p className="rounded-lg border border-dashed border-line py-6 text-center text-sm text-muted">Todo en orden: sin avisos pendientes.</p>;
  const cls = { danger: "border-danger/40 bg-danger-soft", warn: "border-warn/40 bg-warn-soft", info: "border-accent/30 bg-accent-soft" };
  const dot = { danger: "bg-danger", warn: "bg-warn", info: "bg-accent" };
  return (
    <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
      {notices.map((n) => (
        <li key={n.id}>
          <Link href={n.href} onClick={() => markRead([n.id])} className={cx("block rounded-xl border p-3 hover:opacity-90", cls[n.tone])}>
            <div className="flex items-center gap-2 text-sm font-bold"><span className={cx("h-2 w-2 shrink-0 rounded-full", dot[n.tone])} />{n.title}</div>
            <div className="pl-4 text-xs text-muted">{n.detail}</div>
          </Link>
        </li>
      ))}
    </ul>
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
