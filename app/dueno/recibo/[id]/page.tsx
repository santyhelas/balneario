"use client";
import { useParams } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { formatDate, formatMoney } from "@/lib/format";
import { Button, Spinner } from "@/components/ui";

type Receipt = { numero: number; balneario: string; correo: string | null; importe: number; fecha: string; concepto: string | null; emitido: string;
  emisor: { nombre: string | null; cuit: string | null; alias: string | null } };

/** Recibo de un pago de un balneario. Se imprime o se guarda como PDF desde el navegador. */
export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const q = useLoader(async () => unwrap(await getSupabase().rpc("admin_receipt", { p_event_id: id })) as Receipt, [id], 0);
  const r = q.data;
  if (!r) return q.error ? <p className="text-danger">{q.error}</p> : <div className="flex items-center gap-2 text-muted"><Spinner small /> Armando el recibo…</div>;
  const num = String(r.numero).padStart(6, "0");
  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <p className="text-sm text-muted">Tocá «Imprimir» y elegí «Guardar como PDF» para mandarlo.</p>
        <Button onClick={() => { document.title = `Recibo ${num} - ${r.balneario}`; window.print(); }}>Imprimir / Guardar PDF</Button>
      </div>
      <article className="rounded-2xl border border-line bg-white p-8 text-[#1f2a30] shadow-sm print:border-0 print:p-0 print:shadow-none">
        <header className="flex items-start justify-between gap-4 border-b border-[#e5dcc8] pb-5">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" className="h-14 w-14 rounded-xl" />
            <div>
              <div className="text-xl font-extrabold">{r.emisor.nombre || "Mi Balneario"}</div>
              {r.emisor.cuit && <div className="text-xs text-[#5b666c]">CUIT {r.emisor.cuit}</div>}
              <div className="text-xs text-[#5b666c]">mibalneario.com.ar</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-widest text-[#5b666c]">Recibo</div>
            <div className="text-2xl font-bold tabular">N° {num}</div>
            <div className="text-xs text-[#5b666c]">{formatDate(r.fecha.slice(0, 10))}</div>
          </div>
        </header>
        <section className="py-6 text-sm leading-relaxed">
          <p>Recibí de <strong>{r.balneario}</strong>{r.correo && !r.correo.endsWith(".local") ? ` (${r.correo})` : ""} la suma de:</p>
          <p className="my-4 rounded-xl bg-[#f6eedb] px-4 py-3 text-center text-3xl font-extrabold tabular">{formatMoney(r.importe)}</p>
          <p>En concepto de: <strong>{r.concepto || "Plan del sistema Mi Balneario"}</strong>.</p>
        </section>
        <footer className="flex items-end justify-between gap-4 border-t border-[#e5dcc8] pt-5 text-xs text-[#5b666c]">
          <span>Comprobante de pago. No válido como factura.</span>
          <span className="w-48 border-t border-[#1f2a30] pt-1 text-center">Firma</span>
        </footer>
      </article>
    </div>
  );
}
