"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { newKey, unwrap } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { addDays, formatDate, formatMoney, inclusiveDays, parseMoney, todayISO } from "@/lib/format";
import { COLLECT_METHODS, METHOD_LABEL } from "@/lib/methods";
import { DollarFields, type DollarValue } from "@/components/dollar";
import { buildSegments, candidatesFor, daysOf, indexGrid, isFreeFor, mapDistance, nearestGroup, splitDays, type GridRow, type Pos, type Segment } from "@/lib/stay";
import { useWorkspace } from "@/components/workspace";
import { useStatus } from "@/components/status";
import { PageHeader } from "@/components/shell";
import { Alert, Badge, Button, Card, Field, Input, Modal, Select, Spinner, Textarea, TextField, cx } from "@/components/ui";
import { CustomerForm, searchCustomers, type Customer } from "@/components/customers";
import { whatsappLink } from "@/lib/reservations";
import { quoteMessage } from "@/lib/whatsapp-messages";
import { ExtrasPicker, useExtrasTotal, type ExtraPick } from "@/components/extras";

type Agreement = { id: string; name: string; percent: number; valid_from: string | null; valid_to: string | null };
type Quote = {
  ok: boolean;
  faltan_tarifas: { space_kind: string; year: number; month: number; half: number }[];
  charges: { description: string; amount: number }[];
  dias: number;
  precio_base: number;
  discounts: { kind: string; percent: number | null; amount: number; label?: string; agreement_id?: string; reason?: string }[];
  total: number;
  /** Descuentos que correspondían pero no se aplicaron (balneario con descuentos no acumulables). */
  no_aplicados?: { kind: string; percent: number; label?: string }[];
  /** Tope de descuento del balneario y si recortó los descuentos. */
  tope?: number | null;
  tope_aplicado?: boolean;
};
type PayMode = "pagada" | "despues" | "sena";

