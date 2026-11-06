"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { formatDate, formatDateTime, formatMoney, formatTime } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { Button, Spinner, cx } from "@/components/ui";

/** Medios que pasan por el posnet. "tarjeta" es el nombre viejo (antes de separar débito y crédito). */
const CARD_METHODS = ["debito", "credito", "tarjeta"] as const;
const LABEL: Record<string, string> = { debito: "Débito", credito: "Crédito", tarjeta: "Tarjeta" };
const KIND: Record<string, string> = { cobro: "Cobro", devolucion: "Devolución", anulacion_cobro: "Anulación", anulacion_devolucion: "Anul. devolución", otro_ingreso: "Otro ingreso", gasto: "Gasto", anulacion_gasto: "Anul. gasto" };

type Mov = {
  id: string; direction: "entrada" | "salida"; method: string; amount: number; category: string; concept: string; created_at: string;
  payments: { reservations: { number: number; customers: { first_name: string; last_name: string | null } | null } | null } | null;
};
type Session = { id: string; business_date: string; closed_at: string | null };

/**
 * Cierre de tarjetas del día: todos los cobros con débito y crédito de una caja, en formato ticket
 * (impresora térmica de 80 o 58 mm), para comparar con el cierre de lote del posnet.
 */
export default function CierreTarjetasPage() {
  const { ws } = useWorkspace();
  const router = useRouter();
  const sb = getSupabase();
  const [sessionId, setSessionId] = useState<string | null | undefined>(undefined);
  const [paper, setPaper] = useState<80 | 58>(80);

  useEffect(() => {
    setSessionId(new URLSearchParams(window.location.search).get("sesion"));
    try { if (localStorage.getItem("bal_ticket_mm") === "58") setPaper(58); } catch { /* sin almacenamiento */ }
  }, []);

  const q = useLoader(async () => {
    if (sessionId === undefined) return null;
    let s: Session | null;
    if (sessionId) {
      s = unwrap(await sb.from("cash_sessions").select("id, business_date, closed_at").eq("workspace_id", ws.id).eq("id", sessionId).maybeSingle()) as Session | null;
    } else {
      const rows = unwrap(await sb.from("cash_sessions").select("id, business_date, closed_at").eq("workspace_id", ws.id)
        .order("business_date", { ascending: false }).limit(1)) as Session[];
      s = rows[0] ?? null;
    }
    if (!s) return { s: null, movs: [] as Mov[] };
    const movs = unwrap(await sb.from("cash_movements")
      .select("id, direction, method, amount, category, concept, created_at, payments(reservations(number, customers(first_name, last_name)))")
      .eq("cash_session_id", s.id).in("method", [...CARD_METHODS]).order("created_at")) as unknown as Mov[];
    return { s, movs };
  }, [ws.id, sessionId], 0);

  function choosePaper(mm: 80 | 58) {
    setPaper(mm);
    try { localStorage.setItem("bal_ticket_mm", String(mm)); } catch { /* sin almacenamiento */ }
  }

  if (!q.data) return q.error ? <p className="text-danger">{q.error}</p> : <div className="flex items-center gap-2 text-muted"><Spinner small /> Preparando cierre…</div>;
  const { s, movs } = q.data;
  if (!s) return <p className="text-muted">No hay ninguna caja registrada todavía.</p>;

  const signed = (m: Mov) => (m.direction === "entrada" ? 1 : -1) * Number(m.amount);
  const groups = CARD_METHODS.map((k) => {
    const list = movs.filter((m) => m.method === k);
    return { k, list, total: list.reduce((a, m) => a + signed(m), 0), count: list.filter((m) => m.direction === "entrada").length };
  }).filter((g) => g.list.length > 0);
  const total = groups.reduce((a, g) => a + g.total, 0);
  const who = (m: Mov) => {
    const r = m.payments?.reservations;
    if (!r) return m.concept;
    const c = r.customers;
    return `#${r.number} ${c ? `${c.last_name ?? ""} ${c.first_name}`.trim() : ""}`;
  };

  return (
    <div>
      {/* Tamaño de papel solo para esta página. */}
      <style>{`@media print { @page { size: ${paper}mm auto; margin: 2mm; } html, body { background: #fff !important; } }`}</style>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <div className="flex items-center gap-1 text-sm">
          <span className="mr-1 text-muted">Papel:</span>
          {([80, 58] as const).map((mm) => (
            <button key={mm} type="button" onClick={() => choosePaper(mm)}
              className={cx("rounded-lg border px-2.5 py-1", paper === mm ? "border-accent bg-accent/10 font-semibold" : "border-line hover:bg-surface-2")}>{mm} mm</button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => router.back()}>Volver</Button>
          <Button onClick={() => window.print()}>Imprimir</Button>
        </div>
      </div>

      <article style={{ width: `${paper - 6}mm` }}
        className={cx("mx-auto bg-white font-mono text-black shadow print:shadow-none", paper === 58 ? "text-[10px]" : "text-[11px]", "p-2 print:p-0 leading-snug")}>
        <div className="own-print-header text-center">
          {ws.logo_data && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={ws.logo_data} alt="" className="mx-auto mb-1 h-12 w-12 object-contain grayscale" />
          )}
          <div className="text-[13px] font-bold">{ws.name}</div>
          <div className="font-bold">CIERRE DE TARJETAS</div>
          <div>Caja del {formatDate(s.business_date)}</div>
          <div>{s.closed_at ? `Cerrada ${formatDateTime(s.closed_at, ws.timezone)}` : "Caja abierta (parcial)"}</div>
          <div>Impreso {formatDateTime(new Date().toISOString(), ws.timezone)}</div>
        </div>
        <Line />

        {groups.length === 0 && <div className="py-2 text-center">Sin cobros con tarjeta.</div>}
        {groups.map((g) => (
          <div key={g.k} className="mb-1">
            <div className="font-bold">{LABEL[g.k].toUpperCase()}</div>
            {g.list.map((m) => (
              <div key={m.id}>
                <div className="flex justify-between gap-2">
                  <span className="truncate">{formatTime(m.created_at, ws.timezone)} {who(m)}</span>
                  <span className="shrink-0 tabular">{signed(m) < 0 ? "-" : ""}{formatMoney(Math.abs(signed(m)))}</span>
                </div>
                {m.category !== "cobro" && <div className="pl-2">({KIND[m.category] ?? m.category})</div>}
              </div>
            ))}
            <div className="mt-0.5 flex justify-between border-t border-dashed border-black pt-0.5 font-bold">
              <span>Subtotal {LABEL[g.k]} ({g.count} cobros)</span>
              <span className="tabular">{formatMoney(g.total)}</span>
            </div>
          </div>
        ))}
        <Line />
        <div className="flex justify-between text-[13px] font-bold">
          <span>TOTAL TARJETAS</span>
          <span className="tabular">{formatMoney(total)}</span>
        </div>
        <div>Cobros: {groups.reduce((a, g) => a + g.count, 0)}</div>
        <Line />
        <div className="text-center">Comparar con el cierre de lote del posnet.</div>
        <div className="text-center">No válido como factura.</div>
      </article>
      <p className="mt-3 text-center text-xs text-muted print:hidden">
        Al imprimir, elegí la impresora de tickets. Si sale chico o cortado, probá con el otro tamaño de papel.
      </p>
    </div>
  );
}

function Line() {
  return <div className="my-1.5 border-t border-dashed border-black" />;
}
