"use client";
import { useParams } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { formatDate, formatDateTime, formatMoney, inclusiveDays } from "@/lib/format";
import { METHOD_LABEL } from "@/lib/methods";
import { loadReservation } from "@/lib/reservations";
import { useWorkspace } from "@/components/workspace";
import { Button, Spinner } from "@/components/ui";

type WsInfo = { name: string; legal_id: string | null; phone: string | null; address: string | null };

/** Comprobante imprimible (no es factura). Usar "Imprimir" → "Guardar como PDF" para descargarlo. */
export default function ReciboPage() {
  const { id } = useParams<{ id: string }>();
  const { ws } = useWorkspace();
  const q = useLoader(async () => {
    const full = await loadReservation(id);
    const info = unwrap(await getSupabase().from("workspaces").select("name, legal_id, phone, address").eq("id", ws.id).single()) as WsInfo;
    return { full, info };
  }, [id], 0);

  if (!q.data) return q.error ? <p className="text-danger">{q.error}</p> : <div className="flex items-center gap-2 text-muted"><Spinner small /> Preparando comprobante…</div>;
  const { full, info } = q.data;
  const { r, segments, charges, discounts, payments, balance } = full;
  const voided = new Set(payments.filter((p) => p.voids_payment_id).map((p) => p.voids_payment_id));

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex justify-end gap-2 print:hidden">
        <Button variant="secondary" onClick={() => window.close()}>Cerrar</Button>
        <Button onClick={() => window.print()}>Imprimir / Guardar PDF</Button>
      </div>
      <article className="rounded-xl border border-line bg-white p-8 text-[#111] print:border-0 print:p-0">
        <header className="mb-6 flex items-start justify-between gap-4 border-b border-neutral-300 pb-4">
          <div>
            <h1 className="text-xl font-bold">{info.name}</h1>
            <p className="text-sm text-neutral-600">{[info.address, info.phone, info.legal_id ? `CUIT ${info.legal_id}` : null].filter(Boolean).join(" · ")}</p>
          </div>
          <div className="text-right text-sm">
            <div className="font-semibold">Comprobante de reserva #{r.number}</div>
            <div className="text-neutral-600">Emitido {formatDateTime(new Date().toISOString(), ws.timezone)}</div>
          </div>
        </header>
        <section className="mb-4 grid grid-cols-2 gap-2 text-sm">
          <div><span className="text-neutral-600">Cliente: </span><strong>{r.customers.first_name} {r.customers.last_name}</strong></div>
          <div><span className="text-neutral-600">Teléfono: </span>{r.customers.phone ?? "—"}</div>
          <div><span className="text-neutral-600">Estadía: </span>{formatDate(r.start_date)} al {formatDate(r.end_date)} ({inclusiveDays(r.start_date, r.end_date)} días)</div>
          <div><span className="text-neutral-600">Estado: </span>{r.status === "cancelada" ? "Cancelada" : r.is_courtesy ? "Cortesía" : "Confirmada"}</div>
          <div className="col-span-2"><span className="text-neutral-600">Ubicación: </span>{segments.map((s) => `${s.spaces.kind === "carpa" ? "Carpa" : "Sombrilla"} ${s.spaces.code} (${formatDate(s.start_date)} al ${formatDate(s.end_date)})`).join(" · ") || "—"}</div>
        </section>
        <table className="mb-4 w-full text-sm">
          <tbody>
            {charges.map((c) => <tr key={c.id}><td className="py-0.5">{c.description}</td><td className="text-right tabular">{formatMoney(c.amount)}</td></tr>)}
            {discounts.map((d) => <tr key={d.id}><td className="py-0.5">{d.label}</td><td className="text-right tabular">− {formatMoney(d.amount)}</td></tr>)}
            <tr className="border-t border-neutral-300 font-semibold"><td className="pt-1">Total</td><td className="pt-1 text-right tabular">{formatMoney(r.total_amount)}</td></tr>
          </tbody>
        </table>
        <h2 className="mb-1 text-sm font-semibold">Pagos</h2>
        <table className="mb-4 w-full text-sm">
          <tbody>
            {payments.length === 0 && <tr><td className="text-neutral-600">Sin pagos registrados.</td></tr>}
            {payments.map((p) => (
              <tr key={p.id} className={voided.has(p.id) ? "text-neutral-400 line-through" : ""}>
                <td className="py-0.5">{formatDateTime(p.created_at, ws.timezone)} · {p.kind === "cobro" ? "Pago" : p.kind === "devolucion" ? "Devolución" : "Anulación"} · {METHOD_LABEL[p.method] ?? p.method}</td>
                <td className="text-right tabular">{Number(p.signed_amount) >= 0 ? "" : "− "}{formatMoney(p.amount)}</td>
              </tr>
            ))}
            <tr className="border-t border-neutral-300"><td className="pt-1">Total abonado</td><td className="pt-1 text-right tabular">{formatMoney(balance.paid_amount)}</td></tr>
            <tr className="font-semibold"><td>Saldo pendiente</td><td className="text-right tabular">{formatMoney(balance.due_amount)}</td></tr>
          </tbody>
        </table>
        <p className="text-xs text-neutral-500">Comprobante interno de reserva. No válido como factura.</p>
      </article>
    </div>
  );
}
