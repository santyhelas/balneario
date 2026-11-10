import { createHmac, timingSafeEqual } from "node:crypto";

/** Partes puras de la integración con Mercado Pago (sin red), para poder probarlas. */

/**
 * Verifica la firma de un aviso (webhook) de Mercado Pago.
 * Cabecera x-signature: "ts=...,v1=..."; se firma "id:<data.id>;request-id:<x-request-id>;ts:<ts>;".
 */
export function verifyMpSignature(opts: { signature: string | null; requestId: string | null; dataId: string | null; secret: string; maxAgeSec?: number; now?: number }): boolean {
  const { signature, requestId, dataId, secret } = opts;
  if (!signature || !secret) return false;
  const parts = Object.fromEntries(signature.split(",").map((p) => p.split("=", 2).map((x) => x.trim())));
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1 || !/^[0-9a-f]+$/i.test(v1)) return false;
  let manifest = "";
  if (dataId) manifest += `id:${/^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;
  const expected = createHmac("sha256", secret).update(manifest).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1.toLowerCase(), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  // Avisos muy viejos no se aceptan (el ts viene en milisegundos o segundos).
  const maxAge = opts.maxAgeSec ?? 0;
  if (maxAge > 0) {
    const tsMs = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000;
    if (Math.abs((opts.now ?? Date.now()) - tsMs) > maxAge * 1000) return false;
  }
  return true;
}

/** Día (AAAA-MM-DD) en Argentina de una fecha de Mercado Pago. */
export function arDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Resultado de un cobro del débito: aprobado, rechazado o todavía nada. */
export function paymentOutcome(ap: { status?: string; payment?: { status?: string } | null }): "approved" | "rejected" | null {
  const p = ap.payment?.status;
  if (p === "approved") return "approved";
  if (p === "rejected" || p === "cancelled") return "rejected";
  if (ap.status === "processed" && !p) return "approved";
  if (ap.status === "recycling") return "rejected";
  return null;
}

/** Datos del débito para Mercado Pago: mensual cada mes; temporada cada 12 meses desde el 1/12. */
export function recurringFor(plan: "mensual" | "anual" | "temporada", price: number, seasonStart: string, today: string) {
  const base = { transaction_amount: Math.round(price * 100) / 100, currency_id: "ARS" as const, frequency: plan === "mensual" ? 1 : 12, frequency_type: "months" as const };
  if (plan !== "temporada" || seasonStart <= today) return base;
  // Se cobra recién el 1/12 a las 10 (hora de Argentina).
  return { ...base, start_date: `${seasonStart}T10:00:00.000-03:00` };
}
