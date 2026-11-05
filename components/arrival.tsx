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
