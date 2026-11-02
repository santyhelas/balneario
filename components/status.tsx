"use client";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { formatDate, formatMoney } from "@/lib/format";
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
  notices: Notice[];
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
  const { ws } = useWorkspace();
  const sb = getSupabase();
  const [online, setOnline] = useState(true);

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
    const fut = await sb.from("reservations").select("id", { count: "exact", head: true }).eq("workspace_id", ws.id).eq("status", "confirmada").gt("start_date", summary.fecha);
    if (fut.error) throw fut.error;
    return { summary, debts, futureCount: fut.count ?? 0 };
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
    for (const r of s.finalizan_hoy) {
      if (Number(r.due_amount) > 0) {
        list.push({ id: `fin-${r.reservation_id}`, tone: "danger", title: `Termina hoy con deuda: ${r.customer}`, detail: `${r.spaces ?? ""} · Debe ${formatMoney(r.due_amount)}`, href: `/reservas/${r.reservation_id}` });
      }
    }
    const endingIds = new Set(s.finalizan_hoy.map((r) => r.reservation_id));
    for (const d of q.data!.debts) {
      if (endingIds.has(d.reservation_id)) continue;
      list.push({ id: `deuda-${d.reservation_id}`, tone: "warn", title: `Saldo pendiente: ${d.customer}`, detail: `Reserva #${d.number} · Resta abonar ${formatMoney(d.due)}`, href: `/reservas/${d.reservation_id}` });
    }
    for (const r of s.ingresan_hoy) {
      list.push({ id: `in-${r.reservation_id}`, tone: "info", title: `Ingresa hoy: ${r.customer}`, detail: `${r.spaces ?? ""}${Number(r.due_amount) > 0 ? ` · Debe ${formatMoney(r.due_amount)}` : ""}`, href: `/reservas/${r.reservation_id}` });
    }
    return list;
  }, [q.data]);

  const value: StatusCtx = {
    summary: q.data?.summary ?? null,
    debts: q.data?.debts ?? [],
    futureCount: q.data?.futureCount ?? 0,
    notices,
    error: q.error,
    loading: q.loading,
    updatedAt: q.updatedAt,
    online,
    reload: q.reload,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
