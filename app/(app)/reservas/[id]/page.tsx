"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { newKey, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { addDays, formatDate, formatDateTime, formatMoney, inclusiveDays, parseMoney, todayISO } from "@/lib/format";
import { METHOD_LABEL } from "@/lib/methods";
import { VoucherList } from "@/components/vouchers";
import { ArrivalButtons, NoShowPanel } from "@/components/arrival";
import { receiptMessage } from "@/lib/whatsapp-messages";
import { loadReservation, spacesSummary, whatsappLink, type Full, type PaymentRow } from "@/lib/reservations";
import { daysOf, indexGrid, isFreeFor, type GridRow } from "@/lib/stay";
import { useWorkspace } from "@/components/workspace";
import { useStatus } from "@/components/status";
import { PaymentModal, useAction } from "@/components/payments";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Field, Input, Modal, Select, Spinner, Textarea, TextField, cx } from "@/components/ui";

export default function ReservaPage() {
  const { id } = useParams<{ id: string }>();
  const { ws, isAdmin } = useWorkspace();
  const status = useStatus();
  const today = todayISO(ws.timezone);
  const q = useLoader<Full>(() => loadReservation(id), [id]);
  const [modal, setModal] = useState<null | "pago" | "reubicar" | "cancelar" | "devolucion" | "notas">(null);
  const [voiding, setVoiding] = useState<PaymentRow | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  if (!q.data) {
    return q.error ? <SyncNotice error={q.error} stale={false} updatedAt={null} onRetry={q.reload} /> : <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando reserva…</div>;
  }
  const { r, segments, charges, discounts, payments, changes, balance } = q.data;
  const confirmed = r.status === "confirmada";
  const due = Number(balance.due_amount);
  const voided = new Set(payments.filter((p) => p.voids_payment_id).map((p) => p.voids_payment_id));
  const daysLeft = confirmed && today <= r.end_date ? inclusiveDays(today < r.start_date ? r.start_date : today, r.end_date) : 0;
  const wa = whatsappLink(r.customers.phone,
    `Hola ${r.customers.first_name}, te escribimos de ${ws.name}. Reserva #${r.number}: ${spacesSummary(segments)} del ${formatDate(r.start_date)} al ${formatDate(r.end_date)}.` +
    (due > 0 ? ` Saldo pendiente: ${formatMoney(due)}.` : " Está paga. ¡Te esperamos!"));

  const waReceipt = whatsappLink(r.customers.phone, receiptMessage({
    balneario: ws.name, number: r.number, customer: `${r.customers.first_name} ${r.customers.last_name ?? ""}`.trim(),
    places: spacesSummary(segments).split(" → ").map((c) => `${segments.find((s) => s.spaces.code === c)?.spaces.kind === "sombrilla" ? "Sombrilla" : "Carpa"} ${c}`).join(" → "),
    start: r.start_date, end: r.end_date, total: Number(r.total_amount), paid: Number(balance.paid_amount), due, courtesy: r.is_courtesy,
    payments: payments.map((p) => ({ date: formatDateISO(p.created_at, ws.timezone), kind: p.kind, method: METHOD_LABEL[p.method] ?? p.method, amount: Number(p.amount), voided: voided.has(p.id) })),
  }));

  function done(text: string) {
    setModal(null);
    setVoiding(null);
    setReverting(null);
    setMsg({ tone: "ok", text });
    q.reload();
    status.reload();
  }

  return (
    <>
      <PageHeader
        title={`Reserva #${r.number}`}
        subtitle={<>{r.customers.first_name} {r.customers.last_name} · {formatDate(r.start_date)} al {formatDate(r.end_date)}</>}
        actions={
          <>
            {confirmed && !r.is_courtesy && due > 0 && <Button onClick={() => setModal("pago")}>Registrar pago</Button>}
            {confirmed && r.end_date >= today && <Button variant="secondary" onClick={() => setModal("reubicar")}>Cambiar de carpa</Button>}
            <Link href={`/reservas/${r.id}/recibo`}><Button variant="secondary">Comprobante</Button></Link>
            {wa && <a href={wa} target="_blank" rel="noopener noreferrer"><Button variant="secondary">WhatsApp</Button></a>}
            {waReceipt && <a href={waReceipt} target="_blank" rel="noopener noreferrer" title="Mandar el comprobante con el detalle de pagos"><Button variant="secondary">Comprobante por WhatsApp</Button></a>}
            {confirmed && <Button variant="danger" onClick={() => setModal("cancelar")}>Cancelar reserva</Button>}
          </>
        }
      />
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {msg && <Alert tone={msg.tone} className="mb-3">{msg.text}</Alert>}
      {!confirmed && <Alert tone="warn" className="mb-3">Cancelada el {formatDateTime(r.cancelled_at, ws.timezone)}. Motivo: {r.cancel_reason}</Alert>}
      {confirmed && r.end_date === today && due > 0 && <Alert tone="danger" className="mb-3"><strong>Hoy es su último día y tiene deuda de {formatMoney(due)}.</strong></Alert>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Datos">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-xs text-muted">Cliente</dt><dd className="font-medium">{r.customers.first_name} {r.customers.last_name}</dd></div>
            <div><dt className="text-xs text-muted">Teléfono</dt><dd>{r.customers.phone ? <a className="text-accent underline" href={`tel:${r.customers.phone.replace(/[^\d+]/g, "")}`}>{r.customers.phone}</a> : "—"}</dd></div>
            <div><dt className="text-xs text-muted">Estadía</dt><dd>{inclusiveDays(r.start_date, r.end_date)} días</dd></div>
            <div><dt className="text-xs text-muted">Días restantes</dt><dd>{confirmed ? (r.end_date < today ? "Finalizada" : daysLeft) : "—"}</dd></div>
            {confirmed && r.arrival_status !== undefined && r.start_date <= today && (
              <div className="col-span-2">
                <dt className="text-xs text-muted">Llegada</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  <ArrivalButtons reservationId={r.id} state={r.arrival_status ?? null} onChanged={() => { q.reload(); status.reload(); }} />
                  <span className="text-xs text-muted">
                    {r.arrival_status && r.arrival_at ? `Marcado ${formatDateTime(r.arrival_at, ws.timezone)}` : "Sin marcar"}
                  </span>
                </dd>
                {r.arrival_status === "no_vino" && (
                  <div className="mt-2">
                    <NoShowPanel
                      r={r} today={today} isAdmin={isAdmin}
                      releasedDays={changes.filter((c) => c.after_state?.liberado && !c.reverted_by_change_id).map((c) => c.after_state!.liberado!)}
                      discountedDays={discounts.filter((d) => d.kind === "manual" && d.reason?.startsWith("No vino el ")).map((d) => { const [dd, mm, yy] = d.reason!.slice(11).split("/"); return `${yy}-${mm}-${dd}`; })}
                      noShowDiscounts={discounts.filter((d) => d.kind === "manual" && d.reason?.startsWith("No vino el ")).reduce((a, d) => a + Number(d.amount), 0)}
                      hasSpaceOn={(day) => segments.some((s) => s.start_date <= day && s.end_date >= day)}
                      onDone={done}
                    />
                  </div>
                )}
              </div>
            )}
            {r.is_courtesy && <div className="col-span-2"><dt className="text-xs text-muted">Cortesía familiar para</dt><dd>{r.courtesy_beneficiary ?? "—"}</dd></div>}
            <div className="col-span-2">
              <dt className="flex items-center justify-between text-xs text-muted">Observaciones {confirmed && <button className="text-accent hover:underline" onClick={() => setModal("notas")}>Editar</button>}</dt>
              <dd className="whitespace-pre-wrap">{r.notes ?? "—"}</dd>
            </div>
          </dl>
          <h3 className="mb-1 mt-4 text-sm font-semibold">Ubicación</h3>
          {segments.length === 0 ? <p className="text-sm text-muted">Sin espacios (reserva cancelada).</p> : (
            <ul className="text-sm">
              {segments.map((s) => (
                <li key={s.id} className="flex justify-between border-b border-line py-1.5 last:border-0">
                  <span><strong>{s.spaces.kind === "carpa" ? "Carpa" : "Sombrilla"} {s.spaces.code}</strong></span>
                  <span className="text-muted">{formatDate(s.start_date)} al {formatDate(s.end_date)} ({inclusiveDays(s.start_date, s.end_date)} d)</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Precio">
          <div className="flex flex-col gap-1 text-sm">
            {charges.map((c) => <div key={c.id} className="flex justify-between gap-3"><span className="text-muted">{c.description}</span><span className="tabular">{formatMoney(c.amount)}</span></div>)}
            <div className="flex justify-between border-t border-line pt-1"><span>Precio base</span><span className="tabular">{formatMoney(r.list_amount)}</span></div>
            {discounts.map((d) => (
              <div key={d.id} className="flex justify-between gap-3 text-ok">
                <span>{d.label}{d.reason && d.kind !== "cortesia" ? ` · ${d.reason}` : ""}</span><span className="tabular">− {formatMoney(d.amount)}</span>
              </div>
            ))}
            <div className="mt-1 flex justify-between border-t border-line pt-2 text-base font-semibold"><span>Total contratado</span><span className="tabular">{formatMoney(r.total_amount)}</span></div>
            <div className="flex justify-between"><span>Cobrado</span><span className="tabular">{formatMoney(balance.paid_amount)}</span></div>
            <div className={cx("flex justify-between text-base font-semibold", due > 0 && "text-danger")}><span>Saldo pendiente</span><span className="tabular">{formatMoney(due)}</span></div>
            {Number(balance.credit_amount) > 0 && (
              <div className="flex justify-between text-warn"><span>Saldo a favor del cliente</span><span className="tabular">{formatMoney(balance.credit_amount)}</span></div>
            )}
          </div>
        </Card>

        <Card title="Pagos" actions={isAdmin && Number(balance.paid_amount) > 0 ? <Button variant="secondary" onClick={() => setModal("devolucion")}>Registrar devolución</Button> : undefined}>
          {payments.length === 0 ? <EmptyState>Sin pagos registrados.</EmptyState> : (
            <ul className="divide-y divide-line text-sm">
              {payments.map((p) => {
                const isVoided = voided.has(p.id);
                return (
                  <li key={p.id} className={cx("flex flex-wrap items-center justify-between gap-2 py-2", isVoided && "text-muted line-through")}>
                    <div>
                      <div className="font-medium">
                        {p.kind === "cobro" ? "Cobro" : p.kind === "devolucion" ? "Devolución" : "Anulación"} · {METHOD_LABEL[p.method] ?? p.method}
                      </div>
                      <div className="text-xs text-muted">{formatDateTime(p.created_at, ws.timezone)}{p.usd_amount ? ` · US$ ${p.usd_amount} a ${formatMoney(Number(p.exchange_rate))}` : ""}{p.reason ? ` · ${p.reason}` : ""}{p.note ? ` · ${p.note}` : ""}</div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={cx("tabular font-medium", Number(p.signed_amount) >= 0 ? "text-ok" : "text-danger")}>
                        {Number(p.signed_amount) >= 0 ? "+" : "−"} {formatMoney(p.amount)}
                      </span>
                      {isAdmin && p.kind !== "anulacion" && !isVoided && (
                        <button className="text-xs text-danger hover:underline" onClick={() => setVoiding(p)}>Anular</button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {payments.some((p) => p.method === "voucher") && (
          <Card title="Vouchers del restaurante">
            <VoucherList reservationId={r.id} reloadKey={payments.length} />
          </Card>
        )}

        <Card title="Historial">
          {changes.length === 0 ? <EmptyState>Sin cambios.</EmptyState> : (
            <ul className="divide-y divide-line text-sm">
              {changes.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div>
                    <div className={cx(c.reverted_by_change_id && "text-muted line-through")}>{c.description}</div>
                    <div className="text-xs text-muted">{formatDateTime(c.at, ws.timezone)}{c.actor_email ? ` · ${c.actor_email}` : ""}{c.reason ? ` · ${c.reason}` : ""}</div>
                  </div>
                  {(c.kind === "reubicacion" || c.kind === "cancelacion") && !c.reverted_by_change_id && (
                    <button className="text-xs text-accent hover:underline" onClick={() => setReverting(c.id)}>Revertir</button>
                  )}
                  {c.reverted_by_change_id && <Badge tone="muted">Revertido</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <PaymentModal open={modal === "pago"} full={q.data} onClose={() => setModal(null)} onDone={done} />
      <RefundModal open={modal === "devolucion"} full={q.data} onClose={() => setModal(null)} onDone={done} />
      <RelocateModal open={modal === "reubicar"} full={q.data} today={today} onClose={() => setModal(null)} onDone={done} />
      <CancelModal open={modal === "cancelar"} full={q.data} onClose={() => setModal(null)} onDone={done} />
      <NotesModal open={modal === "notas"} full={q.data} onClose={() => setModal(null)} onDone={done} />
      <VoidModal payment={voiding} onClose={() => setVoiding(null)} onDone={done} />
      <RevertModal changeId={reverting} description={changes.find((c) => c.id === reverting)?.description ?? ""} onClose={() => setReverting(null)} onDone={done} />
    </>
  );
}

function RefundModal({ open, full, onClose, onDone }: { open: boolean; full: Full; onClose: () => void; onDone: (t: string) => void }) {
  const { ws } = useWorkspace();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("efectivo");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(newKey);
  const a = useAction();
  function submit(e: FormEvent) {
    e.preventDefault();
    const v = parseMoney(amount);
    if (!v || v <= 0) return a.setError("Ingresá un importe válido.");
    if (reason.trim().length < 3) return a.setError("Indicá el motivo.");
    a.run(
      () => getSupabase().rpc("refund_payment", { p_workspace_id: ws.id, p_reservation_id: full.r.id, p_amount: v, p_method: method, p_idempotency_key: key, p_reason: reason }),
      () => {
        setKey(newKey()); setAmount(""); setReason("");
        onDone(method === "voucher"
          ? `Voucher para el restaurante por ${formatMoney(v)} creado. Su código figura en la reserva, en "Vouchers del restaurante".`
          : `Devolución en efectivo de ${formatMoney(v)} registrada en la caja de hoy.`);
      },
    );
  }
  return (
    <Modal open={open} onClose={onClose} title="Registrar devolución al cliente" busy={a.busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-muted">Cobrado hasta ahora: {formatMoney(full.balance.paid_amount)}.</p>
        <Field label="¿Cómo se devuelve?">
          <div className="grid grid-cols-2 gap-2">
            {([["efectivo", "Efectivo", "Sale de la caja de hoy."], ["voucher", "Voucher restaurante", "Crédito para consumir en el restaurante. No toca la caja."]] as const).map(([v, l, d]) => (
              <button key={v} type="button" onClick={() => setMethod(v)} aria-pressed={method === v}
                className={`rounded-lg border p-2 text-left text-sm ${method === v ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2"}`}>
                <div className="font-semibold">{l}</div>
                <div className="text-xs text-muted">{d}</div>
              </button>
            ))}
          </div>
        </Field>
        <TextField label="Importe" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        <TextField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={300} />
        {a.error && <Alert tone="danger">{a.error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={a.busy}>Cancelar</Button>
          <Button type="submit" variant="danger" loading={a.busy}>{method === "voucher" ? "Crear voucher" : "Registrar devolución"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function VoidModal({ payment, onClose, onDone }: { payment: PaymentRow | null; onClose: () => void; onDone: (t: string) => void }) {
  const { ws } = useWorkspace();
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(newKey);
  const a = useAction();
  return (
    <ConfirmDialog
      open={payment !== null}
      title="Anular pago"
      confirmLabel="Anular"
      danger
      busy={a.busy}
      onCancel={() => { setReason(""); a.setError(null); onClose(); }}
      onConfirm={() => {
        if (!payment) return;
        if (reason.trim().length < 3) return a.setError("Indicá el motivo.");
        a.run(
          () => getSupabase().rpc("void_payment", { p_workspace_id: ws.id, p_payment_id: payment.id, p_idempotency_key: key, p_reason: reason }),
          () => { setKey(newKey()); setReason(""); onDone("Pago anulado. Queda registrado en el historial y compensado en la caja de hoy."); },
        );
      }}
      message={
        <div className="flex flex-col gap-3">
          <p>Para corregir un pago cargado por error ({payment ? `${formatMoney(payment.amount)} en ${METHOD_LABEL[payment.method] ?? payment.method}` : ""}). No se borra: se registra una anulación que lo compensa.</p>
          <TextField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} />
          {a.error && <Alert tone="danger">{a.error}</Alert>}
        </div>
      }
    />
  );
}

function RelocateModal({ open, full, today, onClose, onDone }: { open: boolean; full: Full; today: string; onClose: () => void; onDone: (t: string) => void }) {
  const { ws } = useWorkspace();
  const { r, segments } = full;
  const firstDay = r.start_date > today ? r.start_date : today;
  const [mode, setMode] = useState<"dia" | "resto">("dia");
  // Por defecto: mañana si el cliente ya está en el balneario; si no, el primer día de la estadía.
  const tomorrow = addDays(today, 1);
  const [day, setDay] = useState(firstDay === today && tomorrow <= r.end_date ? tomorrow : firstDay);
  const [kind, setKind] = useState<"carpa" | "sombrilla">(segments[0]?.spaces.kind ?? "carpa");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [grid, setGrid] = useState<GridRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const a = useAction();
  const from = day;
  const to = mode === "dia" ? day : r.end_date;

  const current = segments.find((s) => s.start_date <= day && s.end_date >= day);

  async function load() {
    setLoading(true);
    setTarget("");
    const res = await getSupabase().rpc("availability_grid", { p_workspace_id: ws.id, p_from: from, p_to: to, p_kind: kind });
    setLoading(false);
    if (res.error) return a.setError(friendlyError(res.error));
    setGrid(res.data as GridRow[]);
  }
  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, from, to, kind]);

  const options = useMemo(() => {
    if (!grid) return [];
    const idx = indexGrid(grid);
    const days = daysOf(from, to);
    const seen = new Map<string, string>();
    grid.forEach((g) => seen.set(g.space_id, g.code));
    return [...seen.entries()]
      .filter(([sid]) => sid !== current?.space_id && isFreeFor(idx, sid, days))
      .map(([space_id, code]) => ({ space_id, code }))
      .sort((x, y) => x.code.localeCompare(y.code, "es", { numeric: true }));
  }, [grid, from, to, current]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!target) return a.setError("Elegí el espacio de destino.");
    a.run(
      () => getSupabase().rpc("relocate_reservation", { p_reservation_id: r.id, p_target_space_id: target, p_from: from, p_to: to, p_expected_version: r.version, p_reason: reason || null }),
      () => { setReason(""); onDone(mode === "dia" ? `Cambio por el ${formatDate(day)} registrado. Al día siguiente vuelve a su lugar.` : `Cambio desde el ${formatDate(day)} registrado.`); },
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="Cambiar de carpa" busy={a.busy} wide>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5 text-sm sm:flex-row">
          {([["dia", "Solo por un día", "Vuelve automáticamente a su lugar al día siguiente"], ["resto", "Por el resto de la estadía", `Desde la fecha elegida hasta el ${formatDate(r.end_date)}`]] as const).map(([v, l, h]) => (
            <label key={v} className={cx("flex flex-1 cursor-pointer items-start gap-2 rounded-lg border p-2", mode === v ? "border-accent bg-accent-soft" : "border-line")}>
              <input type="radio" checked={mode === v} onChange={() => setMode(v)} className="mt-1" />
              <span><strong>{l}</strong><span className="block text-xs text-muted">{h}</span></span>
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={mode === "dia" ? "Día del cambio" : "Desde"}>
            <Input type="date" value={day} min={r.start_date} max={r.end_date} onChange={(e) => e.target.value && setDay(e.target.value)} />
          </Field>
          <Field label="Tipo de destino">
            <Select value={kind} onChange={(e) => setKind(e.target.value as "carpa" | "sombrilla")}><option value="carpa">Carpa</option><option value="sombrilla">Sombrilla</option></Select>
          </Field>
        </div>
        {current && <p className="text-sm text-muted">Ese día está en <strong className="text-fg">{current.spaces.code}</strong>.</p>}
        <Field label={`Libres del ${formatDate(from)} al ${formatDate(to)}`}>
          {loading ? <span className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Buscando…</span> : options.length === 0 ? (
            <Alert tone="warn">No hay {kind === "carpa" ? "carpas" : "sombrillas"} libres en esas fechas.</Alert>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(3.25rem,1fr))] gap-1.5">
              {options.map((o) => (
                <button key={o.space_id} type="button" onClick={() => setTarget(o.space_id)}
                  className={cx("rounded-md border py-1.5 text-sm font-semibold", target === o.space_id ? "border-accent bg-accent text-accent-fg" : "border-ok/50 bg-ok-soft text-ok")}>
                  {o.code}
                </button>
              ))}
            </div>
          )}
        </Field>
        {kind !== segments[0]?.spaces.kind && <Alert tone="info">Cambia de tipo de espacio. El precio contratado no se modifica.</Alert>}
        <TextField label="Motivo (opcional)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Ej: quiere más sombra" />
        <p className="text-xs text-muted">La reserva sigue siendo una sola. Los pagos y la deuda no cambian. Se puede revertir desde el historial.</p>
        {a.error && <Alert tone="danger">{a.error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={a.busy}>Cancelar</Button>
          <Button type="submit" loading={a.busy} disabled={!target}>Confirmar cambio</Button>
        </div>
      </form>
    </Modal>
  );
}

function CancelModal({ open, full, onClose, onDone }: { open: boolean; full: Full; onClose: () => void; onDone: (t: string) => void }) {
  const [reason, setReason] = useState("");
  const a = useAction();
  return (
    <ConfirmDialog
      open={open}
      title={`Cancelar reserva #${full.r.number}`}
      confirmLabel="Cancelar reserva"
      danger
      busy={a.busy}
      onCancel={onClose}
      onConfirm={() => {
        if (reason.trim().length < 3) return a.setError("Indicá el motivo.");
        a.run(
          () => getSupabase().rpc("cancel_reservation", { p_reservation_id: full.r.id, p_expected_version: full.r.version, p_reason: reason }),
          () => { setReason(""); onDone("Reserva cancelada. Los espacios quedaron libres; los pagos se conservan."); },
        );
      }}
      message={
        <div className="flex flex-col gap-3">
          <p>Se liberan los espacios. Los pagos no se borran: si corresponde devolver dinero, registralo como devolución. Se puede revertir desde el historial mientras los espacios sigan libres.</p>
          <TextField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} />
          {a.error && <Alert tone="danger">{a.error}</Alert>}
        </div>
      }
    />
  );
}

function NotesModal({ open, full, onClose, onDone }: { open: boolean; full: Full; onClose: () => void; onDone: (t: string) => void }) {
  const [notes, setNotes] = useState(full.r.notes ?? "");
  const a = useAction();
  return (
    <Modal open={open} onClose={onClose} title="Observaciones" busy={a.busy}>
      <Textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
      {a.error && <Alert tone="danger">{a.error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={a.busy}>Cancelar</Button>
        <Button loading={a.busy} onClick={() => a.run(
          () => getSupabase().rpc("update_reservation_notes", { p_reservation_id: full.r.id, p_expected_version: full.r.version, p_notes: notes }),
          () => onDone("Observaciones guardadas."),
        )}>Guardar</Button>
      </div>
    </Modal>
  );
}

function RevertModal({ changeId, description, onClose, onDone }: { changeId: string | null; description: string; onClose: () => void; onDone: (t: string) => void }) {
  const [reason, setReason] = useState("");
  const a = useAction();
  return (
    <ConfirmDialog
      open={changeId !== null}
      title="Revertir cambio"
      confirmLabel="Revertir"
      busy={a.busy}
      onCancel={() => { a.setError(null); onClose(); }}
      onConfirm={() => a.run(
        () => getSupabase().rpc("revert_change", { p_change_id: changeId, p_reason: reason || null }),
        () => { setReason(""); onDone(`Se revirtió: ${description}.`); },
      )}
      message={
        <div className="flex flex-col gap-3">
          <p>Se restaura la ubicación anterior a: <strong className="text-fg">{description}</strong>. Si algún espacio fue tomado por otra reserva después, el sistema no lo permite y explica por qué.</p>
          <TextField label="Motivo (opcional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          {a.error && <Alert tone="danger">{a.error}</Alert>}
        </div>
      }
    />
  );
}

/** Fecha AAAA-MM-DD de un momento, en la zona horaria del balneario. */
function formatDateISO(iso: string, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));
}