const DURATIONS = [1, 5, 7, 15, 30];
const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export default function NuevaReservaPage() {
  const { ws, isAdmin } = useWorkspace();
  const status = useStatus();
  const sb = getSupabase();
  const today = todayISO(ws.timezone);

  // ---------- Datos iniciales (desde el mapa, la línea de tiempo o la renovación: ?espacio=…&desde=…&hasta=…&cliente=…) ----------
  const [prefill, setPrefill] = useState<{ space: string | null; from: string | null; to: string | null; customer: string | null }>({ space: null, from: null, to: null, customer: null });
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setPrefill({ space: p.get("espacio"), from: p.get("desde"), to: p.get("hasta"), customer: p.get("cliente") });
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
  // Por defecto se eligen entrada y salida; las duraciones (1, 5, 7, 15, 30 días) son un atajo que completa la salida.
  const [start, setStartRaw] = useState(today);
  const [end, setEnd] = useState(addDays(today, 6));
  const nDays = end >= start ? inclusiveDays(start, end) : 0;
  /** Al mover la entrada se conserva la cantidad de días elegida. */
  function setStart(v: string) {
    setStartRaw(v);
    setEnd(addDays(v, Math.max(nDays, 1) - 1));
  }
  useEffect(() => {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (prefill.from && iso.test(prefill.from)) {
      setStart(prefill.from);
      if (prefill.to && iso.test(prefill.to) && prefill.to >= prefill.from) setEnd(prefill.to);
    }
  }, [prefill.from, prefill.to]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!prefill.customer) return;
    sb.from("customers").select("*").eq("workspace_id", ws.id).eq("id", prefill.customer).maybeSingle()
      .then(({ data }) => { if (data) setCustomer(data as Customer); });
  }, [prefill.customer]); // eslint-disable-line react-hooks/exhaustive-deps
  const datesOk = nDays >= 1 && nDays <= 120;

  // ---------- Personas y capacidad ----------
  const [people, setPeople] = useState("");
  const peopleN = /^\d+$/.test(people) && Number(people) > 0 ? Number(people) : null;
  const [caps, setCaps] = useState<{ carpa: number | null; sombrilla: number | null; ready: boolean }>({ carpa: null, sombrilla: null, ready: false });
  useEffect(() => {
    sb.from("workspaces").select("tent_capacity, umbrella_capacity").eq("id", ws.id).single().then(({ data, error }) => {
      if (error) return setCaps({ carpa: null, sombrilla: null, ready: false }); // sin la actualización 0046
      const d = data as { tent_capacity: number | null; umbrella_capacity: number | null };
      setCaps({ carpa: d.tent_capacity, sombrilla: d.umbrella_capacity, ready: true });
    });
  }, [sb, ws.id]);
  // Ubicación de cada espacio en el plano, para sugerir carpas pegadas (no por número).
  const [pos, setPos] = useState<Pos>(new Map());
  useEffect(() => {
    sb.from("spaces").select("id, x, y").eq("workspace_id", ws.id).eq("active", true).then(({ data }) => {
      setPos(new Map(((data ?? []) as { id: string; x: number; y: number }[]).map((r) => [r.id, { x: Number(r.x), y: Number(r.y) }])));
    });
  }, [sb, ws.id]);

  // ---------- Disponibilidad ----------
  const [kind, setKind] = useState<"carpa" | "sombrilla">("carpa");
  const [grid, setGrid] = useState<GridRow[] | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  const [gridLoading, setGridLoading] = useState(false);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [runChoice, setRunChoice] = useState<Record<string, string>>({}); // inicio de tramo ocupado → espacio alternativo
  // Si el espacio elegido está ocupado algunos días, el usuario decide qué hacer (nunca se cambia de lugar solo).
  const [plan, setPlan] = useState<"cambiar" | null>(null);
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
    return split.busyRuns.map((run) => ({ run, candidates: candidatesFor(idx, spaces, run, selected.space_id, selected.code, pos) }));
  }, [split, selected, idx, spaces, pos]);

  // ---------- Grupo: varias carpas juntas ----------
  const cap = caps[kind];
  const needed = cap && peopleN ? Math.ceil(peopleN / cap) : 1;
  const [groupIds, setGroupIds] = useState<string[]>([]);
  // Si las personas superan el máximo, se preseleccionan las carpas que faltan, pegadas a la elegida en el plano.
  useEffect(() => {
    if (!spaceId || !grid) return;
    const free = fullyFree.map((s) => s.space_id).filter((id) => id !== spaceId);
    setGroupIds(needed > 1 ? nearestGroup(spaceId, free, needed - 1, pos) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, needed, start, end, kind, grid === null, pos.size]);
  const groupSpaces = groupIds.map((id) => spaces.find((s) => s.space_id === id)).filter((s): s is NonNullable<typeof s> => !!s);
  const isGroup = groupSpaces.length > 0;
  /** Carpas libres toda la estadía para sumar al grupo, primero las más cercanas a las ya elegidas. */
  const groupCandidates = useMemo(() => {
    if (!spaceId) return [];
    const base = [spaceId, ...groupIds];
    return fullyFree
      .filter((s) => !base.includes(s.space_id))
      .map((s) => ({ ...s, d: Math.min(...base.map((b) => mapDistance(pos, b, s.space_id))) }))
      .sort((a, b) => a.d - b.d || a.code.localeCompare(b.code, "es", { numeric: true }))
      .slice(0, 10);
  }, [fullyFree, spaceId, groupIds, pos]);
  const capacityTotal = cap ? cap * (1 + groupSpaces.length) : null;
  /** Grupos recomendados: conjuntos de carpas libres toda la estadía, pegadas entre sí en el plano. */
  const groupSuggestions = useMemo(() => {
    if (needed <= 1 || pos.size === 0) return [];
    const free = fullyFree.map((s) => s.space_id).filter((id) => pos.has(id));
    const seen = new Set<string>();
    const out: { ids: string[]; cost: number }[] = [];
    for (const seed of free) {
      const rest = nearestGroup(seed, free, needed - 1, pos);
      if (rest.length < needed - 1) continue;
      const ids = [seed, ...rest];
      const key = [...ids].sort().join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      let cost = 0;
      rest.forEach((id, i) => { cost += Math.min(...ids.slice(0, i + 1).map((c) => mapDistance(pos, c, id))); });
      out.push({ ids, cost });
    }
    const code = (id: string) => spaces.find((s) => s.space_id === id)?.code ?? "";
    return out
      .sort((a, b) => a.cost - b.cost || code(a.ids[0]).localeCompare(code(b.ids[0]), "es", { numeric: true }))
      .slice(0, 5)
      .map((g) => ({ ...g, ids: [...g.ids].sort((a, b) => code(a).localeCompare(code(b), "es", { numeric: true })) }));
  }, [needed, fullyFree, pos, spaces]);
  const groupMode = needed > 1 || isGroup;
  const [gridNote, setGridNote] = useState<string | null>(null);
  function pickSpace(id: string, tone: "free" | "partial" | "none") {
    setGridNote(null);
    if (groupMode && spaceId) {
      if (id === spaceId) { setSpaceId(null); setGroupIds([]); return; } // tocar la principal: empezar de nuevo
      if (groupIds.includes(id)) { setGroupIds((p) => p.filter((x) => x !== id)); return; }
      if (tone !== "free") { setGridNote("Para el grupo, elegí carpas libres toda la estadía (en verde)."); return; }
      if (groupIds.length >= 9) { setGridNote("Un grupo puede tener hasta 10 espacios."); return; }
      setGroupIds((p) => [...p, id]);
      return;
    }
    setSpaceId(id);
  }

  const segments: Segment[] | null = useMemo(() => {
    if (!selected || !split) return null;
    if (split.free.length === 0) return null; // no tiene ningún día libre
    const assign: { day: string; space_id: string }[] = [];
    for (const d of split.free) assign.push({ day: d, space_id: selected.space_id });
    for (const { run, candidates } of busyOptions) {
      if (plan !== "cambiar") return null; // todavía no decidió qué hacer con los días ocupados
      const chosen = runChoice[run.start];
      if (!chosen || !candidates.some((c) => c.space_id === chosen)) return null; // falta elegir a dónde pasa
      for (const d of daysOf(run.start, run.end)) assign.push({ day: d, space_id: chosen });
    }
    return buildSegments(assign);
  }, [selected, split, busyOptions, runChoice, plan]);
  const noAlternative = busyOptions.some((b) => b.candidates.length === 0);

  useEffect(() => { setRunChoice({}); setPlan(null); }, [spaceId, start, end]);
  /** Quién ocupa el espacio elegido el primer día de un tramo ocupado. */
  const busyReason = (day: string) => (grid ?? []).find((r) => r.space_id === spaceId && r.day === day)?.reason ?? null;

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
  /** Precio pagando en efectivo (solo para el presupuesto, cuando no está marcado el descuento). */
  const [cashTotal, setCashTotal] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
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
      const withCash = !courtesy && !cash;
      const [{ data, error }, cashRes] = await Promise.all([
        sb.rpc("quote_reservation", { p_workspace_id: ws.id, p_start: start, p_end: end, p_segments: segments, p_options: options }),
        withCash ? sb.rpc("quote_reservation", { p_workspace_id: ws.id, p_start: start, p_end: end, p_segments: segments, p_options: { ...options, cash: true } }) : Promise.resolve(null),
      ]);
      if (my !== quoteSeq.current) return;
      const cq = cashRes && !cashRes.error ? (cashRes.data as Quote) : null;
      setCashTotal(cq?.ok ? Number(cq.total) : null);
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

  // Precio de cada carpa extra del grupo (toda la estadía; el descuento manual en pesos va solo en la principal).
  const [groupQuote, setGroupQuote] = useState<{ total: number; cash: number | null } | null>(null);
  const groupKey = groupSpaces[0]?.space_id ?? "";
  useEffect(() => {
    setGroupQuote(null);
    if (!groupKey || !datesOk) return;
    const o = { ...options } as Record<string, unknown>;
    if ((o.manual as { type?: string } | undefined)?.type === "monto") delete o.manual;
    const seg = [{ space_id: groupKey, start_date: start, end_date: end }];
    let alive = true;
    const t = setTimeout(async () => {
      const [a, b] = await Promise.all([
        sb.rpc("quote_reservation", { p_workspace_id: ws.id, p_start: start, p_end: end, p_segments: seg, p_options: o }),
        !courtesy && !cash ? sb.rpc("quote_reservation", { p_workspace_id: ws.id, p_start: start, p_end: end, p_segments: seg, p_options: { ...o, cash: true } }) : Promise.resolve(null),
      ]);
      if (!alive) return;
      const qa = a.error ? null : (a.data as Quote);
      const qb = b && !b.error ? (b.data as Quote) : null;
      setGroupQuote(qa?.ok ? { total: Number(qa.total), cash: qb?.ok ? Number(qb.total) : null } : null);
    }, 300);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey, optKey, start, end, ws.id, datesOk]);
  const groupTotal = isGroup && groupQuote ? groupQuote.total * groupSpaces.length : 0;

  // ---------- Pago ----------
  const [payMode, setPayMode] = useState<PayMode>("pagada");
  const [method, setMethod] = useState("efectivo");
  // Descuento por efectivo del balneario (Convenios y descuentos). Si paga en efectivo se marca solo;
  // se puede destildar a mano si en este caso no corresponde.
  const [cashPercent, setCashPercent] = useState<number | null>(null);
  useEffect(() => {
    sb.from("workspaces").select("cash_discount_percent").eq("id", ws.id).single()
      .then(({ data }) => setCashPercent(data ? Number((data as { cash_discount_percent: number }).cash_discount_percent) : null));
  }, [sb, ws.id]);
  useEffect(() => {
    if (courtesy || cashPercent === null) return;
    setCash(cashPercent > 0 && method === "efectivo" && payMode !== "despues");
  }, [method, payMode, cashPercent, courtesy]);
  const [deposit, setDeposit] = useState("");
  const [usd, setUsd] = useState<DollarValue>({ usd: null, rate: null, ars: null });
  // Extras elegidos (reposeras, estacionamiento…): se suman al total y al cobro.
  const [extras, setExtras] = useState<ExtraPick[]>([]);
  const extrasForStay = courtesy ? [] : extras.map((x) => ({ ...x, days: Math.min(x.days, Math.max(1, nDays)) }));
  const extrasTotal = useExtrasTotal(extrasForStay);
  const total = quote?.ok && (!isGroup || groupQuote) ? Number(quote.total) + groupTotal + extrasTotal : null;
  const paidNow = courtesy || payMode === "despues" ? 0
    : method === "dolares" ? Math.min(usd.ars ?? 0, total ?? 0)
    : payMode === "pagada" ? total ?? 0 : parseMoney(deposit) ?? 0;
  const debt = total === null ? null : Math.max(total - paidNow, 0);

  // ---------- Guardar ----------
  const [requestId, setRequestId] = useState(newKey);
  const [paymentKey, setPaymentKey] = useState(newKey);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; number: number; group?: { id: string; number: number }[] } | null>(null);

  const problems: string[] = [];
  if (!customer) problems.push("Elegí o creá el cliente.");
  if (!datesOk) problems.push(nDays > 120 ? "La estadía puede ser de hasta 120 días." : "Revisá las fechas.");
  if (!selected) problems.push("Elegí una carpa o sombrilla.");
  else if (split && split.free.length === 0) problems.push(`${selected.code} está ocupada todos esos días. Elegí otra.`);
  else if (split && split.busy.length > 0 && plan !== "cambiar") problems.push(`${selected.code} está ocupada algunos días: elegí qué hacer en el paso 3.`);
  else if (noAlternative) problems.push("No hay alternativas libres para algunos días: elegí otro espacio o cambiá las fechas.");
  else if (split && split.busy.length > 0 && busyOptions.some((b) => !runChoice[b.run.start])) problems.push("Elegí a qué carpa pasa el cliente los días ocupados.");
  if (isGroup && split && split.busy.length > 0) problems.push(`Para un grupo, la ${selected?.code ?? "carpa"} principal tiene que estar libre toda la estadía. Elegí otra.`);
  if (isGroup && !courtesy && payMode !== "despues" && method === "dolares") problems.push("En una reserva de grupo cobrá en pesos; los dólares se registran después desde cada reserva.");
  if (people && !peopleN) problems.push("Revisá la cantidad de personas.");
  if (quote && !quote.ok) problems.push("Faltan tarifas para esas fechas.");
  if (courtesy && beneficiary.trim().length < 2) problems.push("Indicá el familiar beneficiario de la cortesía.");
  if (!courtesy && payMode !== "despues" && method === "dolares") {
    if (!usd.usd || !usd.rate) problems.push("Ingresá los dólares recibidos y la cotización.");
    else if (total !== null && (usd.ars ?? 0) - total >= Math.max(1, usd.rate * 0.01)) problems.push("Los dólares superan el total: bajá el monto y da el vuelto en pesos.");
    else if (payMode === "pagada" && total !== null && total - (usd.ars ?? 0) >= 1) problems.push("Los dólares no cubren el total: elegí «Seña o pago parcial» o tocá «Todo el saldo».");
  } else if (!courtesy && payMode === "sena") {
    const d = parseMoney(deposit);
    if (!d || d <= 0) problems.push("Ingresá el importe de la seña.");
    else if (total !== null && d > total) problems.push("La seña no puede superar el total.");
  }
  if (!courtesy && payMode === "pagada" && total === 0) problems.push("El total es $0: elegí «Cobrar después» o marcá cortesía.");
  const manualDiscountValue = manualType === "monto" ? parseMoney(manualValue) : Number(manualValue.replace(",", "."));
  if (isAdmin && !courtesy && manualDiscountValue && manualDiscountValue > 0 && manualReason.trim().length < 3) problems.push("El descuento manual necesita un motivo.");
  const canSave = problems.length === 0 && !!quote?.ok && !quoteLoading && !!segments && (!isGroup || !!groupQuote);

  async function save() {
    if (!customer || !segments) return;
    setSaving(true);
    setSaveError(null);
    const payment = !courtesy && payMode !== "despues" && paidNow > 0
      ? method === "dolares"
        ? { amount: paidNow, method, idempotency_key: paymentKey, usd_amount: usd.usd, exchange_rate: usd.rate }
        : { amount: paidNow, method, idempotency_key: paymentKey }
      : null;
    const withExtras = extrasForStay.length > 0;
    // Con personas o con varias carpas se usa la operación de grupo (también sirve para una sola carpa).
    if (isGroup || peopleN) {
      const { data, error } = await sb.rpc("create_reservation_group", {
        p_workspace_id: ws.id, p_request_id: requestId, p_customer_id: customer.id, p_start_date: start, p_end_date: end,
        p_segments: segments, p_extra_spaces: groupSpaces.map((g) => g.space_id), p_options: options, p_notes: notes.trim() || null,
        p_payment: payment, p_extras: extrasForStay, p_people: peopleN,
      });
      setSaving(false);
      if (error) {
        if (error.code === "PGRST202") { setSaveError("Para guardar personas y grupos hay que aplicar la actualización 0046 de la base de datos."); return; }
        setSaveError(friendlyError(error));
        if (error.hint === "CONFLICTO_DISPONIBILIDAD") loadGrid();
        return;
      }
      const res = data as { reservation_id: string; number: number; reservations?: { id: string; number: number }[] };
      setConfirmOpen(false);
      setDone({ id: res.reservation_id, number: res.number, group: res.reservations && res.reservations.length > 1 ? res.reservations : undefined });
      status.reload();
      return;
    }
    const { data, error } = await sb.rpc(withExtras ? "create_reservation_v3" : "create_reservation_v2", {
      p_workspace_id: ws.id,
      p_request_id: requestId,
      p_customer_id: customer.id,
      p_start_date: start,
      p_end_date: end,
      p_segments: segments,
      p_options: options,
      p_notes: notes.trim() || null,
      p_payment: payment,
      ...(withExtras ? { p_extras: extrasForStay } : {}),
    });
    setSaving(false);
    if (error) {
      if (withExtras && error.code === "PGRST202") { setSaveError("Para guardar extras al reservar hay que aplicar la actualización 0042 de la base de datos. Mientras tanto, sacá los extras y sumalos desde la reserva."); return; }
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
    setExtras([]);
    setCustomer(null);
    setCustQuery("");
    setSpaceId(null);
    setGroupIds([]);
    setPeople("");
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

  const quoteText = quote?.ok && segments && !courtesy ? quoteMessage({
    firstName: customer?.first_name ?? null,
    balneario: ws.name,
    places: isGroup
      ? `${kind === "carpa" ? "Carpas" : "Sombrillas"} ${[selected?.code ?? "", ...groupSpaces.map((g) => g.code)].join(", ")}`
      : segments.length === 1
      ? `${kind === "carpa" ? "Carpa" : "Sombrilla"} ${spaces.find((x) => x.space_id === segments[0].space_id)?.code ?? ""}`
      : segments.map((sg) => `${kind === "carpa" ? "Carpa" : "Sombrilla"} ${spaces.find((x) => x.space_id === sg.space_id)?.code ?? ""} (${formatDate(sg.start_date).slice(0, 5)} al ${formatDate(sg.end_date).slice(0, 5)})`).join(", "),
    start, end,
    total: Number(quote.total) + groupTotal + extrasTotal,
    cashTotal: cashTotal !== null ? cashTotal + (isGroup && groupQuote ? (groupQuote.cash ?? groupQuote.total) * groupSpaces.length : 0) + extrasTotal : null,
    discounts: quote.discounts.map((d) => clientDiscountLabel(d, agreements)),
  }) : null;

  if (done) {
    return (
      <div className="mx-auto max-w-lg">
        <Alert tone="ok" className="mb-4 text-base">
          {done.group
            ? <><strong>Grupo guardado: reservas {done.group.map((g) => `#${g.number}`).join(", ")}.</strong> Las carpas quedaron unidas; el cobro se repartió entre ellas.</>
            : <><strong>Reserva #{done.number} guardada.</strong> Ya figura en el mapa, en la caja (si hubo cobro) y en todas las computadoras.</>}
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
              <Field label="Salida (último día)">
                <Input type="date" value={end} min={start} onChange={(e) => e.target.value && setEnd(e.target.value)} className="w-auto" />
              </Field>
            </div>
            <div className="mt-3">
              <div className="mb-1 text-xs text-muted">O elegí una duración desde la entrada:</div>
              <div className="flex flex-wrap gap-1">
                {DURATIONS.map((d) => (
                  <button key={d} type="button" onClick={() => setEnd(addDays(start, d - 1))}
                    className={cx("rounded-lg border px-3 py-2 text-sm", nDays === d ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-surface-2")}>
                    {d} {d === 1 ? "día" : "días"}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-3 text-sm">
              {datesOk ? <>Del <strong>{formatDate(start)}</strong> al <strong>{formatDate(end)}</strong> · {nDays} {nDays === 1 ? "día" : "días"}</> : <span className="text-danger">{nDays > 120 ? "Máximo 120 días." : "La salida no puede ser anterior a la entrada."}</span>}
              {start < today && <Badge tone="warn">Fecha pasada</Badge>}
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-line pt-3">
              <Field label="Personas">
                <Input inputMode="numeric" value={people} onChange={(e) => setPeople(e.target.value.replace(/\D/g, "").slice(0, 3))} placeholder="Opcional" className="w-28" aria-label="Cantidad de personas" />
              </Field>
              <p className="pb-2 text-xs text-muted">
                {cap ? <>Máximo {cap} por {kind}.{needed > 1 && <strong className="text-fg"> Son {peopleN}: hacen falta {needed} {kind === "carpa" ? "carpas" : "sombrillas"}.</strong>}</>
                  : caps.ready ? <>Sin máximo de personas. {isAdmin && <Link href="/configuracion#reglas" className="text-accent underline">Fijarlo en Configuración</Link>}</> : null}
              </p>
            </div>
          </Card>

          {/* 3. Espacio */}
          <Card
            title="3. Carpa o sombrilla"
            tour="nr-espacio"
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
                {groupMode && (
                  <div className="mb-3 rounded-lg border border-accent/40 bg-accent-soft/40 p-3 text-sm">
                    <div className="font-medium">
                      {needed > 1 ? `Son ${peopleN} personas: hacen falta ${needed} ${kind === "carpa" ? "carpas" : "sombrillas"}.` : "Grupo de varias carpas."}{" "}
                      <span className="font-normal text-muted">Tocá en la lista las que quieras (la primera es la principal; tocala de nuevo para empezar otra vez).</span>
                    </div>
                    {groupSuggestions.length > 0 && (
                      <div className="mt-2">
                        <div className="mb-1 text-xs text-muted">Recomendadas, pegadas en el plano y libres toda la estadía:</div>
                        <div className="flex flex-wrap gap-1.5">
                          {groupSuggestions.map((g) => {
                            const on = spaceId === g.ids[0] && g.ids.slice(1).every((id) => groupIds.includes(id)) && groupIds.length === g.ids.length - 1;
                            return (
                              <button key={g.ids.join(",")} type="button" onClick={() => { setGridNote(null); setSpaceId(g.ids[0]); setGroupIds(g.ids.slice(1)); }}
                                className={cx("rounded-md border px-2.5 py-1 font-semibold tabular", on ? "border-accent bg-accent text-accent-fg" : "border-ok/50 bg-ok-soft text-ok hover:bg-ok/20")}>
                                {g.ids.map((id) => spaces.find((x) => x.space_id === id)?.code).join(" + ")}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {needed > 1 && groupSuggestions.length === 0 && pos.size > 0 && (
                      <p className="mt-1 text-xs text-warn">No hay {needed} {kind === "carpa" ? "carpas" : "sombrillas"} libres toda la estadía para armar el grupo.</p>
                    )}
                  </div>
                )}
                {gridNote && <Alert tone="warn" className="mb-2">{gridNote}</Alert>}
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
                        onClick={() => pickSpace(s.space_id, tone)}
                        title={tone === "free" ? "Libre toda la estadía" : tone === "partial" ? `Libre ${sp.free.length} de ${days.length} días` : "Sin días libres"}
                        className={cx(
                          "rounded-md border py-1.5 text-sm font-semibold tabular",
                          tone === "free" && "border-ok/50 bg-ok-soft text-ok",
                          tone === "partial" && "border-warn/50 bg-warn-soft text-warn",
                          tone === "none" && "border-line bg-surface-2 text-muted opacity-60",
                          spaceId === s.space_id && "ring-2 ring-accent",
                          groupIds.includes(s.space_id) && "ring-2 ring-accent ring-offset-1 ring-offset-surface",
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
                      <div>
                        <strong>{selected.code}</strong> está libre {split.freeRuns.map((r) => r.start === r.end ? `el ${formatDate(r.start)}` : `del ${formatDate(r.start)} al ${formatDate(r.end)}`).join(" y ")}.
                      </div>
                      {split.busyRuns.map((r) => (
                        <div key={r.start}>
                          {r.start === r.end ? `El ${formatDate(r.start)}` : `Del ${formatDate(r.start)} al ${formatDate(r.end)}`} {busyReason(r.start) === "mantenimiento" ? "está en mantenimiento" : busyReason(r.start) === "desactivada" ? "está desactivada" : "ya está reservada por otro cliente"}.
                        </div>
                      ))}
                      <div className="mt-1 font-semibold">¿Qué hacemos?</div>
                    </Alert>

                    <ChoiceCard active={plan === "cambiar"} onClick={() => setPlan("cambiar")}
                      title={<>Darle la {selected.code} los días libres y otra {kind === "carpa" ? "carpa" : "sombrilla"} los días ocupados</>}
                      detail="Sigue siendo una sola reserva y un solo pago. Mismo tipo de espacio: el precio no cambia." />
                    {plan === "cambiar" && busyOptions.map(({ run, candidates }) => (
                      <div key={run.start} className="ml-4 rounded-lg border border-line p-2">
                        <div className="mb-1.5 font-medium">
                          {run.start === run.end ? `El ${formatDate(run.start)}` : `Del ${formatDate(run.start)} al ${formatDate(run.end)}`} ({run.days} {run.days === 1 ? "día" : "días"}) pasa a:
                        </div>
                        {candidates.length === 0 ? (
                          <Badge tone="danger">No hay {kind === "carpa" ? "carpas" : "sombrillas"} libres esos días</Badge>
                        ) : (
                          <>
                            <div className="flex flex-wrap gap-1.5">
                              {candidates.slice(0, 16).map((c) => (
                                <button key={c.space_id} type="button" onClick={() => setRunChoice((p) => ({ ...p, [run.start]: c.space_id }))}
                                  className={cx("rounded-md border px-2.5 py-1 text-sm font-semibold tabular",
                                    runChoice[run.start] === c.space_id ? "border-accent bg-accent text-accent-fg" : "border-ok/50 bg-ok-soft text-ok hover:bg-ok/20")}>
                                  {c.code}
                                </button>
                              ))}
                              {candidates.length > 16 && (
                                <Select value={candidates.slice(16).some((c) => c.space_id === runChoice[run.start]) ? runChoice[run.start] : ""}
                                  onChange={(e) => e.target.value && setRunChoice((p) => ({ ...p, [run.start]: e.target.value }))} className="w-auto py-1 text-sm" aria-label="Otras opciones">
                                  <option value="">Otras ({candidates.length - 16})…</option>
                                  {candidates.slice(16).map((c) => <option key={c.space_id} value={c.space_id}>{c.code}</option>)}
                                </Select>
                              )}
                            </div>
                            <p className="mt-1 text-xs text-muted">Primero las más cercanas a la {selected.code}. Todas están libres esos {run.days} {run.days === 1 ? "día" : "días"}.</p>
                          </>
                        )}
                      </div>
                    ))}

                    <ChoiceCard active={false} onClick={() => document.getElementById("otra-completa")?.scrollIntoView({ behavior: "smooth", block: "center" })}
                      title={<>Darle otra {kind === "carpa" ? "carpa" : "sombrilla"} libre los {days.length} días, sin mudanza</>}
                      detail={fullyFree.length === 0 ? `No hay ninguna libre los ${days.length} días.` : "Tocá una:"} />
                    {fullyFree.length > 0 && (
                      <div id="otra-completa" className="ml-4 flex flex-wrap gap-1.5">
                        {fullyFree.slice(0, 16).map((s) => (
                          <button key={s.space_id} type="button" onClick={() => setSpaceId(s.space_id)}
                            className="rounded-md border border-ok/50 bg-ok-soft px-2.5 py-1 text-sm font-semibold tabular text-ok hover:bg-ok/20">{s.code}</button>
                        ))}
                        {fullyFree.length > 16 && <span className="self-center text-xs text-muted">y {fullyFree.length - 16} más en la lista de arriba</span>}
                      </div>
                    )}

                    {split.freeRuns[0]?.start === start && (
                      <ChoiceCard active={false} onClick={() => setEnd(split.freeRuns[0].end)}
                        title={<>Acortar la estadía: quedarse en la {selected.code} hasta el {formatDate(split.freeRuns[0].end)}</>}
                        detail={`Pasa a ${split.freeRuns[0].days} ${split.freeRuns[0].days === 1 ? "día" : "días"} y el precio se recalcula.`} />
                    )}
                  </div>
                )}
                {spaceId && grid && !isGroup && needed <= 1 && groupCandidates.length > 0 && split?.busy.length === 0 && (
                  <button type="button" onClick={() => setGroupIds([groupCandidates[0].space_id])} className="mt-3 text-sm text-accent hover:underline">
                    + ¿Son varios? Sumar la {groupCandidates[0].code}, que está pegada
                  </button>
                )}
                {spaceId && grid && (isGroup || needed > 1) && (
                  <div className="mt-3 rounded-lg border border-accent/40 bg-accent-soft/40 p-3">
                    <div className="mb-1 font-medium">
                      {isGroup ? <>Grupo: {[selected?.code, ...groupSpaces.map((g) => g.code)].join(" + ")}</> : `Hacen falta ${needed} ${kind === "carpa" ? "carpas" : "sombrillas"}`}
                    </div>
                    {isGroup && <p className="mb-2 text-xs text-muted">Se guardan juntas, mismas fechas y mismo cliente. Un solo cobro que se reparte entre las {1 + groupSpaces.length}.</p>}
                    {capacityTotal !== null && peopleN !== null && peopleN > capacityTotal && (
                      <Alert tone="warn" className="mb-2">Son {peopleN} personas y {1 + groupSpaces.length === 1 ? "esta carpa alcanza" : `estas ${1 + groupSpaces.length} alcanzan`} para {capacityTotal}. Sumá otra.</Alert>
                    )}
                    {needed > 1 && groupSpaces.length < needed - 1 && groupCandidates.length === 0 && (
                      <Alert tone="danger" className="mb-2">No hay más {kind === "carpa" ? "carpas" : "sombrillas"} libres toda la estadía para el grupo.</Alert>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {groupSpaces.map((g) => (
                        <button key={g.space_id} type="button" onClick={() => setGroupIds((p) => p.filter((x) => x !== g.space_id))}
                          className="rounded-md border border-accent bg-accent px-2.5 py-1 text-sm font-semibold tabular text-accent-fg" title="Sacar del grupo">
                          {g.code} ✕
                        </button>
                      ))}
                      {groupSpaces.length < 9 && groupCandidates.slice(0, 6).map((c) => (
                        <button key={c.space_id} type="button" onClick={() => setGroupIds((p) => [...p, c.space_id])}
                          className="rounded-md border border-ok/50 bg-ok-soft px-2.5 py-1 text-sm font-semibold tabular text-ok hover:bg-ok/20" title="Sumar al grupo">
                          + {c.code}
                        </button>
                      ))}
                    </div>
                    {groupCandidates.length > 0 && <p className="mt-1 text-xs text-muted">Primero las más cercanas en el plano. Todas libres toda la estadía.</p>}
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
                {cashPercent !== 0 && (
                  <label className="flex items-center gap-2 self-end pb-2 text-sm">
                    <input type="checkbox" checked={cash} onChange={(e) => setCash(e.target.checked)} />
                    <span>Paga en efectivo ({cashPercent ?? 10}% de descuento){cash && method === "efectivo" && payMode !== "despues" && <span className="block text-xs text-muted">Se marcó solo porque el pago es en efectivo.</span>}</span>
                  </label>
                )}
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
            <div className="mt-3 border-t border-line pt-3" data-tour="nr-extras">
              <ExtrasPicker stayDays={Math.max(1, nDays)} value={extras} onChange={setExtras} disabled={courtesy} />
            </div>
            <div className="mt-3">
              <Field label="Observaciones"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
            </div>
          </Card>
        </div>

        {/* Resumen */}
        <div className="flex flex-col gap-4 xl:sticky xl:top-4 xl:self-start">
          <Card title="Resumen" tour="nr-resumen">
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
                {isGroup && <div className="text-xs font-semibold uppercase tracking-wide text-muted">Precio de cada carpa</div>}
                {quote.charges.map((c, i) => (
                  <div key={i} className="flex justify-between gap-3"><span className="text-muted">{c.description}</span><span className="tabular">{formatMoney(c.amount)}</span></div>
                ))}
                <div className="flex justify-between gap-3 border-t border-line pt-1"><span>Precio base</span><span className="tabular">{formatMoney(quote.precio_base)}</span></div>
                {quote.discounts.map((d, i) => (
                  <div key={i} className="flex justify-between gap-3 text-ok">
                    <span>{discountLabel(d, agreements)}</span><span className="tabular">− {formatMoney(d.amount)}</span>
                  </div>
                ))}
                {!courtesy && quote.tope_aplicado && (
                  <div className="text-xs text-warn">Tope de descuento del balneario: {Number(quote.tope)}% del precio. Los descuentos se recortaron para no pasarlo.</div>
                )}
                {!courtesy && (quote.no_aplicados?.length ?? 0) > 0 && (
                  <div className="text-xs text-muted">
                    No acumulables: se aplicó solo el mayor. Quedaron afuera: {quote.no_aplicados!.map((d) => `${d.label ?? d.kind} ${Number(d.percent)}%`).join(", ")}.
                  </div>
                )}
                {courtesy && <div className="flex justify-between gap-3 text-ok"><span>Cortesía familiar</span><span className="tabular">− {formatMoney(quote.precio_base)}</span></div>}
                {isGroup && (
                  <>
                    <div className="mt-1 flex justify-between gap-3 border-t border-line pt-1">
                      <span>{kind === "carpa" ? "Carpa" : "Sombrilla"} {selected?.code}</span><span className="tabular">{formatMoney(quote.total)}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span>
                        {groupSpaces.map((g) => g.code).join(", ")}{" "}
                        <span className="text-xs text-muted">({groupSpaces.length} × {groupQuote ? formatMoney(groupQuote.total) : "…"}, con los mismos descuentos{options.manual && (options.manual as { type?: string }).type === "monto" ? "; el descuento manual en pesos va una sola vez" : ""})</span>
                      </span>
                      <span className="tabular">{groupQuote ? formatMoney(groupTotal) : "…"}</span>
                    </div>
                  </>
                )}
                {!courtesy && extrasTotal > 0 && <div className="flex justify-between gap-3"><span>Extras</span><span className="tabular">+ {formatMoney(extrasTotal)}</span></div>}
                <div className="mt-1 flex justify-between gap-3 border-t border-line pt-2 text-base font-semibold"><span>Total</span><span className="tabular">{formatMoney(total)}</span></div>
                {cashTotal !== null && cashTotal < Number(quote.total) && (
                  <div className="flex justify-between gap-3 text-xs text-muted"><span>Pagando en efectivo</span><span className="tabular">{formatMoney(cashTotal + (isGroup && groupQuote ? (groupQuote.cash ?? groupQuote.total) * groupSpaces.length : 0) + (courtesy ? 0 : extrasTotal))}</span></div>
                )}
                {!courtesy && quoteText && (
                  <div className="mt-3 border-t border-line pt-3">
                    <div className="mb-1.5 text-xs text-muted">¿Solo pregunta el precio? Mandale el presupuesto sin reservar:</div>
                    <div className="flex flex-wrap gap-2">
                      <a href={whatsappLink(customer?.phone ?? null, quoteText) ?? `https://wa.me/?text=${encodeURIComponent(quoteText)}`} target="_blank" rel="noopener noreferrer"
                        className="rounded-lg border border-green-600/40 bg-green-50 px-3 py-1.5 text-sm font-semibold text-green-800 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-200">
                        Presupuesto por WhatsApp
                      </a>
                      <button type="button" onClick={() => navigator.clipboard?.writeText(quoteText).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => { /* sin permiso */ })}
                        className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface-2">{copied ? "Copiado" : "Copiar texto"}</button>
                    </div>
                    {!customer?.phone && <p className="mt-1 text-xs text-muted">Sin cliente con teléfono: WhatsApp te deja elegir a quién mandarlo.</p>}
                  </div>
                )}
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
              {payMode !== "despues" && method === "dolares" && (
                <div className="flex flex-col gap-3">
                  <Field label="Medio de pago">
                    <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                      {COLLECT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </Select>
                  </Field>
                  <DollarFields due={total ?? 0} onChange={setUsd} />
                </div>
              )}
              {payMode !== "despues" && method !== "dolares" && (
                <div className="grid grid-cols-2 gap-3">
                  {payMode === "sena" ? (
                    <TextField label="Importe recibido" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
                  ) : (
                    <Field label="Importe recibido"><div className="tabular rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">{total === null ? "—" : formatMoney(total)}</div></Field>
                  )}
                  <Field label="Medio de pago">
                    <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                      {COLLECT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </Select>
                  </Field>
                </div>
              )}
              {method === "efectivo" && payMode !== "despues" && !cash && !!cashPercent && (
                <p className="mt-2 text-xs text-warn">Paga en efectivo pero el descuento está destildado en el paso 4.</p>
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
              {quoteLoading ? "Calculando…" : quote?.ok ? formatMoney(total) : "—"}
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
            <dd>
              {segments.map((s) => `${spaces.find((x) => x.space_id === s.space_id)?.code} (${formatDate(s.start_date)}–${formatDate(s.end_date)})`).join(" → ")}
              {isGroup && <> + {groupSpaces.map((g) => g.code).join(", ")} <span className="text-muted">(grupo)</span></>}
            </dd>
            {peopleN && <><dt className="text-muted">Personas</dt><dd>{peopleN}</dd></>}
            <dt className="text-muted">Total</dt><dd className="font-semibold tabular">{formatMoney(total)}{!courtesy && extrasTotal > 0 ? ` (con ${formatMoney(extrasTotal)} de extras)` : ""}{courtesy ? ` · Cortesía para ${beneficiary}` : ""}</dd>
            {!courtesy && (
              <>
                <dt className="text-muted">Pago</dt>
                <dd>{payMode === "despues" ? "Cobrar después" : `${formatMoney(paidNow)} en ${METHOD_LABEL[method]}${method === "dolares" && usd.usd ? ` (US$ ${usd.usd} a ${formatMoney(usd.rate ?? 0)})` : ""}`}</dd>
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

/** Igual que discountLabel pero sin el motivo interno de los descuentos manuales (va al cliente). */
function clientDiscountLabel(d: Quote["discounts"][number], agreements: Agreement[]): string {
  if (d.kind === "manual") return `Descuento${d.percent !== null && d.percent !== undefined ? ` ${Number(d.percent)}%` : ` de ${formatMoney(d.amount)}`}`;
  return discountLabel(d, agreements);
}

function ChoiceCard({ active, onClick, title, detail }: { active: boolean; onClick: () => void; title: ReactNode; detail?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cx("flex items-start gap-2 rounded-lg border p-2.5 text-left", active ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2")}>
      <span className={cx("mt-0.5 inline-block h-4 w-4 shrink-0 rounded-full border-2", active ? "border-accent bg-accent" : "border-line")} />
      <span><span className="block font-semibold">{title}</span>{detail && <span className="block text-xs text-muted">{detail}</span>}</span>
    </button>
  );
}
