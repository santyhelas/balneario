"use client";
import { useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase/client";
import { useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDateTime, formatMoney } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { Alert, Badge, ConfirmDialog, EmptyState, Spinner } from "@/components/ui";

export type Voucher = {
  id: string;
  code: string;
  amount: number;
  status: "vigente" | "usado" | "anulado";
  created_at: string;
  used_at: string | null;
  version: number;
  reservation_id: string;
  reservations?: { number: number } | null;
  customers?: { first_name: string; last_name: string } | null;
};

/**
 * Vouchers para el restaurante (créditos que se dan como devolución).
 * Con `reservationId` muestra los de esa reserva; sin él, los vigentes de todo el balneario.
 */
export function VoucherList({ reservationId, reloadKey = 0 }: { reservationId?: string; reloadKey?: number }) {
  const { ws } = useWorkspace();
  const [using, setUsing] = useState<Voucher | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = useLoader<Voucher[] | null>(async () => {
    let query = getSupabase().from("restaurant_vouchers")
      .select("id, code, amount, status, created_at, used_at, version, reservation_id, reservations(number), customers(first_name, last_name)")
      .eq("workspace_id", ws.id).order("created_at", { ascending: false });
    query = reservationId ? query.eq("reservation_id", reservationId) : query.eq("status", "vigente");
    const { data, error } = await query;
    // Sin la actualización 0016 la tabla no existe todavía.
    if (error && (error.code === "42P01" || error.code === "PGRST205")) return null;
    if (error) throw error;
    return data as unknown as Voucher[];
  }, [ws.id, reservationId, reloadKey]);

  async function markUsed() {
    if (!using) return;
    setBusy(true);
    setError(null);
    const { error } = await getSupabase().rpc("use_voucher", { p_voucher_id: using.id, p_expected_version: using.version });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setUsing(null);
    q.reload();
  }

  if (q.data === null) return null;
  if (!q.data) return q.loading ? <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando vouchers…</div> : null;
  if (q.data.length === 0) return reservationId ? null : <EmptyState>No hay vouchers vigentes.</EmptyState>;
  return (
    <>
      <ul className="divide-y divide-line text-sm">
        {q.data.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div>
              <div className="font-mono text-base font-bold tracking-wider">{v.code}</div>
              <div className="text-xs text-muted">
                {!reservationId && v.customers ? `${v.customers.first_name} ${v.customers.last_name} · ` : ""}
                {!reservationId && v.reservations ? <Link className="text-accent underline" href={`/reservas/${v.reservation_id}`}>Reserva #{v.reservations.number}</Link> : null}
                {!reservationId ? " · " : ""}Emitido {formatDateTime(v.created_at, ws.timezone)}
                {v.used_at ? ` · Usado ${formatDateTime(v.used_at, ws.timezone)}` : ""}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="tabular font-semibold">{formatMoney(v.amount)}</span>
              {v.status === "vigente" ? (
                <button className="rounded-lg border border-line px-2 py-1 text-xs hover:bg-surface-2" onClick={() => setUsing(v)}>Marcar usado</button>
              ) : (
                <Badge tone="muted">{v.status === "usado" ? "Usado" : "Anulado"}</Badge>
              )}
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={using !== null}
        title="Voucher usado en el restaurante"
        confirmLabel="Marcar usado"
        busy={busy}
        onCancel={() => { setUsing(null); setError(null); }}
        onConfirm={markUsed}
        message={
          <div className="flex flex-col gap-2">
            <p>El voucher <strong>{using?.code}</strong> por {using ? formatMoney(using.amount) : ""} queda como usado y no se puede volver a usar.</p>
            {error && <Alert tone="danger">{error}</Alert>}
          </div>
        }
      />
    </>
  );
}
