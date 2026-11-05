"use client";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap } from "@/lib/data";

export type ReservationDetail = {
  id: string;
  workspace_id: string;
  number: number;
  start_date: string;
  end_date: string;
  status: "confirmada" | "cancelada";
  is_courtesy: boolean;
  courtesy_beneficiary: string | null;
  list_amount: number;
  discount_amount: number;
  total_amount: number;
  notes: string | null;
  version: number;
  created_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  /** undefined si todavía no se aplicó la actualización 0025. */
  arrival_status?: "llego" | "no_vino" | null;
  arrival_at?: string | null;
  customers: { id: string; first_name: string; last_name: string; phone: string | null; email: string | null; locality: string | null };
};
export type SegmentRow = { id: string; space_id: string; start_date: string; end_date: string; spaces: { code: string; kind: "carpa" | "sombrilla" } };
export type ChargeRow = { id: string; position: number; description: string; amount: number };
export type DiscountRow = { id: string; position: number; kind: string; label: string; percent: number | null; amount: number; reason: string | null };
export type PaymentRow = {
  id: string; kind: "cobro" | "devolucion" | "anulacion"; amount: number; signed_amount: number; method: string;
  voids_payment_id: string | null; note: string | null; reason: string | null; created_at: string;
  usd_amount?: number | null;
  exchange_rate?: number | null;
};
export type ChangeRow = {
  id: string; kind: string; description: string; reason: string | null; at: string; actor_email: string | null;
  reverted_by_change_id: string | null; reverts_change_id: string | null;
};
export type Balance = { paid_amount: number; due_amount: number; credit_amount: number };

export type Full = {
  r: ReservationDetail;
  segments: SegmentRow[];
  charges: ChargeRow[];
  discounts: DiscountRow[];
  payments: PaymentRow[];
  changes: ChangeRow[];
  balance: Balance;
};

export async function loadReservation(id: string): Promise<Full> {
  const sb = getSupabase();
  const [r, segments, charges, discounts, payments, changes, balance] = await Promise.all([
    sb.from("reservations")
      // "*" para que funcione con y sin la columna de llegada (actualización 0025).
      .select("*, customers(id, first_name, last_name, phone, email, locality)")
      .eq("id", id).single(),
    sb.from("reservation_segments").select("id, space_id, start_date, end_date, spaces(code, kind)").eq("reservation_id", id).eq("active", true).order("start_date"),
    sb.from("reservation_charges").select("id, position, description, amount").eq("reservation_id", id).order("position"),
    sb.from("reservation_discounts").select("id, position, kind, label, percent, amount, reason").eq("reservation_id", id).order("position"),
    sb.from("payments").select("*").eq("reservation_id", id).order("created_at"),
    sb.from("reservation_changes").select("id, kind, description, reason, at, actor_email, reverted_by_change_id, reverts_change_id").eq("reservation_id", id).order("at", { ascending: false }),
    sb.from("reservation_balances").select("paid_amount, due_amount, credit_amount").eq("reservation_id", id).single(),
  ]);
  return {
    r: unwrap(r) as unknown as ReservationDetail,
    segments: unwrap(segments) as unknown as SegmentRow[],
    charges: unwrap(charges) as ChargeRow[],
    discounts: unwrap(discounts) as DiscountRow[],
    payments: unwrap(payments) as PaymentRow[],
    changes: unwrap(changes) as ChangeRow[],
    balance: unwrap(balance) as Balance,
  };
}

/** Enlace de WhatsApp para un teléfono argentino (agrega 549 si hace falta). */
export function whatsappLink(phone: string | null, text: string): string | null {
  if (!phone) return null;
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  if (!d.startsWith("54")) {
    // Celular con 15 (ej. 2255 15 123456): se quita el 15 después de la característica
    d = d.replace(/^(\d{2,4})15(\d{6,8})$/, "$1$2");
    if (d.length === 10) d = "549" + d;
  }
  if (d.length < 10) return null;
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}

export function spacesSummary(segments: SegmentRow[]): string {
  return segments.map((s) => s.spaces.code).filter((c, i, a) => a.indexOf(c) === i).join(" → ");
}
