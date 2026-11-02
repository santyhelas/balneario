"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { newKey, unwrap } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { addDays, formatDate, formatMoney, inclusiveDays, parseMoney, todayISO } from "@/lib/format";
import { METHOD_LABEL, PAYMENT_METHODS } from "@/lib/methods";
import { buildSegments, candidatesFor, daysOf, indexGrid, isFreeFor, splitDays, type GridRow, type Segment } from "@/lib/stay";
import { useWorkspace } from "@/components/workspace";
import { useStatus } from "@/components/status";
import { PageHeader } from "@/components/shell";
import { Alert, Badge, Button, Card, Field, Input, Modal, Select, Spinner, Textarea, TextField, cx } from "@/components/ui";
import { CustomerForm, searchCustomers, type Customer } from "@/components/customers";

type Agreement = { id: string; name: string; percent: number; valid_from: string | null; valid_to: string | null };
type Quote = {
  ok: boolean;
  faltan_tarifas: { space_kind: string; year: number; month: number; half: number }[];
  charges: { description: string; amount: number }[];
  dias: number;
  precio_base: number;
  discounts: { kind: string; percent: number | null; amount: number; label?: string; agreement_id?: string; reason?: string }[];
  total: number;
};
type PayMode = "pagada" | "despues" | "sena";

