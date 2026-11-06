"use client";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { addDays, formatDate, formatMoney } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";

export type Counts = { total_activos: number; ocupados: number; cortesias: number; disponibles: number; mantenimiento: number; desactivados: number };
export type ResItem = {
  reservation_id: string; number: number; customer: string; phone: string | null;
  start_date: string; end_date: string; spaces: string | null; due_amount: number; is_courtesy: boolean;
};
export type Summary = {
  fecha: string;
  espacios: Partial<Record<"carpa" | "sombrilla", Counts>>;
  ingresan_hoy: ResItem[];
  finalizan_hoy: ResItem[];
  clientes_con_deuda: number;
  ingresos_hoy: { efectivo: number; otros_medios: number; total: number };
  gastos_hoy: number;
  ingresos_mes?: number;
  saldo_pendiente_total?: number;
  efectivo_en_caja?: number | null;
  caja: { estado: "sin_abrir" | "abierta" | "cerrada"; session_id?: string };
  caja_anterior_sin_cerrar: { session_id: string; fecha: string } | null;
};
export type Debt = { reservation_id: string; number: number; customer: string; end_date: string; due: number };
export type Notice = { id: string; tone: "danger" | "warn" | "info"; title: string; detail: string; href: string };

type StatusCtx = {
  summary: Summary | null;
  debts: Debt[];
  futureCount: number;
  /** Avisos sin leer (los que el usuario ya abrió hoy no aparecen). */
  notices: Notice[];
  /** Marca avisos como leídos: dejan de mostrarse hasta mañana. No cambia deudas ni pagos. */
  markRead: (ids: string[]) => void;
  error: string | null;
  loading: boolean;
  updatedAt: Date | null;
  online: boolean;
  reload: () => Promise<void>;
};

const Ctx = createContext<StatusCtx | null>(null);

export function useStatus(): StatusCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useStatus fuera de StatusProvider");
  return c;
}

