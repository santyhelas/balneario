"use client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { formatDate, formatDateTime, formatMoney, inclusiveDays } from "@/lib/format";
import { METHOD_LABEL } from "@/lib/methods";
import { chargeLabel, loadReservation, spacesSummary, type Full, type PaymentRow } from "@/lib/reservations";
import { useWorkspace } from "@/components/workspace";
import { Button, Spinner, cx } from "@/components/ui";
import { KindName } from "@/lib/space-kinds";

type WsInfo = { name: string; legal_id: string | null; phone: string | null; address: string | null };

const placesOf = (f: Full) =>
  spacesSummary(f.segments).split(" → ").filter(Boolean).map((c) => `${KindName(f.segments.find((s) => s.spaces.code === c)?.spaces.kind)} ${c}`).join(" → ");
const customerOf = (f: Full) => `${f.r.customers.first_name} ${f.r.customers.last_name ?? ""}`.trim();

/** Comprobante imprimible (no es factura). Usar "Imprimir" → "Guardar como PDF" para descargarlo.
 *  Si la reserva es de un grupo (varias carpas reservadas juntas), sale un solo comprobante con todas;
 *  con «Una por carpa» se separa (cada una en su hoja, para que cada familia pague la suya). */
export default function ReciboPage() {
  const { id } = useParams<{ id: string }>();
  const { ws } = useWorkspace();
  const router = useRouter();
  const [canShare, setCanShare] = useState(false);
  const [split, setSplit] = useState(false);
  const [only, setOnly] = useState<string | null>(null);
  useEffect(() => setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function"), []);
  const q = useLoader(async () => {
    const sb = getSupabase();
    const full = await loadReservation(id);
    let group: Full[] = [full];
    if (full.r.group_id) {
      const ids = (unwrap(await sb.from("reservations").select("id, status").eq("group_id", full.r.group_id).order("number")) as { id: string; status: string }[])
        // Del grupo van las confirmadas (y esta, aunque esté cancelada).
        .filter((x) => x.status !== "cancelada" || x.id === id).map((x) => x.id);
      if (ids.length > 1) group = await Promise.all(ids.map((x) => (x === id ? Promise.resolve(full) : loadReservation(x))));
    }
    const info = unwrap(await sb.from("workspaces").select("name, legal_id, phone, address").eq("id", ws.id).single()) as WsInfo;
    return { group, info };
  }, [id], 0);

  if (!q.data) return q.error ? <p className="text-danger">{q.error}</p> : <div className="flex items-center gap-2 text-muted"><Spinner small /> Preparando comprobante…</div>;
  const { group, info } = q.data;
  const isGroup = group.length > 1;
  const shown = only ? group.filter((f) => f.r.id === only) : group;

  const total = shown.reduce((a, f) => a + Number(f.r.total_amount), 0);
  const paid = shown.reduce((a, f) => a + Number(f.balance.paid_amount), 0);
  const due = shown.reduce((a, f) => a + Number(f.balance.due_amount), 0);
  const first = shown[0];
  const numbers = shown.map((f) => `#${f.r.number}`).join(", ");

  function share() {
    const text = [
      `${info.name} · ${shown.length > 1 ? `Reservas ${numbers}` : `Reserva #${first.r.number}`}`,
      customerOf(first),
      shown.map(placesOf).join(", "),
      `Del ${formatDate(minDate(shown))} al ${formatDate(maxDate(shown))}`,
      `Total ${formatMoney(total)} · Abonado ${formatMoney(paid)} · Saldo ${formatMoney(due)}`,
    ].join("\n");
    navigator.share({ title: `Reserva ${numbers}`, text }).catch(() => { /* cancelado */ });
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex flex-wrap items-center justify-end gap-2 print:hidden">
        {isGroup && (
          <div className="mr-auto flex flex-wrap items-center gap-2 text-sm">
            <div className="inline-flex overflow-hidden rounded-lg border border-line" role="radiogroup" aria-label="Cómo sale el comprobante">
              {([[false, "Todas juntas"], [true, "Una por carpa"]] as const).map(([v, t]) => (
                <button key={t} type="button" role="radio" aria-checked={split === v && !only}
                  onClick={() => { setSplit(v); setOnly(null); }}
                  className={cx("px-3 py-1.5", split === v && !only ? "bg-accent text-accent-fg" : "hover:bg-surface-2")}>{t}</button>
              ))}
            </div>
            <select value={only ?? ""} onChange={(e) => setOnly(e.target.value || null)} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm" aria-label="Solo una carpa">
              <option value="">Solo una…</option>
              {group.map((f) => <option key={f.r.id} value={f.r.id}>#{f.r.number} · {placesOf(f)}</option>)}
            </select>
          </div>
        )}
        <Button variant="secondary" onClick={() => router.back()}>Volver</Button>
        {canShare && <Button variant="secondary" onClick={share}>Compartir</Button>}
        <Button onClick={() => window.print()}>Imprimir / PDF</Button>
      </div>

      {isGroup && !split && !only ? (
        <Sheet>
          <Header info={info} title={`Comprobante de reservas ${numbers}`} />
          <section className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
            <div><span className="text-neutral-600">Cliente: </span><strong>{customerOf(first)}</strong></div>
            <div><span className="text-neutral-600">Teléfono: </span>{first.r.customers.phone ?? "—"}</div>
            <div className="sm:col-span-2"><span className="text-neutral-600">Estadía: </span>{formatDate(minDate(shown))} al {formatDate(maxDate(shown))}</div>
            <div className="sm:col-span-2"><span className="text-neutral-600">Lugares ({shown.length}): </span>{shown.map(placesOf).join(", ")}</div>
          </section>
          <table className="mb-4 w-full text-sm">
            <tbody>
              {shown.map((f) => {
                const places = placesOf(f);
                const nDays = inclusiveDays(f.r.start_date, f.r.end_date);
                return [
                  <tr key={`${f.r.id}-h`} className="border-t border-neutral-200"><td className="pt-2 font-semibold" colSpan={2}>{places} · reserva #{f.r.number}{f.r.status === "cancelada" ? " (cancelada)" : ""}</td></tr>,
                  ...f.charges.map((c) => <tr key={c.id}><td className="py-0.5 pl-3">{chargeLabel(c.description, places, nDays)}</td><td className="text-right tabular">{formatMoney(c.amount)}</td></tr>),
                  ...f.discounts.map((d) => <tr key={d.id}><td className="py-0.5 pl-3">{d.label}</td><td className="text-right tabular">− {formatMoney(d.amount)}</td></tr>),
                  <tr key={`${f.r.id}-t`}><td className="py-0.5 pl-3 text-neutral-600">Subtotal {places}</td><td className="text-right tabular text-neutral-600">{formatMoney(f.r.total_amount)}</td></tr>,
                ];
              })}
              <tr className="border-t border-neutral-300 font-semibold"><td className="pt-1">Total</td><td className="pt-1 text-right tabular">{formatMoney(total)}</td></tr>
            </tbody>
          </table>
          <Payments payments={mergePayments(shown)} paid={paid} due={due} tz={ws.timezone} />
          <Footer />
        </Sheet>
      ) : (
        shown.map((f, i) => (
          <Sheet key={f.r.id} className={cx(i > 0 && "mt-6 print:mt-0", i < shown.length - 1 && "print:break-after-page")}>
            <Single f={f} info={info} tz={ws.timezone} />
          </Sheet>
        ))
      )}
    </div>
  );
}

function minDate(list: Full[]) {
  return list.map((f) => f.r.start_date).sort()[0];
}
function maxDate(list: Full[]) {
  return list.map((f) => f.r.end_date).sort().at(-1)!;
}

/** Un pago de grupo se reparte en cada carpa: en el comprobante junto se vuelve a mostrar como uno solo. */
function mergePayments(list: Full[]): (PaymentRow & { voided: boolean })[] {
  const out = new Map<string, PaymentRow & { voided: boolean }>();
  for (const f of list) {
    const voided = new Set(f.payments.filter((p) => p.voids_payment_id).map((p) => p.voids_payment_id));
    for (const p of f.payments) {
      const key = `${p.created_at.slice(0, 19)}|${p.kind}|${p.method}|${voided.has(p.id)}`;
      const prev = out.get(key);
      if (prev) out.set(key, { ...prev, amount: Number(prev.amount) + Number(p.amount), signed_amount: Number(prev.signed_amount) + Number(p.signed_amount) });
      else out.set(key, { ...p, amount: Number(p.amount), signed_amount: Number(p.signed_amount), voided: voided.has(p.id) });
    }
  }
  return [...out.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function Sheet({ children, className }: { children: React.ReactNode; className?: string }) {
  return <article className={cx("rounded-xl border border-line bg-white p-5 text-[#111] sm:p-8 print:border-0 print:p-0", className)}>{children}</article>;
}

function Header({ info, title }: { info: WsInfo; title: string }) {
  const { ws } = useWorkspace();
  return (
    <header className="own-print-header mb-6 flex items-start justify-between gap-4 border-b border-neutral-300 pb-4">
      {ws.logo_data && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={ws.logo_data} alt="" className="h-14 w-14 shrink-0 object-contain" />
      )}
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-bold">{info.name}</h1>
        <p className="text-sm text-neutral-600">{[info.address, info.phone, info.legal_id ? `CUIT ${info.legal_id}` : null].filter(Boolean).join(" · ")}</p>
      </div>
      <div className="text-right text-sm">
        <div className="font-semibold">{title}</div>
        <div className="text-neutral-600">Emitido el {formatDateTime(new Date().toISOString(), ws.timezone)}</div>
      </div>
    </header>
  );
}

function Payments({ payments, paid, due, tz }: { payments: (PaymentRow & { voided: boolean })[]; paid: number; due: number; tz: string }) {
  return (
    <>
      <h2 className="mb-1 text-sm font-semibold">Pagos</h2>
      <table className="mb-4 w-full text-sm">
        <tbody>
          {payments.length === 0 && <tr><td className="text-neutral-600">Sin pagos registrados.</td></tr>}
          {payments.map((p) => (
            <tr key={p.id} className={p.voided ? "text-neutral-400 line-through" : ""}>
              <td className="py-0.5">{formatDateTime(p.created_at, tz)} · {p.kind === "cobro" ? "Pago" : p.kind === "devolucion" ? "Devolución" : "Anulación"} · {METHOD_LABEL[p.method] ?? p.method}</td>
              <td className="text-right tabular">{Number(p.signed_amount) >= 0 ? "" : "− "}{formatMoney(p.amount)}</td>
            </tr>
          ))}
          <tr className="border-t border-neutral-300"><td className="pt-1">Total abonado</td><td className="pt-1 text-right tabular">{formatMoney(paid)}</td></tr>
          <tr className="font-semibold"><td>Saldo pendiente</td><td className="text-right tabular">{formatMoney(due)}</td></tr>
        </tbody>
      </table>
    </>
  );
}

function Footer() {
  return <p className="text-xs text-neutral-500">Comprobante interno de reserva. No válido como factura.</p>;
}

/** Comprobante de una sola reserva (una carpa). */
function Single({ f, info, tz }: { f: Full; info: WsInfo; tz: string }) {
  const { r, segments, charges, discounts, payments, balance } = f;
  const places = placesOf(f);
  const nDays = inclusiveDays(r.start_date, r.end_date);
  const voided = new Set(payments.filter((p) => p.voids_payment_id).map((p) => p.voids_payment_id));
  return (
    <>
      <Header info={info} title={`Comprobante de reserva #${r.number}`} />
      <section className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
        <div><span className="text-neutral-600">Cliente: </span><strong>{customerOf(f)}</strong></div>
        <div><span className="text-neutral-600">Teléfono: </span>{r.customers.phone ?? "—"}</div>
        <div><span className="text-neutral-600">Estadía: </span>{formatDate(r.start_date)} al {formatDate(r.end_date)} ({nDays} días)</div>
        <div><span className="text-neutral-600">Estado: </span>{r.status === "cancelada" ? "Cancelada" : r.is_courtesy ? "Cortesía" : "Confirmada"}</div>
        <div className="sm:col-span-2"><span className="text-neutral-600">Ubicación: </span>{segments.map((s) => `${KindName(s.spaces.kind)} ${s.spaces.code} (${formatDate(s.start_date)} al ${formatDate(s.end_date)})`).join(" · ") || "—"}</div>
      </section>
      <table className="mb-4 w-full text-sm">
        <tbody>
          {charges.map((c) => <tr key={c.id}><td className="py-0.5">{chargeLabel(c.description, places, nDays)}</td><td className="text-right tabular">{formatMoney(c.amount)}</td></tr>)}
          {discounts.map((d) => <tr key={d.id}><td className="py-0.5">{d.label}</td><td className="text-right tabular">− {formatMoney(d.amount)}</td></tr>)}
          <tr className="border-t border-neutral-300 font-semibold"><td className="pt-1">Total</td><td className="pt-1 text-right tabular">{formatMoney(r.total_amount)}</td></tr>
        </tbody>
      </table>
      <Payments payments={payments.map((p) => ({ ...p, voided: voided.has(p.id) }))} paid={Number(balance.paid_amount)} due={Number(balance.due_amount)} tz={tz} />
      <Footer />
    </>
  );
}
