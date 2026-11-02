// Medios de pago. Solo "efectivo" afecta el dinero físico de la caja.
export const PAYMENT_METHODS = [
  { value: "efectivo", label: "Efectivo" },
  { value: "transferencia", label: "Transferencia" },
  { value: "debito", label: "Tarjeta de débito" },
  { value: "credito", label: "Tarjeta de crédito" },
  { value: "mercado_pago", label: "Mercado Pago / QR" },
] as const;

/** Medios para cobrar reservas: los anteriores + dólares (se convierten a pesos con la cotización). */
export const COLLECT_METHODS = [...PAYMENT_METHODS, { value: "dolares", label: "Dólares (US$)" }] as const;

export type PaymentMethod = (typeof COLLECT_METHODS)[number]["value"] | "tarjeta" | "voucher";

export const METHOD_LABEL: Record<string, string> = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  debito: "Débito",
  credito: "Crédito",
  mercado_pago: "Mercado Pago",
  tarjeta: "Tarjeta",
  dolares: "Dólares",
  voucher: "Voucher restaurante",
};

export const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