/** Estado general del día, compartido por el menú, los avisos y el panel. Se actualiza solo cada minuto. */
export function StatusProvider({ children }: { children: ReactNode }) {
  const { ws, userId } = useWorkspace();
  const sb = getSupabase();
  const [online, setOnline] = useState(true);
  const [read, setRead] = useState<{ day: string; ids: string[] }>({ day: "", ids: [] });
  const LS_KEY = `avisos-leidos:${userId}`;
  // Se leen de la base (se sincronizan entre dispositivos); si falta la actualización 0017, del navegador.
  useEffect(() => {
    let alive = true;
    sb.from("user_preferences").select("notices_read").eq("user_id", userId).maybeSingle().then(({ data, error }) => {
      if (!alive) return;
      let v: unknown = !error ? (data as { notices_read?: unknown } | null)?.notices_read : null;
      if (error) { try { v = JSON.parse(localStorage.getItem(LS_KEY) ?? "null"); } catch { v = null; } }
      const o = v as { day?: unknown; ids?: unknown } | null;
      if (o && typeof o.day === "string" && Array.isArray(o.ids)) setRead({ day: o.day, ids: o.ids.filter((x): x is string => typeof x === "string") });
    });
    return () => { alive = false; };
  }, [sb, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = useLoader(async () => {
    const summary = unwrap(await sb.rpc("dashboard_summary", { p_workspace_id: ws.id })) as Summary;
    const bal = unwrap(await sb.from("reservation_balances").select("reservation_id, due_amount").eq("workspace_id", ws.id).gt("due_amount", 0).order("due_amount", { ascending: false }).limit(50)) as { reservation_id: string; due_amount: number }[];
    let debts: Debt[] = [];
    if (bal.length) {
      const rows = unwrap(await sb.from("reservations").select("id, number, end_date, customers(first_name, last_name)").in("id", bal.map((b) => b.reservation_id))) as unknown as { id: string; number: number; end_date: string; customers: { first_name: string; last_name: string } }[];
      const byId = new Map(rows.map((r) => [r.id, r]));
      debts = bal.flatMap((b) => {
        const r = byId.get(b.reservation_id);
        return r ? [{ reservation_id: r.id, number: r.number, customer: `${r.customers.first_name} ${r.customers.last_name}`.trim(), end_date: r.end_date, due: Number(b.due_amount) }] : [];
      });
    }
    // Deudores que terminan mañana o pasado mañana (aviso 2 días y 1 día antes).
    const soonRows = unwrap(await sb.from("reservations").select("id, number, end_date, customers(first_name, last_name)")
      .eq("workspace_id", ws.id).eq("status", "confirmada")
      .gte("end_date", addDays(summary.fecha, 1)).lte("end_date", addDays(summary.fecha, 2))) as unknown as { id: string; number: number; end_date: string; customers: { first_name: string; last_name: string } }[];
    let endingSoon: Debt[] = [];
    if (soonRows.length) {
      const sb2 = unwrap(await sb.from("reservation_balances").select("reservation_id, due_amount").in("reservation_id", soonRows.map((r) => r.id)).gt("due_amount", 0)) as { reservation_id: string; due_amount: number }[];
      const dueById = new Map(sb2.map((b) => [b.reservation_id, Number(b.due_amount)]));
      endingSoon = soonRows.filter((r) => dueById.has(r.id)).map((r) => ({
        reservation_id: r.id, number: r.number, customer: `${r.customers.first_name} ${r.customers.last_name}`.trim(), end_date: r.end_date, due: dueById.get(r.id)!,
      })).sort((a, b) => a.end_date.localeCompare(b.end_date));
    }
    const fut = await sb.from("reservations").select("id", { count: "exact", head: true }).eq("workspace_id", ws.id).eq("status", "confirmada").gt("start_date", summary.fecha);
    if (fut.error) throw fut.error;
    // Límite de efectivo en caja (actualización 0033; si falta, no se avisa).
    const lim = await sb.from("workspaces").select("cash_limit").eq("id", ws.id).single();
    const cashLimit = lim.error ? null : ((lim.data as { cash_limit: number | null }).cash_limit ?? null);
    return { summary, debts, endingSoon, futureCount: fut.count ?? 0, cashLimit };
  }, [ws.id], 60_000);

  // Copia de seguridad automática: una por día como máximo (la base controla que no se repita).
  useEffect(() => {
    sb.rpc("create_backup", { p_workspace_id: ws.id, p_kind: "automatica" }).then(() => undefined, () => undefined);
  }, [sb, ws.id]);

  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    on();
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
    };
  }, []);

  const notices = useMemo<Notice[]>(() => {
    const s = q.data?.summary;
    if (!s) return [];
    const list: Notice[] = [];
    if (s.caja_anterior_sin_cerrar) {
      list.push({ id: "caja-ant", tone: "danger", title: "Caja anterior sin cerrar", detail: `La caja del ${formatDate(s.caja_anterior_sin_cerrar.fecha)} quedó abierta.`, href: "/caja" });
    } else if (s.caja.estado === "sin_abrir") {
      list.push({ id: "caja", tone: "warn", title: "Caja sin abrir", detail: "Abrila para registrar cobros y gastos.", href: "/caja" });
    }
    const limit = q.data?.cashLimit;
    if (limit && s.efectivo_en_caja != null && Number(s.efectivo_en_caja) > Number(limit)) {
      list.push({ id: "caja-limite", tone: "warn", title: "Mucho efectivo en la caja: hacé un depósito",
        detail: `Hay ${formatMoney(s.efectivo_en_caja)} y el límite es ${formatMoney(limit)}.`, href: "/caja" });
    }
    for (const r of s.finalizan_hoy) {
      if (Number(r.due_amount) > 0) {
        list.push({ id: `fin-${r.reservation_id}`, tone: "danger", title: `Termina hoy con deuda: ${r.customer}`, detail: `${r.spaces ?? ""} · Debe ${formatMoney(r.due_amount)}`, href: `/reservas/${r.reservation_id}` });
      }
    }
    const tomorrow = addDays(s.fecha, 1);
    for (const d of q.data!.endingSoon) {
      const one = d.end_date === tomorrow;
      list.push({
        id: `fin${one ? 1 : 2}-${d.reservation_id}`, tone: one ? "danger" : "warn",
        title: `${one ? "Termina mañana" : "Termina en 2 días"} y debe: ${d.customer}`,
        detail: `Reserva #${d.number} · último día ${formatDate(d.end_date)} · Debe ${formatMoney(d.due)}`,
        href: `/reservas/${d.reservation_id}`,
      });
    }
    const endingIds = new Set([...s.finalizan_hoy.map((r) => r.reservation_id), ...q.data!.endingSoon.map((d) => d.reservation_id)]);
    for (const d of q.data!.debts) {
      if (endingIds.has(d.reservation_id)) continue;
      list.push({ id: `deuda-${d.reservation_id}`, tone: "warn", title: `Saldo pendiente: ${d.customer}`, detail: `Reserva #${d.number} · Resta abonar ${formatMoney(d.due)}`, href: `/reservas/${d.reservation_id}` });
    }
    for (const r of s.ingresan_hoy) {
      list.push({ id: `in-${r.reservation_id}`, tone: "info", title: `Ingresa hoy: ${r.customer}`, detail: `${r.spaces ?? ""}${Number(r.due_amount) > 0 ? ` · Debe ${formatMoney(r.due_amount)}` : ""}`, href: `/reservas/${r.reservation_id}` });
    }
    return list;
  }, [q.data]);

  const today = q.data?.summary.fecha ?? "";
  const readToday = useMemo(() => new Set(read.day === today ? read.ids : []), [read, today]);
  const unread = useMemo(() => notices.filter((n) => !readToday.has(n.id)), [notices, readToday]);

  function markRead(ids: string[]) {
    if (!today || ids.length === 0) return;
    const next = { day: today, ids: [...new Set([...(read.day === today ? read.ids : []), ...ids])].slice(-300) };
    setRead(next);
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* sin almacenamiento del navegador */ }
    sb.from("user_preferences").upsert({ user_id: userId, notices_read: next }, { onConflict: "user_id" }).then(() => undefined, () => undefined);
  }

  const value: StatusCtx = {
    summary: q.data?.summary ?? null,
    debts: q.data?.debts ?? [],
    futureCount: q.data?.futureCount ?? 0,
    notices: unread,
    markRead,
    error: q.error,
    loading: q.loading,
    updatedAt: q.updatedAt,
    online,
    reload: q.reload,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
