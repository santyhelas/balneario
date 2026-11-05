"use client";
import Link from "next/link";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { formatDate, formatDateTime, formatMoney, inclusiveDays, todayISO } from "@/lib/format";
import { METHOD_LABEL } from "@/lib/methods";
import { useWorkspace } from "@/components/workspace";
import { useStatus } from "@/components/status";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, EmptyState, Input, Spinner, cx } from "@/components/ui";
import { PaymentModal } from "@/components/payments";
import { debtReminder } from "@/lib/whatsapp-messages";
import { WhatsAppSend, useMessageTemplates } from "@/components/whatsapp";
import { VoucherList } from "@/components/vouchers";

type DebtRow = {
  id: string; number: number; start_date: string; end_date: string; total_amount: number;
  customers: { first_name: string; last_name: string; phone: string | null };
  reservation_segments?: { active: boolean; start_date: string; spaces: { code: string; kind: string } | null }[];
  due: number; paid: number;
};
type PayRow = {
  id: string; kind: string; amount: number; signed_amount: number; method: string; created_at: string; voids_payment_id: string | null; usd_amount?: number | null;
  reservations: { id: string; number: number; customers: { first_name: string; last_name: string } };
};

export default function CobrosPage() {
  const { ws } = useWorkspace();
  const status = useStatus();
  const sb = getSupabase();
  const today = todayISO(ws.timezone);
  const templates = useMessageTemplates();
  const [q, setQ] = useState("");
  const [paying, setPaying] = useState<DebtRow | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [sort, setSort] = useState<"dias" | "deuda">("dias");

  const data = useLoader(async () => {
    const bal = unwrap(await sb.from("reservation_balances").select("reservation_id, due_amount, paid_amount").eq("workspace_id", ws.id).gt("due_amount", 0)) as { reservation_id: string; due_amount: number; paid_amount: number }[];
    let debts: DebtRow[] = [];
    if (bal.length) {
      const rows = unwrap(await sb.from("reservations").select("id, number, start_date, end_date, total_amount, customers(first_name, last_name, phone), reservation_segments(active, start_date, spaces(code, kind))").in("id", bal.map((b) => b.reservation_id))) as unknown as Omit<DebtRow, "due" | "paid">[];
      const m = new Map(bal.map((b) => [b.reservation_id, b]));
      debts = rows.map((r) => ({ ...r, due: Number(m.get(r.id)!.due_amount), paid: Number(m.get(r.id)!.paid_amount) }))
        .sort((a, b) => a.end_date.localeCompare(b.end_date));
    }
    const payments = unwrap(await sb.from("payments").select("*, reservations(id, number, customers(first_name, last_name))")
      .eq("workspace_id", ws.id).order("created_at", { ascending: false }).limit(40)) as unknown as PayRow[];
    return { debts, payments };
  }, [ws.id]);

  const term = q.trim().toLowerCase();
  // Días que faltan para que termine la estadía (0 = termina hoy, negativo = ya terminó).
  const daysLeft = (end: string) => (end >= today ? inclusiveDays(today, end) - 1 : -(inclusiveDays(end, today) - 1));
  const debts = (data.data?.debts ?? [])
    .filter((d) => !term || `${d.customers.first_name} ${d.customers.last_name} ${d.number}`.toLowerCase().includes(term))
    .sort((a, b) => sort === "deuda" ? b.due - a.due : daysLeft(a.end_date) - daysLeft(b.end_date) || b.due - a.due);
  const totalDue = (data.data?.debts ?? []).reduce((s, d) => s + d.due, 0);
  const cajaAbierta = status.summary?.caja.estado === "abierta" && !status.summary?.caja_anterior_sin_cerrar;

  return (
    <>
      <PageHeader title="Cobros y señas" subtitle="Reservas con saldo pendiente y últimos pagos registrados." actions={<Link href="/reservas/nueva"><Button variant="secondary">Nueva reserva</Button></Link>} />
      <SyncNotice error={data.error} stale={data.stale} updatedAt={data.updatedAt} onRetry={data.reload} />
      {msg && <Alert tone="ok" className="mb-3">{msg}</Alert>}
      {!cajaAbierta && status.summary && <Alert tone="warn" className="mb-3">Para registrar cobros la caja del día tiene que estar abierta. <Link href="/caja" className="underline">Ir a caja</Link></Alert>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card
          title={<>Saldos pendientes <span className="ml-2 text-base font-normal text-danger">{formatMoney(totalDue)}</span></>}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex overflow-hidden rounded-lg border border-line text-xs" role="group" aria-label="Ordenar">
                {([["dias", "Días restantes"], ["deuda", "Mayor deuda"]] as const).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setSort(k)} aria-pressed={sort === k}
                    className={cx("px-2.5 py-1.5 font-medium", sort === k ? "bg-accent text-accent-fg" : "bg-surface hover:bg-surface-2")}>{l}</button>
                ))}
              </div>
              <Input type="search" placeholder="Buscar cliente o N°" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-48" aria-label="Buscar" />
            </div>
          }
        >
          {data.loading && !data.data ? <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando…</div>
            : debts.length === 0 ? <EmptyState>{term ? "Sin resultados." : "No hay saldos pendientes. ¡Todo cobrado!"}</EmptyState> : (
            <ul className="flex flex-col gap-2">
              {debts.map((d) => {
                const left = daysLeft(d.end_date);
                const ending = left === 0;
                const past = left < 0;
                const soon = left === 1 || left === 2;
                return (
                  <li key={d.id} className={cx("flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3", ending || past ? "border-danger/40 bg-danger-soft" : soon ? "border-warn/50 bg-warn-soft" : "border-line")}>
                    <div className="min-w-0">
                      <Link href={`/reservas/${d.id}`} className="font-semibold hover:underline">{d.customers.first_name} {d.customers.last_name} <span className="font-normal text-muted">· #{d.number}</span></Link>
                      <div className="text-xs text-muted">
                        {formatDate(d.start_date)} al {formatDate(d.end_date)} · Total {formatMoney(d.total_amount)} · Pagó {formatMoney(d.paid)}
                        {" · "}
                        {ending ? <strong className="text-danger">Termina hoy</strong>
                          : past ? <strong className="text-danger">Terminó hace {-left} {left === -1 ? "día" : "días"}</strong>
                          : d.start_date > today ? <span>Empieza el {formatDate(d.start_date)} · quedan {left} días</span>
                          : <strong className={soon ? "text-warn" : ""}>{left === 1 ? "Termina mañana" : `Quedan ${left} días`}</strong>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="tabular font-bold text-danger">{formatMoney(d.due)}</span>
                      {(() => {
                        const places = [...new Set((d.reservation_segments ?? []).filter((x) => x.active).sort((a, b) => a.start_date.localeCompare(b.start_date))
                          .map((x) => `${x.spaces?.kind === "sombrilla" ? "Sombrilla" : "Carpa"} ${x.spaces?.code ?? ""}`))].join(" y ");
                        return (
                          <WhatsAppSend phone={d.customers.phone} className="py-2" title="Mandar recordatorio por WhatsApp (podés editar el mensaje)"
                            text={debtReminder({ firstName: d.customers.first_name, balneario: ws.name, number: d.number, places, start: d.start_date, end: d.end_date, due: d.due, today }, templates)} />
                        );
                      })()}
                      <Button onClick={() => { setMsg(null); setPaying(d); }} disabled={!cajaAbierta}>Cobrar</Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="flex flex-col gap-4">
        <Card title="Últimos pagos">
          {!data.data || data.data.payments.length === 0 ? <EmptyState>Sin pagos registrados.</EmptyState> : (
            <ul className="divide-y divide-line text-sm">
              {data.data.payments.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <Link href={`/reservas/${p.reservations.id}`} className="block truncate font-medium hover:underline">{p.reservations.customers.first_name} {p.reservations.customers.last_name} · #{p.reservations.number}</Link>
                    <div className="text-xs text-muted">{formatDateTime(p.created_at, ws.timezone)} · {METHOD_LABEL[p.method] ?? p.method}{p.usd_amount ? ` US$ ${p.usd_amount}` : ""}{p.kind !== "cobro" ? ` · ${p.kind === "devolucion" ? "Devolución" : "Anulación"}` : ""}</div>
                  </div>
                  <span className={cx("tabular shrink-0 font-semibold", Number(p.signed_amount) >= 0 ? "text-ok" : "text-danger")}>{Number(p.signed_amount) >= 0 ? "+" : "−"} {formatMoney(p.amount)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">Para anular un pago o registrar una devolución, abrí la reserva.</p>
          {data.data && data.data.payments.some((p) => p.voids_payment_id) && <Badge tone="muted">Incluye anulaciones</Badge>}
        </Card>
        <Card title="Vouchers del restaurante vigentes">
          <VoucherList reloadKey={data.data?.payments.length ?? 0} />
          <p className="mt-2 text-xs text-muted">Se crean al hacer una devolución con voucher desde la reserva. Cuando el cliente lo usa, tocá "Marcar usado".</p>
        </Card>
        </div>
      </div>

      {paying && (
        <PaymentModal
          open
          full={{ r: { id: paying.id, number: paying.number }, balance: { due_amount: paying.due } }}
          onClose={() => setPaying(null)}
          onDone={(t) => { setPaying(null); setMsg(`${t} Reserva #${paying.number}.`); data.reload(); status.reload(); }}
        />
      )}
    </>
  );
}
