"use client";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { cx } from "@/components/ui";

export type ArrivalState = "llego" | "no_vino" | null;

export const ARRIVAL_LABEL: Record<"llego" | "no_vino", string> = { llego: "Llegó", no_vino: "No vino" };

/**
 * Botones "Llegó" / "No vino" de una reserva. Solo registra la llegada:
 * no toca pagos ni deudas y no libera la carpa. Tocar de nuevo el marcado lo quita.
 */
export function ArrivalButtons({ reservationId, state, onChanged, className }: {
  reservationId: string; state: ArrivalState; onChanged: (s: ArrivalState) => void; className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function set(next: ArrivalState) {
    setBusy(true);
    setError(null);
    const { error: err } = await getSupabase().rpc("set_arrival", { p_reservation_id: reservationId, p_state: next });
    setBusy(false);
    if (err) {
      // Sin la actualización 0025 la función no existe todavía.
      setError(err.code === "PGRST202" ? "Falta aplicar la actualización 0025." : friendlyError(err));
      return;
    }
    onChanged(next);
  }

  const btn = (value: "llego" | "no_vino") => {
    const on = state === value;
    return (
      <button type="button" disabled={busy} onClick={() => set(on ? null : value)} aria-pressed={on}
        title={on ? "Tocá para quitar la marca" : undefined}
        className={cx("rounded-md border px-2.5 py-1 text-xs font-semibold disabled:opacity-60",
          on && value === "llego" && "border-ok bg-ok text-bg",
          on && value === "no_vino" && "border-danger bg-danger text-bg",
          !on && "border-line bg-surface hover:bg-surface-2")}>
        {ARRIVAL_LABEL[value]}
      </button>
    );
  };

  return (
    <span className={cx("inline-flex flex-wrap items-center gap-1.5", className)}>
      {btn("llego")}
      {btn("no_vino")}
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const ars = (n: number) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 2 }).format(n);
const addDay = (iso: string, n: number) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Qué hacer cuando el cliente no vino: liberar la carpa ese día y, si el administrador quiere,
 * descontar el día del precio. La reserva nunca se cancela.
 */
export function NoShowPanel({ r, today, isAdmin, releasedDays, discountedDays, noShowDiscounts, hasSpaceOn, onDone }: {
  r: { id: string; start_date: string; end_date: string; total_amount: number; is_courtesy: boolean };
  today: string; isAdmin: boolean;
  /** Días ya liberados por "no vino". */
  releasedDays: string[];
  /** Días ya descontados. */
  discountedDays: string[];
  /** Suma de los descuentos por "no vino" ya hechos (para calcular lo que vale un día). */
  noShowDiscounts: number;
  hasSpaceOn: (day: string) => boolean;
  onDone: (msg: string) => void;
}) {
  const oneDay = r.start_date === r.end_date;
  const lastAllowed = r.end_date < today ? r.end_date : today;
  const [day, setDay] = useState(lastAllowed);
  const [busy, setBusy] = useState<null | "liberar" | "descontar">(null);
  const [error, setError] = useState<string | null>(null);
  const nDays = Math.round((Date.parse(r.end_date) - Date.parse(r.start_date)) / 86_400_000) + 1;
  const dayValue = Math.min(Math.round(((Number(r.total_amount) + noShowDiscounts) / nDays) * 100) / 100, Number(r.total_amount));
  const released = releasedDays.includes(day);
  const discounted = discountedDays.includes(day);

  async function run(discount: boolean) {
    setBusy(discount ? "descontar" : "liberar");
    setError(null);
    const { data, error: err } = await getSupabase().rpc("release_no_show_day", { p_reservation_id: r.id, p_day: day, p_discount: discount });
    setBusy(null);
    if (err) return setError(err.code === "PGRST202" ? "Falta aplicar la actualización 0026." : friendlyError(err));
    const off = Number((data as { descuento?: number })?.descuento ?? 0);
    onDone(discount ? `Se descontó el ${dmy(day)}: ${ars(off)} menos.` : `La carpa quedó libre el ${dmy(day)}.`);
  }

  return (
    <div className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm">
      <div className="font-semibold">No vino</div>
      {releasedDays.length > 0 && (
        <p className="text-xs text-muted">Días liberados: {[...releasedDays].sort().map(dmy).join(", ")}{discountedDays.length ? ` · descontados: ${[...discountedDays].sort().map(dmy).join(", ")}` : ""}</p>
      )}
      {oneDay ? (
        <p className="mt-1">{released ? "La carpa ya quedó libre ese día." : "La carpa todavía figura ocupada."} La reserva no se cancela.</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span>Día que no vino:</span>
          <input type="date" value={day} min={r.start_date} max={lastAllowed} onChange={(e) => e.target.value && setDay(e.target.value)}
            className="rounded-md border border-line bg-surface px-2 py-1 text-sm" aria-label="Día que no vino" />
          {day !== r.start_date && day > r.start_date && <button type="button" className="text-xs text-accent hover:underline" onClick={() => setDay(addDay(day, -1))}>día anterior</button>}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {!released && hasSpaceOn(day) && (
          <button type="button" disabled={busy !== null} onClick={() => run(false)}
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-semibold hover:bg-surface-2 disabled:opacity-60">
            {busy === "liberar" ? "Liberando…" : `Liberar la carpa el ${dmy(day).slice(0, 5)}`}
          </button>
        )}
        {isAdmin && !r.is_courtesy && !discounted && dayValue > 0 && (
          <button type="button" disabled={busy !== null} onClick={() => run(true)}
            className="rounded-md border border-danger/50 bg-surface px-3 py-1.5 text-sm font-semibold text-danger hover:bg-surface-2 disabled:opacity-60">
            {busy === "descontar" ? "Descontando…" : `${released ? "" : "Liberar y "}descontar el día (−${ars(dayValue)})`}
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">
        {oneDay ? "Si después resulta que vino, marcá «Llegó» y la carpa vuelve a quedar ocupada (si nadie la tomó)." : "La reserva sigue para los otros días."}
        {" "}El descuento es lo que vale un día de esta reserva (total ÷ {nDays} días) y no se deshace solo.
      </p>
      {error && <p className="mt-1 text-xs font-medium text-danger">{error}</p>}
    </div>
  );
}
