// Mensajes de WhatsApp ya escritos: recordatorio de deuda y comprobante de pago.
// No se usa ningún servicio pago: el botón abre WhatsApp con el texto listo para enviar.

const money = (n: number) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

export type DebtInfo = {
  firstName: string; balneario: string; number: number; places: string;
  start: string; end: string; due: number; today: string;
};

/** Recordatorio de saldo, según cuánto falta para que termine la estadía. */
export function debtReminder(d: DebtInfo): string {
  const hi = `Hola ${d.firstName.trim() || ""}! Te escribimos de ${d.balneario}.`.replace(" !", "!");
  const what = `${d.places ? `${d.places}, ` : ""}reserva #${d.number}`;
  const left = daysBetween(d.today, d.end);
  const owe = `Queda un saldo de ${money(d.due)} por abonar.`;
  let body: string;
  if (left < 0) body = `Tu estadía (${what}) terminó el ${dmy(d.end)} y quedó un saldo pendiente de ${money(d.due)}. ¿Cuándo podés pasar a abonarlo?`;
  else if (left === 0) body = `Hoy es el último día de tu estadía (${what}). ${owe}`;
  else if (left === 1) body = `Te recordamos que tu estadía (${what}) termina mañana, ${dmy(d.end)}. ${owe}`;
  else if (d.start > d.today) body = `Te recordamos tu reserva del ${dmy(d.start)} al ${dmy(d.end)} (${what}). ${owe}`;
  else body = `Te recordamos que tu estadía (${what}) termina el ${dmy(d.end)}. ${owe}`;
  return `${hi}\n${body}\nPodés pagar en efectivo, transferencia o tarjeta. ¡Gracias!`;
}

export type ReceiptInfo = {
  balneario: string; number: number; customer: string; places: string; start: string; end: string;
  total: number; paid: number; due: number; courtesy: boolean;
  payments: { date: string; kind: "cobro" | "devolucion" | "anulacion"; method: string; amount: number; voided: boolean }[];
};

/** Comprobante con el detalle de pagos. */
export function receiptMessage(r: ReceiptInfo): string {
  const nDays = daysBetween(r.start, r.end) + 1;
  const lines = [
    `*Comprobante · ${r.balneario}*`,
    `Reserva #${r.number} · ${r.customer}`,
    `${r.places} · del ${dmy(r.start)} al ${dmy(r.end)} (${nDays} ${nDays === 1 ? "día" : "días"})`,
  ];
  if (r.courtesy) {
    lines.push("Cortesía: sin cargo.");
  } else {
    lines.push(`Total: ${money(r.total)}`);
    const valid = r.payments.filter((p) => !p.voided && p.kind !== "anulacion");
    if (valid.length) {
      lines.push("Pagos:");
      for (const p of valid) lines.push(`· ${dmy(p.date)} ${p.kind === "devolucion" ? "Devolución" : "Pago"} ${p.method}: ${p.kind === "devolucion" ? "−" : ""}${money(p.amount)}`);
    }
    lines.push(`Pagado: ${money(r.paid)}`);
    lines.push(r.due > 0 ? `*Saldo pendiente: ${money(r.due)}*` : "*Pagada en su totalidad.*");
  }
  lines.push("¡Gracias por elegirnos!");
  return lines.join("\n");
}

export type QuoteInfo = {
  firstName: string | null; balneario: string; places: string; start: string; end: string;
  total: number; cashTotal: number | null; discounts: string[];
};

/** Presupuesto: precio exacto sin reservar. No guarda nada ni bloquea el espacio. */
export function quoteMessage(q: QuoteInfo): string {
  const nDays = daysBetween(q.start, q.end) + 1;
  const lines = [
    `Hola${q.firstName?.trim() ? ` ${q.firstName.trim()}` : ""}! Te pasamos el presupuesto de ${q.balneario}:`,
    `${q.places} · del ${dmy(q.start)} al ${dmy(q.end)} (${nDays} ${nDays === 1 ? "día" : "días"})`,
  ];
  if (q.discounts.length) lines.push(`Incluye: ${q.discounts.join(", ")}`);
  lines.push(`*Total: ${money(q.total)}*`);
  if (q.cashTotal !== null && q.cashTotal < q.total) lines.push(`Pagando en efectivo: ${money(q.cashTotal)}`);
  lines.push("El lugar queda reservado recién cuando se confirma la reserva, según disponibilidad en ese momento.");
  lines.push("¿Te la reservamos?");
  return lines.join("\n");
}

export type RenewalInfo = { firstName: string; balneario: string; places: string; lastSeason: string; newSeason: string };

/** Ofrecimiento al cliente de la temporada pasada para que vuelva a su lugar. */
export function renewalMessage(r: RenewalInfo): string {
  const hi = `Hola ${r.firstName.trim()}! Te escribimos de ${r.balneario}.`.replace(" !", "!");
  return `${hi}\nSe viene la temporada ${r.newSeason} y queríamos ofrecerte primero tu lugar de la temporada ${r.lastSeason} (${r.places}).\n¿Querés que te lo reservemos? Contanos qué fechas te interesan.`;
}
