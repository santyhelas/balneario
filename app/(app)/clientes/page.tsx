"use client";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { METHOD_LABEL } from "@/lib/methods";
import { seasonOf } from "@/lib/history";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Badge, Button, Card, EmptyState, Input, Spinner, cx } from "@/components/ui";
import Link from "next/link";
import { CustomerForm, searchCustomers, type Customer } from "@/components/customers";

type HistoryRow = {
  id: string;
  number: number;
  start_date: string;
  end_date: string;
  status: string;
  is_courtesy: boolean;
  total_amount: number;
  reservation_segments: { space_id: string; active: boolean; start_date: string; spaces: { code: string } | null }[];
};
type Balance = { reservation_id: string; paid_amount: number; due_amount: number; credit_amount: number };

export default function ClientesPage() {
  const { ws } = useWorkspace();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [editing, setEditing] = useState<Customer | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [selected, setSelected] = useState<Customer | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  // En el celular la ficha queda debajo de la lista: bajar hasta ella al elegir un cliente.
  useEffect(() => {
    if (!selected || window.innerWidth >= 1024) return;
    requestAnimationFrame(() => document.getElementById("ficha-cliente")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [selected]);

  const list = useLoader(() => searchCustomers(ws.id, debounced), [ws.id, debounced], 60_000);

  return (
    <>
      <PageHeader
        title="Clientes"
        subtitle="Buscá por nombre, apellido, teléfono o localidad"
        actions={<Button onClick={() => { setEditing(null); setFormOpen(true); }}>Nuevo cliente</Button>}
      />
      <SyncNotice error={list.error} stale={list.stale} updatedAt={list.updatedAt} onRetry={list.reload} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <Input type="search" placeholder="Ej: Pérez, Ana o 2641551234" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" aria-label="Buscar cliente" />
          {list.loading && !list.data ? (
            <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Buscando…</div>
          ) : list.data && list.data.length === 0 ? (
            <EmptyState>{debounced ? "No se encontraron clientes con esa búsqueda." : "Todavía no hay clientes cargados."}</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {list.data?.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => setSelected(c)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2.5 text-left text-sm hover:bg-surface-2 ${selected?.id === c.id ? "bg-accent-soft" : ""}`}
                  >
                    <span className="font-medium">{c.last_name ? `${c.last_name}, ` : ""}{c.first_name}</span>
                    <span className="text-xs text-muted">{c.phone ?? ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {list.data && list.data.length === 50 && <p className="mt-2 text-xs text-muted">Se muestran los primeros 50. Refiná la búsqueda para ver otros.</p>}
        </Card>

        <div id="ficha-cliente" className="scroll-mt-20">
        {selected ? (
          <CustomerDetail
            key={selected.id}
            customer={selected}
            onEdit={() => { setEditing(selected); setFormOpen(true); }}
          />
        ) : (
          <Card className="hidden lg:block"><EmptyState>Elegí un cliente para ver sus datos e historial.</EmptyState></Card>
        )}
        </div>
      </div>

      <CustomerForm
        open={formOpen}
        customer={editing}
        onClose={() => { setFormOpen(false); list.reload(); }}
        onSaved={(c) => { setFormOpen(false); setSelected(c); list.reload(); }}
      />
    </>
  );
}

function CustomerDetail({ customer, onEdit }: { customer: Customer; onEdit: () => void }) {
  const sb = getSupabase();
  const history = useLoader(async () => {
    const rows = unwrap(
      await sb.from("reservations")
        .select("id, number, start_date, end_date, status, is_courtesy, total_amount, reservation_segments(space_id, active, start_date, spaces(code))")
        .eq("customer_id", customer.id)
        .order("start_date", { ascending: false }),
    ) as unknown as HistoryRow[];
    const ids = rows.map((r) => r.id);
    const balances = ids.length
      ? (unwrap(await sb.from("reservation_balances").select("reservation_id, paid_amount, due_amount, credit_amount").in("reservation_id", ids)) as Balance[])
      : [];
    const pays = ids.length
      ? (unwrap(await sb.from("payments").select("*").in("reservation_id", ids).order("created_at")) as PayRow[])
      : [];
    const payments: Record<string, PayRow[]> = {};
    for (const p of pays) (payments[p.reservation_id] ??= []).push(p);
    return { rows, balances: Object.fromEntries(balances.map((b) => [b.reservation_id, b])) as Record<string, Balance>, payments };
  }, [customer.id]);
  const { ws } = useWorkspace();

  const rows = history.data?.rows ?? [];
  const active = rows.filter((r) => r.status === "confirmada");
  const totalPaid = rows.reduce((s, r) => s + Number(history.data?.balances[r.id]?.paid_amount ?? 0), 0);
  const totalDue = rows.reduce((s, r) => s + Number(history.data?.balances[r.id]?.due_amount ?? 0), 0);
  const seasons = new Set(active.map((r) => r.start_date.slice(0, 4))).size;

  return (
    <Card
      title={`${customer.first_name} ${customer.last_name}`.trim()}
      actions={<Button variant="secondary" onClick={onEdit}>Editar</Button>}
    >
      <dl className="mb-4 grid grid-cols-2 gap-2 text-sm">
        <div><dt className="text-xs text-muted">Teléfono</dt><dd>{customer.phone ? <a className="text-accent underline" href={`tel:${customer.phone.replace(/[^\d+]/g, "")}`}>{customer.phone}</a> : "—"}</dd></div>
        <div><dt className="text-xs text-muted">Correo</dt><dd className="truncate">{customer.email ?? "—"}</dd></div>
        {customer.locality && <div><dt className="text-xs text-muted">Localidad</dt><dd>{customer.locality}</dd></div>}
        {customer.other_contact && <div className="col-span-2"><dt className="text-xs text-muted">Otro contacto</dt><dd>{customer.other_contact}</dd></div>}
        {customer.notes && <div className="col-span-2"><dt className="text-xs text-muted">Observaciones</dt><dd className="whitespace-pre-wrap">{customer.notes}</dd></div>}
      </dl>

      <div className="mb-3 flex flex-wrap gap-2">
        <Badge tone="muted">{active.length} {active.length === 1 ? "alquiler" : "alquileres"}</Badge>
        <Badge tone="ok">Pagó {formatMoney(totalPaid)}</Badge>
        {totalDue > 0 && <Badge tone="danger">Debe {formatMoney(totalDue)}</Badge>}
        {(active.length >= 3 || seasons >= 2) && <span title="Criterio provisorio: 3 o más alquileres o 2 o más temporadas. Pendiente de confirmar."><Badge tone="info">Cliente frecuente</Badge></span>}
      </div>

      <h3 className="mb-2 text-sm font-semibold">Historial</h3>
      {history.error && <p className="text-sm text-danger">{history.error}</p>}
      {history.loading && !history.data ? (
        <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando…</div>
      ) : rows.length === 0 ? (
        <EmptyState>Sin reservas todavía.</EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {groupBySeason(rows).map(([season, list]) => {
            const paid = list.reduce((acc, r) => acc + Number(history.data?.balances[r.id]?.paid_amount ?? 0), 0);
            const days = list.filter((r) => r.status === "confirmada").reduce((acc, r) => acc + inclusive(r.start_date, r.end_date), 0);
            return (
              <section key={season}>
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-1">
                  <h4 className="text-sm font-bold">Temporada {season}</h4>
                  <span className="text-xs text-muted">{list.length} {list.length === 1 ? "reserva" : "reservas"} · {days} días · pagó {formatMoney(paid)}</span>
                </div>
                <ul className="divide-y divide-line text-sm">
                  {list.map((r) => {
                    const b = history.data?.balances[r.id];
                    const spaces = [...new Set(r.reservation_segments.filter((s) => s.active).sort((a, z) => a.start_date.localeCompare(z.start_date)).map((s) => s.spaces?.code))].join(", ");
                    const pays = history.data?.payments[r.id] ?? [];
                    const voided = new Set(pays.filter((p) => p.voids_payment_id).map((p) => p.voids_payment_id));
                    return (
                      <li key={r.id} className="py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <Link href={`/reservas/${r.id}`} className="font-medium hover:underline">#{r.number} · {spaces || "—"}</Link>
                            <div className="text-xs text-muted">{formatDate(r.start_date)} al {formatDate(r.end_date)} · Total {formatMoney(r.total_amount)}</div>
                          </div>
                          <div className="flex gap-1">
                            {r.status === "cancelada" && <Badge tone="muted">Cancelada</Badge>}
                            {r.is_courtesy && <Badge tone="info">Cortesía</Badge>}
                            {b && Number(b.due_amount) > 0 && <Badge tone="danger">Debe {formatMoney(b.due_amount)}</Badge>}
                            {b && Number(b.credit_amount) > 0 && <Badge tone="warn">A favor {formatMoney(b.credit_amount)}</Badge>}
                            {b && r.status === "confirmada" && !r.is_courtesy && Number(b.due_amount) === 0 && <Badge tone="ok">Pagada</Badge>}
                          </div>
                        </div>
                        {pays.length > 0 && (
                          <ul className="mt-1 ml-3 border-l-2 border-line pl-3 text-xs">
                            {pays.map((p) => (
                              <li key={p.id} className={cx("flex justify-between gap-2 py-0.5", voided.has(p.id) && "text-muted line-through")}>
                                <span>
                                  {formatDateTime(p.created_at, ws.timezone)} · {p.kind === "cobro" ? "Pago" : p.kind === "devolucion" ? "Devolución" : "Anulación"} · {METHOD_LABEL[p.method] ?? p.method}
                                  {p.usd_amount ? ` (US$ ${p.usd_amount})` : ""}
                                </span>
                                <span className={cx("tabular font-medium", Number(p.signed_amount) >= 0 ? "text-ok" : "text-danger")}>
                                  {Number(p.signed_amount) >= 0 ? "+" : "−"} {formatMoney(p.amount)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </Card>
  );
}

type PayRow = {
  id: string; reservation_id: string; kind: "cobro" | "devolucion" | "anulacion"; amount: number; signed_amount: number;
  method: string; created_at: string; voids_payment_id: string | null; usd_amount?: number | null;
};

/** Reservas agrupadas por temporada (de julio a junio), la más reciente primero. */
function groupBySeason<T extends { start_date: string }>(rows: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = seasonOf(r.start_date);
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function inclusive(a: string, b: string) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000) + 1;
}
