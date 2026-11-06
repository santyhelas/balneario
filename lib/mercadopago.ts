import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { arDate, paymentOutcome } from "@/lib/mercadopago-core";

// Débito automático de los planes con Mercado Pago (suscripciones / "preapproval").
// Claves en Vercel (nunca en el navegador): MP_ACCESS_TOKEN y MP_WEBHOOK_SECRET.

const API = "https://api.mercadopago.com";

export function mpConfig() {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) return null;
  return { token, webhookSecret: process.env.MP_WEBHOOK_SECRET ?? "" };
}

export async function mp<T>(path: string, init?: { method?: string; body?: unknown; idempotencyKey?: string }): Promise<T> {
  const cfg = mpConfig();
  if (!cfg) throw new Error("Falta configurar Mercado Pago (MP_ACCESS_TOKEN en Vercel).");
  const res = await fetch(API + path, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      ...(init?.idempotencyKey ? { "X-Idempotency-Key": init.idempotencyKey } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* respuesta no JSON */ }
  if (!res.ok) {
    const msg = (data as { message?: string } | null)?.message ?? `Mercado Pago respondió ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export type Preapproval = { id: string; status: string; external_reference?: string; payer_email?: string; next_payment_date?: string | null; init_point?: string };
export type AuthorizedPayment = {
  id: number | string; preapproval_id: string; status?: string; transaction_amount?: number;
  date_created?: string; debit_date?: string; payment?: { id?: number | string; status?: string } | null;
};

/** Pasa a la base el estado del débito según Mercado Pago. */
export async function syncPreapproval(admin: SupabaseClient, id: string) {
  const p = await mp<Preapproval>(`/preapproval/${encodeURIComponent(id)}`);
  const { error } = await admin.rpc("plan_mp_status", { p_preapproval_id: p.id, p_status: p.status, p_next_charge: arDate(p.next_payment_date) });
  if (error) throw new Error(error.message);
  return p;
}

/** Pasa a la base un cobro del débito (aprobado o rechazado). Repetirlo no suma dos veces. */
export async function applyAuthorizedPayment(admin: SupabaseClient, ap: AuthorizedPayment) {
  const outcome = paymentOutcome(ap);
  if (!outcome) return;
  const paidOn = arDate(ap.debit_date ?? ap.date_created) ?? arDate(new Date().toISOString());
  const { error } = await admin.rpc("plan_mp_payment", {
    p_preapproval_id: ap.preapproval_id, p_payment_id: String(ap.payment?.id ?? ap.id), p_status: outcome,
    p_amount: ap.transaction_amount ?? null, p_paid_on: paidOn,
  });
  if (error) throw new Error(error.message);
}

export async function syncPayment(admin: SupabaseClient, id: string) {
  const ap = await mp<AuthorizedPayment>(`/authorized_payments/${encodeURIComponent(id)}`);
  await applyAuthorizedPayment(admin, ap);
}

/** Revisa un débito completo (estado y cobros), por si se perdió algún aviso. */
export async function syncAll(admin: SupabaseClient, preapprovalId: string) {
  await syncPreapproval(admin, preapprovalId);
  const list = await mp<{ results?: AuthorizedPayment[] }>(`/authorized_payments/search?preapproval_id=${encodeURIComponent(preapprovalId)}`);
  for (const ap of list.results ?? []) await applyAuthorizedPayment(admin, { ...ap, preapproval_id: ap.preapproval_id ?? preapprovalId });
}
