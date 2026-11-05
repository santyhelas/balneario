"use client";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { addDays, formatMoney, todayISO } from "@/lib/format";
import { debtReminder } from "@/lib/whatsapp-messages";
import { useWorkspace } from "@/components/workspace";
import { useStatus } from "@/components/status";
import { describeSymbol, useWeather, WeatherIcon } from "@/components/weather";
import { Spinner, cx } from "@/components/ui";
import { WhatsAppSend, useMessageTemplates } from "@/components/whatsapp";

type Seg = {
  reservation_id: string; start_date: string; end_date: string;
  spaces: { code: string; kind: "carpa" | "sombrilla" } | null;
  reservations: {
    number: number; start_date: string; end_date: string; is_courtesy: boolean; status: string;
    customers: { first_name: string; last_name: string | null; phone: string | null } | null;
  } | null;
};

type Item = { id: string; number: number; name: string; firstName: string; phone: string | null; places: string; start: string; end: string; due: number; courtesy: boolean };

const WEEKDAY = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * Panel: quién llega, se va o cambia de carpa mañana, y la ocupación de los próximos 7 días
 * con el pronóstico de cada día. Todo sale de las reservas reales.
 */
export function WeekAhead() {
  const { ws } = useWorkspace();
  const st = useStatus();
  const weather = useWeather();
  const sb = getSupabase();
  const today = todayISO(ws.timezone);
  const tomorrow = addDays(today, 1);
  const last = addDays(today, 6);

  const q = useLoader(async () => {
    const segs = unwrap(await sb.from("reservation_segments")
      .select("reservation_id, start_date, end_date, spaces(code, kind), reservations!inner(number, start_date, end_date, is_courtesy, status, customers(first_name, last_name, phone))")
      .eq("workspace_id", ws.id).eq("active", true).eq("reservations.status", "confirmada")
      .lte("start_date", last).gte("end_date", today).limit(5000)) as unknown as Seg[];
    const ids = [...new Set(segs.map((s) => s.reservation_id))];
    const bal = ids.length
      ? (unwrap(await sb.from("reservation_balances").select("reservation_id, due_amount").in("reservation_id", ids)) as { reservation_id: string; due_amount: number }[])
      : [];
    return { segs, due: new Map(bal.map((b) => [b.reservation_id, Number(b.due_amount)])) };
  }, [ws.id, today], 60_000);

  const segs = q.data?.segs ?? [];
  const place = (s: Seg) => `${s.spaces?.kind === "sombrilla" ? "Sombrilla" : "Carpa"} ${s.spaces?.code ?? "?"}`;
  const item = (s: Seg, places: string): Item => ({
    id: s.reservation_id, number: s.reservations?.number ?? 0,
    name: `${s.reservations?.customers?.first_name ?? ""} ${s.reservations?.customers?.last_name ?? ""}`.trim(),
    firstName: s.reservations?.customers?.first_name ?? "", phone: s.reservations?.customers?.phone ?? null,
    places, start: s.reservations?.start_date ?? s.start_date, end: s.reservations?.end_date ?? s.end_date,
    due: q.data?.due.get(s.reservation_id) ?? 0, courtesy: !!s.reservations?.is_courtesy,
  });
  const uniq = (list: Item[]) => [...new Map(list.map((x) => [x.id, x])).values()].sort((a, b) => a.places.localeCompare(b.places, "es", { numeric: true }));

  // Mañana
  const arrivals = uniq(segs.filter((s) => s.reservations?.start_date === tomorrow && s.start_date === tomorrow).map((s) => item(s, place(s))));
  const departures = uniq(segs.filter((s) => s.reservations?.end_date === tomorrow && s.end_date === tomorrow).map((s) => item(s, place(s))));
  const moves = uniq(segs.filter((s) => s.start_date === tomorrow && s.reservations && s.reservations.start_date < tomorrow).map((s) => {
    const before = segs.find((x) => x.reservation_id === s.reservation_id && x.end_date === today);
    return item(s, `${before ? place(before) : "?"} → ${place(s)}`);
  }));

  // Próximos 7 días
  const totalCarpas = st.summary?.espacios.carpa?.total_activos ?? 0;
  const totalSombr = st.summary?.espacios.sombrilla?.total_activos ?? 0;
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i)).map((d) => {
    const on = segs.filter((s) => s.start_date <= d && s.end_date >= d);
    const carpas = on.filter((s) => s.spaces?.kind === "carpa").length;
    const sombr = on.filter((s) => s.spaces?.kind === "sombrilla").length;
    const total = totalCarpas + totalSombr;
    return { d, carpas, sombr, pct: total ? Math.round(((carpas + sombr) / total) * 100) : 0, w: weather.data?.dias?.find((x) => x.fecha === d) };
  });

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <section className="rounded-2xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-center justify-between border-b border-line pb-2">
          <h2 className="text-xs font-bold uppercase tracking-widest">Mañana · {WEEKDAY[new Date(tomorrow + "T12:00:00Z").getUTCDay()]} {dm(tomorrow)}</h2>
          {q.loading && !q.data && <Spinner small />}
        </div>
        <TomorrowList title="Llegan" tone="accent" items={arrivals} empty="No llega nadie." today={today} />
        <TomorrowList title="Se van (último día)" tone="orange" items={departures} empty="No se va nadie." today={today} showDebtWa />
        {moves.length > 0 && <TomorrowList title="Cambian de carpa" tone="violet" items={moves} empty="" today={today} />}
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-center justify-between border-b border-line pb-2">
          <h2 className="text-xs font-bold uppercase tracking-widest">Próximos 7 días</h2>
          <span className="text-xs text-muted">Ocupación y pronóstico</span>
        </div>
        <div className="grid grid-cols-7 gap-1.5">
          {days.map(({ d, carpas, sombr, pct, w }) => {
            const sym = w ? describeSymbol(w.simbolo) : null;
            return (
              <Link key={d} href={`/mapa?dia=${d}`} title={`${dm(d)}: ${carpas} carpas y ${sombr} sombrillas ocupadas (${pct}%)`}
                className={cx("flex flex-col items-center rounded-xl border p-1.5 text-center hover:bg-surface-2", d === today ? "border-accent" : "border-line")}>
                <span className="text-[11px] font-bold">{d === today ? "Hoy" : WEEKDAY[new Date(d + "T12:00:00Z").getUTCDay()]}</span>
                <span className="text-[10px] text-muted">{dm(d)}</span>
                <div className="relative my-1.5 h-20 w-full max-w-8 overflow-hidden rounded-md bg-surface-2">
                  <div className={cx("absolute inset-x-0 bottom-0 rounded-md", pct >= 90 ? "bg-red-500" : pct >= 60 ? "bg-amber-500" : "bg-green-500")} style={{ height: `${Math.max(pct, 2)}%` }} />
                </div>
                <span className="tabular text-xs font-bold">{pct}%</span>
                <span className="tabular text-[10px] text-muted">{carpas + sombr} ocup.</span>
                {w && sym && (
                  <div className="mt-1 flex flex-col items-center" title={`${sym.text}${w.prob != null ? ` · lluvia ${Math.round(w.prob)}%` : ""} · viento hasta ${w.viento_max} km/h`}>
                    <WeatherIcon kind={sym.icon} className="h-7 w-7" />
                    <span className="tabular text-[10px]">{w.tmax ?? "–"}° / <span className="text-muted">{w.tmin ?? "–"}°</span></span>
                    {w.lluvia_mm >= 0.5 && <span className="tabular text-[10px] text-sky-600 dark:text-sky-300">{w.lluvia_mm} mm</span>}
                  </div>
                )}
              </Link>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted">Tocá un día para verlo en el mapa. El pronóstico es de MET Norway: cuanto más lejos el día, menos seguro.</p>
      </section>
    </div>
  );
}

const TONE = { accent: "text-accent", orange: "text-orange-600 dark:text-orange-300", violet: "text-violet-600 dark:text-violet-300" } as const;

function TomorrowList({ title, tone, items, empty, today, showDebtWa = false }: { title: string; tone: keyof typeof TONE; items: Item[]; empty: string; today: string; showDebtWa?: boolean }) {
  const { ws } = useWorkspace();
  const templates = useMessageTemplates();
  return (
    <div className="mb-3 last:mb-0">
      <div className={cx("mb-1 text-xs font-bold uppercase tracking-wide", TONE[tone])}>{title} ({items.length})</div>
      {items.length === 0 ? <p className="text-sm text-muted">{empty}</p> : (
        <ul className="divide-y divide-line text-sm">
          {items.map((x) => {
            const waText = showDebtWa && x.due > 0 ? debtReminder({ firstName: x.firstName, balneario: ws.name, number: x.number, places: x.places, start: x.start, end: x.end, due: x.due, today }, templates) : null;
            return (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <Link href={`/reservas/${x.id}`} className="min-w-0 hover:underline">
                  <span className="font-semibold">{x.places}</span> · {x.name}
                  <span className="block text-xs text-muted">Reserva #{x.number} · del {dm(x.start)} al {dm(x.end)}{x.courtesy ? " · Cortesía" : ""}</span>
                </Link>
                <span className="flex items-center gap-2">
                  {x.due > 0 && <span className="tabular text-xs font-bold text-danger">Debe {formatMoney(x.due)}</span>}
                  {waText && <WhatsAppSend phone={x.phone} text={waText} className="rounded-md px-2 py-1 text-xs" />}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