const DURATIONS = [1, 5, 7, 15, 30];
const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export default function NuevaReservaPage() {
  const { ws, isAdmin } = useWorkspace();
  const status = useStatus();
  const sb = getSupabase();
  const today = todayISO(ws.timezone);

  // ---------- Datos iniciales (desde el mapa o la línea de tiempo: ?espacio=…&desde=…) ----------
  const [prefill, setPrefill] = useState<{ space: string | null; from: string | null }>({ space: null, from: null });
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setPrefill({ space: p.get("espacio"), from: p.get("desde") });
  }, []);

  // ---------- Cliente ----------
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [custQuery, setCustQuery] = useState("");
  const [custResults, setCustResults] = useState<Customer[]>([]);
  const [custOpen, setCustOpen] = useState(false);
  const [newCustOpen, setNewCustOpen] = useState(false);

  useEffect(() => {
    if (customer || custQuery.trim().length < 2) {
      setCustResults([]);
      return;
    }
    const t = setTimeout(() => {
      searchCustomers(ws.id, custQuery, 8).then(setCustResults).catch(() => setCustResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [custQuery, customer, ws.id]);

  // ---------- Fechas ----------
  const [start, setStart] = useState(today);
  useEffect(() => {
    if (prefill.from && /^\d{4}-\d{2}-\d{2}$/.test(prefill.from)) setStart(prefill.from);
  }, [prefill.from]);
  const [duration, setDuration] = useState<number | "otra">(7);
  const [customEnd, setCustomEnd] = useState(addDays(start, 6));
  const end = duration === "otra" ? customEnd : addDays(start, duration - 1);
  const nDays = end >= start ? inclusiveDays(start, end) : 0;
  const datesOk = nDays >= 1 && nDays <= 120;

  // ---------- Disponibilidad ----------
  const [kind, setKind] = useState<"carpa" | "sombrilla">("carpa");
  const [grid, setGrid] = useState<GridRow[] | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  const [gridLoading, setGridLoading] = useState(false);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [runChoice, setRunChoice] = useState<Record<string, string>>({}); // inicio de tramo ocupado → espacio alternativo
  const gridSeq = useRef(0);

  async function loadGrid() {
    if (!datesOk) return;
    const my = ++gridSeq.current;
    setGridLoading(true);
    setGridError(null);
    try {
      const rows = unwrap(await sb.rpc("availability_grid", { p_workspace_id: ws.id, p_from: start, p_to: end, p_kind: kind })) as GridRow[];
      if (my === gridSeq.current) setGrid(rows);
    } catch (e) {
      if (my === gridSeq.current) setGridError(friendlyError(e));
    } finally {
      if (my === gridSeq.current) setGridLoading(false);
    }
  }
  useEffect(() => {
    setGrid(null);
    loadGrid();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, kind, ws.id]);

  // Espacio preseleccionado desde el mapa (por id)
  useEffect(() => {
    if (!prefill.space || !grid || spaceId) return;
    const row = grid.find((r) => r.space_id === prefill.space);
    if (row) setSpaceId(prefill.space);
    else if (kind === "carpa") setKind("sombrilla");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid]);

  const days = useMemo(() => (datesOk ? daysOf(start, end) : []), [start, end, datesOk]);
  const idx = useMemo(() => indexGrid(grid ?? []), [grid]);
  const spaces = useMemo(() => {
    const m = new Map<string, { space_id: string; code: string; reason: string | null }>();
    (grid ?? []).forEach((r) => {
      if (!m.has(r.space_id)) m.set(r.space_id, { space_id: r.space_id, code: r.code, reason: r.reason });
    });
    return [...m.values()].sort((a, b) => a.code.localeCompare(b.code, "es", { numeric: true }));
  }, [grid]);
  const fullyFree = useMemo(() => spaces.filter((s) => isFreeFor(idx, s.space_id, days)), [spaces, idx, days]);
  const selected = spaces.find((s) => s.space_id === spaceId) ?? null;
  const split = useMemo(() => (spaceId && grid ? splitDays(idx, spaceId, days) : null), [spaceId, grid, idx, days]);

  // Para cada tramo ocupado, alternativas reales (libres todo ese tramo)
  const busyOptions = useMemo(() => {
    if (!split || !selected) return [];
    return split.busyRuns.map((run) => ({ run, candidates: candidatesFor(idx, spaces, run, selected.space_id, selected.code) }));
  }, [split, selected, idx, spaces]);

  const segments: Segment[] | null = useMemo(() => {
    if (!selected || !split) return null;
    if (split.free.length === 0) return null; // no tiene ningún día libre
    const assign: { day: string; space_id: string }[] = [];
    for (const d of split.free) assign.push({ day: d, space_id: selected.space_id });
    for (const { run, candidates } of busyOptions) {
      const chosen = runChoice[run.start] ?? candidates[0]?.space_id;
      if (!chosen) return null; // tramo sin alternativa
      for (const d of daysOf(run.start, run.end)) assign.push({ day: d, space_id: chosen });
    }
    return buildSegments(assign);
  }, [selected, split, busyOptions, runChoice]);
  const noAlternative = busyOptions.some((b) => b.candidates.length === 0);

  useEffect(() => setRunChoice({}), [spaceId, start, end]);

  // ---------- Precio ----------
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  useEffect(() => {
    sb.from("agreements").select("id, name, percent, valid_from, valid_to").eq("workspace_id", ws.id).eq("active", true).order("name")
      .then(({ data }) => setAgreements((data ?? []) as Agreement[]));
  }, [sb, ws.id]);
  const validAgreements = agreements.filter((a) => (!a.valid_from || start >= a.valid_from) && (!a.valid_to || start <= a.valid_to));

  const [agreementId, setAgreementId] = useState("");
  const [cash, setCash] = useState(false);
  const [courtesy, setCourtesy] = useState(false);
  const [beneficiary, setBeneficiary] = useState("");
  const [manualType, setManualType] = useState<"monto" | "porcentaje">("monto");
  const [manualValue, setManualValue] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [useManualBase, setUseManualBase] = useState(false);
  const [manualBase, setManualBase] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (agreementId && !validAgreements.some((a) => a.id === agreementId)) setAgreementId("");
  }, [agreementId, validAgreements]);

  const options = useMemo(() => {
    const o: Record<string, unknown> = { courtesy };
    if (courtesy) {
      o.courtesy_beneficiary = beneficiary;
    } else {
      if (agreementId) o.agreement_id = agreementId;
      if (cash) o.cash = true;
      const mv = manualType === "monto" ? parseMoney(manualValue) : Number(manualValue.replace(",", "."));
      if (isAdmin && mv && mv > 0) o.manual = { type: manualType, value: mv, reason: manualReason };
    }
    if (isAdmin && useManualBase) {
      const b = parseMoney(manualBase);
      if (b !== null) o.manual_base = b;
    }
    return o;
  }, [courtesy, beneficiary, agreementId, cash, manualType, manualValue, manualReason, isAdmin, useManualBase, manualBase]);

  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const quoteSeq = useRef(0);
  const segKey = JSON.stringify(segments);
  const optKey = JSON.stringify(options);
  useEffect(() => {
    if (!segments) {
      setQuote(null);
      return;
    }
    const my = ++quoteSeq.current;
    setQuoteLoading(true);
    const t = setTimeout(async () => {
      const { data, error } = await sb.rpc("quote_reservation", { p_workspace_id: ws.id, p_start: start, p_end: end, p_segments: segments, p_options: options });
      if (my !== quoteSeq.current) return;
      setQuoteLoading(false);
      if (error) {
        setQuote(null);
        setQuoteError(friendlyError(error));
      } else {
        setQuote(data as Quote);
        setQuoteError(null);
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segKey, optKey, start, end, ws.id]);

  // ---------- Pago ----------
  const [payMode, setPayMode] = useState<PayMode>("pagada");
  const [method, setMethod] = useState("efectivo");
  const [deposit, setDeposit] = useState("");
  const total = quote?.ok ? Number(quote.total) : null;
  const paidNow = courtesy || payMode === "despues" ? 0 : payMode === "pagada" ? total ?? 0 : parseMoney(deposit) ?? 0;
  const debt = total === null ? null : Math.max(total - paidNow, 0);

  // ---------- Guardar ----------
  const [requestId, setRequestId] = useState(newKey);
  const [paymentKey, setPaymentKey] = useState(newKey);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; number: number } | null>(null);

  const problems: string[] = [];
  if (!customer) problems.push("Elegí o creá el cliente.");
  if (!datesOk) problems.push(nDays > 120 ? "La estadía puede ser de hasta 120 días." : "Revisá las fechas.");
  if (!selected) problems.push("Elegí una carpa o sombrilla.");
  else if (split && split.free.length === 0) problems.push(`${selected.code} está ocupada todos esos días. Elegí otra.`);
  else if (noAlternative) problems.push("No hay alternativas libres para algunos días: elegí otro espacio o cambiá las fechas.");
  if (quote && !quote.ok) problems.push("Faltan tarifas para esas fechas.");
  if (courtesy && beneficiary.trim().length < 2) problems.push("Indicá el familiar beneficiario de la cortesía.");
  if (!courtesy && payMode === "sena") {
    const d = parseMoney(deposit);
    if (!d || d <= 0) problems.push("Ingresá el importe de la seña.");
    else if (total !== null && d > total) problems.push("La seña no puede superar el total.");
  }
  if (!courtesy && payMode === "pagada" && total === 0) problems.push("El total es $0: elegí «Cobrar después» o marcá cortesía.");
  const manualDiscountValue = manualType === "monto" ? parseMoney(manualValue) : Number(manualValue.replace(",", "."));
  if (isAdmin && !courtesy && manualDiscountValue && manualDiscountValue > 0 && manualReason.trim().length < 3) problems.push("El descuento manual necesita un motivo.");
  const canSave = problems.length === 0 && !!quote?.ok && !quoteLoading && !!segments;

  async function save() {
    if (!customer || !segments) return;
    setSaving(true);
    setSaveError(null);
    const payment = !courtesy && payMode !== "despues" && paidNow > 0
      ? { amount: paidNow, method, idempotency_key: paymentKey }
      : null;
    const { data, error } = await sb.rpc("create_reservation_v2", {
      p_workspace_id: ws.id,
      p_request_id: requestId,
      p_customer_id: customer.id,
      p_start_date: start,
      p_end_date: end,
      p_segments: segments,
      p_options: options,
      p_notes: notes.trim() || null,
      p_payment: payment,
    });
    setSaving(false);
    if (error) {
      setSaveError(friendlyError(error));
      if (error.hint === "CONFLICTO_DISPONIBILIDAD") loadGrid();
      return;
    }
    const res = data as { reservation_id: string; number: number };
    setConfirmOpen(false);
    setDone({ id: res.reservation_id, number: res.number });
    status.reload();
  }

  function reset() {
    setDone(null);
    setCustomer(null);
    setCustQuery("");
    setSpaceId(null);
    setNotes("");
    setCourtesy(false);
    setBeneficiary("");
    setAgreementId("");
    setCash(false);
    setManualValue("");
    setManualReason("");
    setUseManualBase(false);
    setManualBase("");
    setPayMode("pagada");
    setDeposit("");
    setRequestId(newKey());
    setPaymentKey(newKey());
    loadGrid();
  }

  if (done) {
    return (
      <div className="mx-auto max-w-lg">
        <Alert tone="ok" className="mb-4 text-base">
          <strong>Reserva #{done.number} guardada.</strong> Ya figura en el mapa, en la caja (si hubo cobro) y en todas las computadoras.
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Link href={`/reservas/${done.id}`}><Button>Ver la reserva</Button></Link>
          <Button variant="secondary" onClick={reset}>Cargar otra reserva</Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader title="Nueva reserva" subtitle="Las fechas cuentan inclusive: el día de llegada y el de salida." />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          {/* 1. Cliente */}
          <Card title="1. Cliente">
            {customer ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 p-3 text-sm">
                <div>
                  <div className="font-medium">{customer.first_name} {customer.last_name}</div>
                  <div className="text-xs text-muted">{[customer.phone, customer.locality].filter(Boolean).join(" · ") || "Sin teléfono"}</div>
                </div>
                <Button variant="ghost" onClick={() => { setCustomer(null); setCustQuery(""); }}>Cambiar</Button>
              </div>
            ) : (
              <div className="relative">
                <div className="flex gap-2">
                  <Input
                    placeholder="Buscar por nombre, apellido o teléfono"
                    value={custQuery}
                    onChange={(e) => { setCustQuery(e.target.value); setCustOpen(true); }}
                    onFocus={() => setCustOpen(true)}
                    aria-label="Buscar cliente"
                  />
                  <Button variant="secondary" onClick={() => setNewCustOpen(true)} className="shrink-0">+ Nuevo cliente</Button>
                </div>
                {custOpen && custResults.length > 0 && (
                  <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-line bg-surface shadow-lg">
                    {custResults.map((c) => (
                      <li key={c.id}>
                        <button className="w-full px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => { setCustomer(c); setCustOpen(false); }}>
                          <span className="font-medium">{c.first_name} {c.last_name}</span>
                          <span className="ml-2 text-xs text-muted">{[c.phone, c.locality].filter(Boolean).join(" · ")}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {custQuery.trim().length >= 2 && custResults.length === 0 && (
                  <p className="mt-2 text-xs text-muted">Sin coincidencias. Podés crearlo con «+ Nuevo cliente».</p>
                )}
              </div>
            )}
          </Card>

          {/* 2. Fechas */}
          <Card title="2. Fechas">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Entrada">
                <Input type="date" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} className="w-auto" />
              </Field>
              <Field label="Duración">
                <div className="flex flex-wrap gap-1">
                  {DURATIONS.map((d) => (
                    <button key={d} type="button" onClick={() => setDuration(d)}
                      className={cx("rounded-lg border px-3 py-2 text-sm", duration === d ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-surface-2")}>
                      {d} {d === 1 ? "día" : "días"}
                    </button>
                  ))}
                  <button type="button" onClick={() => { setDuration("otra"); setCustomEnd(end); }}
                    className={cx("rounded-lg border px-3 py-2 text-sm", duration === "otra" ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-surface-2")}>
                    Otra
                  </button>
                </div>
              </Field>
              {duration === "otra" && (
                <Field label="Salida (último día)">
                  <Input type="date" value={customEnd} min={start} onChange={(e) => e.target.value && setCustomEnd(e.target.value)} className="w-auto" />
                </Field>
              )}
            </div>
            <p className="mt-3 text-sm">
              {datesOk ? <>Del <strong>{formatDate(start)}</strong> al <strong>{formatDate(end)}</strong> · {nDays} {nDays === 1 ? "día" : "días"}</> : <span className="text-danger">{nDays > 120 ? "Máximo 120 días." : "La salida no puede ser anterior a la entrada."}</span>}
              {start < today && <Badge tone="warn">Fecha pasada</Badge>}
            </p>
          </Card>

          {/* 3. Espacio */}
          <Card
            title="3. Carpa o sombrilla"
            actions={
              <Select value={kind} onChange={(e) => { setKind(e.target.value as "carpa" | "sombrilla"); setSpaceId(null); }} className="w-auto" aria-label="Tipo">
                <option value="carpa">Carpas</option>
                <option value="sombrilla">Sombrillas</option>
              </Select>
            }
          >
            {gridError && <Alert tone="danger" className="mb-2">{gridError} <button className="underline" onClick={loadGrid}>Reintentar</button></Alert>}
            {gridLoading && !grid ? (
              <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Consultando disponibilidad…</div>
            ) : grid && (
              <>
                <p className="mb-2 text-xs text-muted">
                  Verde: libre todos los días · Ámbar: libre solo algunos días · Gris: sin días libres. {fullyFree.length} {kind === "carpa" ? "carpas" : "sombrillas"} libres toda la estadía.
                </p>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(3.25rem,1fr))] gap-1.5">
                  {spaces.map((s) => {
                    const sp = splitDays(idx, s.space_id, days);
                    const tone = sp.busy.length === 0 ? "free" : sp.free.length === 0 ? "none" : "partial";
                    return (
                      <button
                        key={s.space_id}
                        type="button"
                        onClick={() => setSpaceId(s.space_id)}
                        title={tone === "free" ? "Libre toda la estadía" : tone === "partial" ? `Libre ${sp.free.length} de ${days.length} días` : "Sin días libres"}
                        className={cx(
                          "rounded-md border py-1.5 text-sm font-semibold tabular",
                          tone === "free" && "border-ok/50 bg-ok-soft text-ok",
                          tone === "partial" && "border-warn/50 bg-warn-soft text-warn",
                          tone === "none" && "border-line bg-surface-2 text-muted opacity-60",
                          spaceId === s.space_id && "ring-2 ring-accent",
                        )}
                      >
                        {s.code}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {selected && split && (
              <div className="mt-4 rounded-lg border border-line p-3 text-sm">
                <div className="mb-2 font-medium">{kind === "carpa" ? "Carpa" : "Sombrilla"} {selected.code}</div>
                {split.busy.length === 0 ? (
                  <Alert tone="ok">Libre toda la estadía.</Alert>
                ) : split.free.length === 0 ? (
                  <Alert tone="danger">Ocupada todos esos días. Elegí otra de la lista.</Alert>
                ) : (
                  <div className="flex flex-col gap-3">
                    <Alert tone="warn">
                      Libre: {split.freeRuns.map((r) => `${formatDate(r.start)} al ${formatDate(r.end)}`).join(", ")}. Ocupada:{" "}
                      {split.busyRuns.map((r) => `${formatDate(r.start)} al ${formatDate(r.end)}`).join(", ")}.
                    </Alert>
                    <div>
                      <div className="mb-1 font-medium">Opción 1 · Misma reserva, cambiando de lugar los días ocupados</div>
                      {busyOptions.map(({ run, candidates }) => (
                        <div key={run.start} className="mb-2 flex flex-wrap items-center gap-2">
                          <span className="text-muted">Del {formatDate(run.start)} al {formatDate(run.end)} ({run.days} {run.days === 1 ? "día" : "días"}):</span>
                          {candidates.length === 0 ? (
                            <Badge tone="danger">Sin alternativas libres</Badge>
                          ) : (
                            <Select value={runChoice[run.start] ?? candidates[0].space_id} onChange={(e) => setRunChoice((p) => ({ ...p, [run.start]: e.target.value }))} className="w-auto">
                              {candidates.map((c) => <option key={c.space_id} value={c.space_id}>{kind === "carpa" ? "Carpa" : "Sombrilla"} {c.code}</option>)}
                            </Select>
                          )}
                        </div>
                      ))}
                      <p className="text-xs text-muted">Mismo tipo de espacio: el precio no cambia.</p>
                    </div>
                    <div>
                      <div className="mb-1 font-medium">Opción 2 · Estadía completa sin mudanza</div>
                      {fullyFree.length === 0 ? (
                        <p className="text-muted">No hay {kind === "carpa" ? "carpas" : "sombrillas"} libres los {days.length} días.</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {fullyFree.slice(0, 12).map((s) => (
                            <Button key={s.space_id} variant="secondary" className="px-2.5 py-1" onClick={() => setSpaceId(s.space_id)}>{s.code}</Button>
                          ))}
                          {fullyFree.length > 12 && <span className="self-center text-xs text-muted">y {fullyFree.length - 12} más en la lista de arriba</span>}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {segments && segments.length > 1 && (
                  <div className="mt-3">
                    <div className="mb-1 text-xs font-medium text-muted">Así queda la reserva (una sola):</div>
                    <ul className="text-sm">
                      {segments.map((s, i) => (
                        <li key={i}>Tramo {i + 1}: <strong>{spaces.find((x) => x.space_id === s.space_id)?.code}</strong> del {formatDate(s.start_date)} al {formatDate(s.end_date)} ({inclusiveDays(s.start_date, s.end_date)} días)</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* 4. Precio y descuentos */}
          <Card title="4. Precio y descuentos">
            <label className="mb-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={courtesy} onChange={(e) => setCourtesy(e.target.checked)} />
              <span><strong>Cortesía familiar</strong> ($0, ocupa el espacio sin generar deuda)</span>
            </label>
            {courtesy ? (
              <TextField label="Familiar beneficiario" value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} maxLength={120} required />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Convenio">
                  <Select value={agreementId} onChange={(e) => setAgreementId(e.target.value)}>
                    <option value="">Sin convenio</option>
                    {validAgreements.map((a) => <option key={a.id} value={a.id}>{a.name} ({Number(a.percent)}%)</option>)}
                  </Select>
                </Field>
                <label className="flex items-center gap-2 self-end pb-2 text-sm">
                  <input type="checkbox" checked={cash} onChange={(e) => setCash(e.target.checked)} />
                  Paga en efectivo (descuento)
                </label>
                {isAdmin && (
                  <>
                    <Field label="Descuento manual (opcional)">
                      <div className="flex gap-2">
                        <Select value={manualType} onChange={(e) => setManualType(e.target.value as "monto" | "porcentaje")} className="w-28">
                          <option value="monto">$</option>
                          <option value="porcentaje">%</option>
                        </Select>
                        <Input inputMode="decimal" value={manualValue} onChange={(e) => setManualValue(e.target.value)} placeholder="0" />
                      </div>
                    </Field>
                    <TextField label="Motivo del descuento manual" value={manualReason} onChange={(e) => setManualReason(e.target.value)} maxLength={300} />
                  </>
                )}
              </div>
            )}
            {isAdmin && (
              <div className="mt-3 border-t border-line pt-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={useManualBase} onChange={(e) => setUseManualBase(e.target.checked)} />
                  Usar un precio manual acordado (en lugar del tarifario)
                </label>
                {useManualBase && <TextField label="Precio acordado (antes de descuentos)" inputMode="decimal" value={manualBase} onChange={(e) => setManualBase(e.target.value)} />}
              </div>
            )}
            <div className="mt-3">
              <Field label="Observaciones"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
            </div>
          </Card>
        </div>

        {/* Resumen */}
        <div className="flex flex-col gap-4 xl:sticky xl:top-4 xl:self-start">
          <Card title="Resumen">
            {!segments ? (
              <p className="text-sm text-muted">Elegí fechas y un espacio para ver el precio.</p>
            ) : quoteLoading && !quote ? (
              <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Calculando…</div>
            ) : quoteError ? (
              <Alert tone="danger">{quoteError}</Alert>
            ) : quote && !quote.ok ? (
              <Alert tone="warn">
                Faltan tarifas para:{" "}
                {quote.faltan_tarifas.map((f) => `${f.space_kind} ${f.half === 1 ? "1ª" : "2ª"} quinc. ${MONTHS_SHORT[f.month - 1]} ${f.year}`).filter((v, i, a) => a.indexOf(v) === i).join(", ")}.{" "}
                {isAdmin ? <><Link className="underline" href="/tarifas">Cargalas en el Tarifario</Link> o usá un precio manual.</> : "Pedile a un administrador que las cargue."}
              </Alert>
            ) : quote && (
              <div className={cx("flex flex-col gap-1 text-sm", quoteLoading && "opacity-60")}>
                {quote.charges.map((c, i) => (
                  <div key={i} className="flex justify-between gap-3"><span className="text-muted">{c.description}</span><span className="tabular">{formatMoney(c.amount)}</span></div>
                ))}
                <div className="flex justify-between gap-3 border-t border-line pt-1"><span>Precio base</span><span className="tabular">{formatMoney(quote.precio_base)}</span></div>
                {quote.discounts.map((d, i) => (
                  <div key={i} className="flex justify-between gap-3 text-ok">
                    <span>{discountLabel(d, agreements)}</span><span className="tabular">− {formatMoney(d.amount)}</span>
                  </div>
                ))}
                {courtesy && <div className="flex justify-between gap-3 text-ok"><span>Cortesía familiar</span><span className="tabular">− {formatMoney(quote.precio_base)}</span></div>}
                <div className="mt-1 flex justify-between gap-3 border-t border-line pt-2 text-base font-semibold"><span>Total</span><span className="tabular">{formatMoney(quote.total)}</span></div>
              </div>
            )}
          </Card>

          {!courtesy && (
            <Card title="5. Pago">
              <div className="mb-3 flex flex-col gap-1.5 text-sm">
                {([["pagada", "Pagada", "Cobra el total ahora"], ["despues", "Cobrar después", "Bloquea el espacio y deja todo el saldo pendiente"], ["sena", "Seña o pago parcial", "Cobra una parte ahora"]] as const).map(([v, l, h]) => (
                  <label key={v} className={cx("flex cursor-pointer items-start gap-2 rounded-lg border p-2", payMode === v ? "border-accent bg-accent-soft" : "border-line")}>
                    <input type="radio" name="pago" checked={payMode === v} onChange={() => setPayMode(v)} className="mt-1" />
                    <span><strong>{l}</strong><span className="block text-xs text-muted">{h}</span></span>
                  </label>
                ))}
              </div>
              {payMode !== "despues" && (
                <div className="grid grid-cols-2 gap-3">
                  {payMode === "sena" ? (
                    <TextField label="Importe recibido" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
                  ) : (
                    <Field label="Importe recibido"><div className="tabular rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">{total === null ? "—" : formatMoney(total)}</div></Field>
                  )}
                  <Field label="Medio de pago">
                    <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                      {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </Select>
                  </Field>
                </div>
              )}
              {method === "efectivo" && payMode !== "despues" && !cash && (
                <p className="mt-2 text-xs text-warn">Paga en efectivo: ¿corresponde marcar el descuento por efectivo en el paso 4?</p>
              )}
              {debt !== null && (
                <div className="mt-3 flex justify-between rounded-lg bg-surface-2 p-2 text-sm">
                  <span>Queda debiendo</span><strong className={cx("tabular", debt > 0 && "text-danger")}>{formatMoney(debt)}</strong>
                </div>
              )}
              <p className="mt-2 text-xs text-muted">Para cobrar se necesita la caja del día abierta. Más adelante se pueden agregar pagos con otros medios desde la reserva.</p>
            </Card>
          )}

          {problems.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-muted">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          )}
          <Button className="w-full py-3 text-base" disabled={!canSave} onClick={() => { setSaveError(null); setConfirmOpen(true); }}>
            Revisar y confirmar
          </Button>
        </div>
      </div>

      {/* Celular: barra fija con el total y el botón de confirmar */}
      <div className="bottom-tabbar fixed inset-x-0 z-20 border-t border-line bg-surface/95 px-4 py-2 backdrop-blur xl:hidden print:hidden">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div className="min-w-0 text-sm">
            <div className="text-xs text-muted">{courtesy ? "Cortesía" : "Total"}</div>
            <div className="tabular truncate text-base font-semibold">
              {quoteLoading ? "Calculando…" : quote?.ok ? formatMoney(quote.total) : "—"}
              {!courtesy && quote?.ok && debt !== null && debt > 0 && <span className="ml-2 text-xs font-normal text-danger">debe {formatMoney(debt)}</span>}
            </div>
            {!canSave && problems[0] && <div className="truncate text-xs text-muted">{problems[0]}</div>}
          </div>
          <Button className="shrink-0 py-3" disabled={!canSave} onClick={() => { setSaveError(null); setConfirmOpen(true); }}>
            Confirmar
          </Button>
        </div>
      </div>
      <div className="h-20 xl:hidden" aria-hidden />

      <CustomerForm
        open={newCustOpen}
        customer={null}
        initialName={custQuery}
        onClose={() => setNewCustOpen(false)}
        onSaved={(c) => { setNewCustOpen(false); setCustomer(c); }}
      />

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Confirmar reserva"
        busy={saving}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={saving}>Volver</Button>
            <Button onClick={save} loading={saving}>Guardar reserva</Button>
          </>
        }
      >
        {customer && segments && quote && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted">Cliente</dt><dd className="font-medium">{customer.first_name} {customer.last_name}</dd>
            <dt className="text-muted">Estadía</dt><dd>{formatDate(start)} al {formatDate(end)} ({nDays} días)</dd>
            <dt className="text-muted">Lugar</dt>
            <dd>{segments.map((s) => `${spaces.find((x) => x.space_id === s.space_id)?.code} (${formatDate(s.start_date)}–${formatDate(s.end_date)})`).join(" → ")}</dd>
            <dt className="text-muted">Total</dt><dd className="font-semibold tabular">{formatMoney(quote.total)}{courtesy ? ` · Cortesía para ${beneficiary}` : ""}</dd>
            {!courtesy && (
              <>
                <dt className="text-muted">Pago</dt>
                <dd>{payMode === "despues" ? "Cobrar después" : `${formatMoney(paidNow)} en ${METHOD_LABEL[method]}`}</dd>
                <dt className="text-muted">Saldo</dt><dd className="tabular">{formatMoney(debt)}</dd>
              </>
            )}
          </dl>
        )}
        {saveError && <Alert tone="danger">{saveError}</Alert>}
        <p className="text-xs text-muted">Al guardar se vuelve a verificar la disponibilidad, por si alguien reservó lo mismo desde otra computadora.</p>
      </Modal>
    </>
  );
}

function discountLabel(d: Quote["discounts"][number], agreements: Agreement[]): string {
  const pct = d.percent !== null && d.percent !== undefined ? ` (${Number(d.percent)}%)` : "";
  switch (d.kind) {
    case "paquete": return d.label ?? `Paquete${pct}`;
    case "convenio": return `Convenio ${agreements.find((a) => a.id === d.agreement_id)?.name ?? ""}${pct}`;
    case "efectivo": return `Pago en efectivo${pct}`;
    case "manual": return `Descuento manual${pct}${d.reason ? ` · ${d.reason}` : ""}`;
    default: return d.kind;
  }
}
