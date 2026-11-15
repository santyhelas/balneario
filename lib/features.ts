import type { Workspace } from "@/components/workspace";

export type Features = { dolares: boolean; redondeo: boolean; paquetes: boolean };
export const FEATURE_INFO: { key: keyof Features; label: string; help: string }[] = [
  { key: "dolares", label: "Cobrar en dólares", help: "Agrega «Dólares (US$)» como medio de pago, con la cotización del día." },
  { key: "redondeo", label: "Redondear el total a $500", help: "En Nueva reserva aparece la opción de redondear para abajo (ej. $23.730 → $23.500)." },
  { key: "paquetes", label: "Paquetes de precio fijo", help: "Precios cerrados por cantidad de días (ej. 7 días a $300.000) en Descuentos y convenios." },
];

/** Funciones opcionales del balneario. Si la base todavía no tiene la actualización 0060, se ve todo como antes. */
export function featuresOf(ws: Pick<Workspace, "features">): Features {
  const f = ws.features;
  if (!f) return { dolares: true, redondeo: true, paquetes: true };
  return { dolares: !!f.dolares, redondeo: !!f.redondeo, paquetes: !!f.paquetes };
}
