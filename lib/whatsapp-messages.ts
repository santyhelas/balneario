// Mensajes de WhatsApp ya escritos: recordatorio de deuda y comprobante de pago.
// No se usa ningún servicio pago: el botón abre WhatsApp con el texto listo para enviar.

const money = (n: number) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

export type DebtInfo = {
  firstName: string; balneario: string; number: number; places: string;
  start: string; end: string; due: number; today: string;
  /** Datos opcionales (si no vienen, quedan vacíos en el mensaje). */
  lastName?: string | null; phone?: string | null; email?: string | null;
  total?: number | null; paid?: number | null;
};

/** Casos del recordatorio de deuda; cada uno tiene su mensaje (editable en Configuración). */
export type DebtCase = "deuda_hoy" | "deuda_manana" | "deuda_vencida" | "deuda_otros";

export const DEBT_CASES: { key: DebtCase; label: string; help: string }[] = [
  { key: "deuda_hoy", label: "Último día", help: "Cuando hoy es el último día de la estadía." },
  { key: "deuda_manana", label: "Termina mañana", help: "El día anterior al último." },
  { key: "deuda_vencida", label: "Ya terminó", help: "Cuando la estadía terminó y quedó deuda." },
  { key: "deuda_otros", label: "Otros días", help: "Antes de llegar o con varios días por delante." },
];

/** Datos que se pueden poner en los mensajes. */
export const PLACEHOLDERS: { key: string; label: string }[] = [
  { key: "nombre", label: "Nombre" },
  { key: "apellido", label: "Apellido" },
  { key: "cliente", label: "Nombre y apellido" },
  { key: "telefono", label: "Teléfono" },
  { key: "email", label: "Mail del cliente" },
  { key: "balneario", label: "Balneario" },
  { key: "lugar", label: "Carpa o sombrilla" },
  { key: "reserva", label: "N° de reserva" },
  { key: "desde", label: "Desde" },
  { key: "hasta", label: "Hasta" },
  { key: "dias", label: "Días" },
  { key: "total", label: "Monto total" },
  { key: "sena", label: "Seña / pagado" },
  { key: "saldo", label: "Saldo" },
];

/** Correo al cliente (asunto y texto), editable en Configuración. */
export const DEFAULT_MAIL = {
  mail_asunto: "Tu reserva #{reserva} en {balneario}",
  mail_cuerpo: "Hola {nombre}!\n\nTe escribimos de {balneario} por tu reserva #{reserva}: {lugar}, del {desde} al {hasta} ({dias} días).\n\nTotal: {total}\nPagado: {sena}\nSaldo: {saldo}\n\nCualquier consulta, respondé este correo. ¡Gracias!\n{balneario}",
};
export type MailKey = keyof typeof DEFAULT_MAIL;

export const DEFAULT_TEMPLATES: Record<DebtCase, string> = {
  deuda_hoy: "Hola {nombre}! Te escribimos de {balneario}.\nHoy es el último día de tu estadía ({lugar}, reserva #{reserva}). Queda un saldo de {saldo} por abonar.\nPodés pagar en efectivo, transferencia o tarjeta. ¡Gracias!",
  deuda_manana: "Hola {nombre}! Te escribimos de {balneario}.\nTe recordamos que tu estadía ({lugar}, reserva #{reserva}) termina mañana, {hasta}. Queda un saldo de {saldo} por abonar.\nPodés pagar en efectivo, transferencia o tarjeta. ¡Gracias!",
  deuda_vencida: "Hola {nombre}! Te escribimos de {balneario}.\nTu estadía ({lugar}, reserva #{reserva}) terminó el {hasta} y quedó un saldo pendiente de {saldo}. ¿Cuándo podés pasar a abonarlo?\nPodés pagar en efectivo, transferencia o tarjeta. ¡Gracias!",
  deuda_otros: "Hola {nombre}! Te escribimos de {balneario}.\nTe recordamos tu reserva del {desde} al {hasta} ({lugar}, reserva #{reserva}). Queda un saldo de {saldo} por abonar.\nPodés pagar en efectivo, transferencia o tarjeta. ¡Gracias!",
};

export type Templates = Partial<Record<DebtCase | MailKey, string>>;

export function debtCase(d: { end: string; today: string }): DebtCase {
  const left = daysBetween(d.today, d.end);
  return left < 0 ? "deuda_vencida" : left === 0 ? "deuda_hoy" : left === 1 ? "deuda_manana" : "deuda_otros";
}

/** Reemplaza {nombre}, {saldo}, etc. Si falta la carpa, limpia el "(, " que quedaría. */
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl
    .replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m))
    .replace(/\(\s*,\s*/g, "(").replace(/\s*,\s*\)/g, ")").replace(/\(\s*\)/g, "")
    .replace(/ +!/g, "!").replace(/[ \t]+\n/g, "\n");
}

export function debtVars(d: DebtInfo): Record<string, string> {
  const last = (d.lastName ?? "").trim();
  return {
    nombre: d.firstName.trim(), apellido: last, cliente: `${d.firstName.trim()} ${last}`.trim(),
    telefono: d.phone ?? "", email: d.email ?? "",
    balneario: d.balneario, lugar: d.places, reserva: String(d.number),
    desde: dmy(d.start), hasta: dmy(d.end), dias: String(daysBetween(d.start, d.end) + 1),
    total: d.total != null ? money(d.total) : "", sena: d.paid != null ? money(d.paid) : "",
    saldo: money(d.due),
  };
}

/** Correo para el cliente: asunto y texto con sus datos (con el mensaje propio si hay). */
export function mailMessage(d: DebtInfo, templates?: Templates | null): { subject: string; body: string } {
  const pick = (k: MailKey) => (templates?.[k]?.trim() ? templates[k]! : DEFAULT_MAIL[k]);
  const vars = debtVars(d);
  return { subject: fillTemplate(pick("mail_asunto"), vars).replace(/\n/g, " ").trim(), body: fillTemplate(pick("mail_cuerpo"), vars) };
}

export type MailProvider = "gmail" | "outlook" | "office365" | "yahoo" | "app";
export const MAIL_PROVIDERS: { key: MailProvider; label: string }[] = [
  { key: "gmail", label: "Gmail" },
  { key: "outlook", label: "Outlook / Hotmail" },
  { key: "office365", label: "Outlook de empresa (Microsoft 365)" },
  { key: "yahoo", label: "Yahoo" },
  { key: "app", label: "El programa de correo de la compu" },
];

/** Enlace que abre la ventana de "Redactar" del correo que usa el balneario, con el mail del cliente, asunto y texto. */
export function mailtoLink(email: string, subject: string, body: string, provider: MailProvider = "gmail"): string {
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
  switch (provider) {
    case "outlook": return `https://outlook.live.com/mail/0/deeplink/compose?${q({ to: email, subject, body })}`;
    case "office365": return `https://outlook.office.com/mail/deeplink/compose?${q({ to: email, subject, body })}`;
    case "yahoo": return `https://compose.mail.yahoo.com/?${q({ to: email, subject, body })}`;
    case "app": return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    default: return `https://mail.google.com/mail/?${q({ view: "cm", fs: "1", to: email, su: subject, body })}`;
  }
}

/** Recordatorio de saldo, según cuánto falta para que termine la estadía (con el mensaje propio si hay). */
export function debtReminder(d: DebtInfo, templates?: Templates | null): string {
  const c = debtCase(d);
  const tpl = templates?.[c]?.trim() ? templates[c]! : DEFAULT_TEMPLATES[c];
  return fillTemplate(tpl, debtVars(d));
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
