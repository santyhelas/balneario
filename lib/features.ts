import type { Workspace } from "@/components/workspace";

export type Features = { dolares: boolean; redondeo: boolean; paquetes: boolean };
export const FEATURE_INFO: { key: keyof Features; label: string; help: string }[] = [
  { key: "dolares", label: "Cobrar en dólares", help: "Agrega «Dólares (US$)» como medio de pago, con la cotización del día." },
  { key: "redondeo", label: "Redondear el total a $500", help: "En Nueva reserva aparece la opción de redondear para abajo (ej. $23.730 → $23.500)." },
  { key: "paquetes", label: "Paquetes de precio fijo", help: "Precios cerrados por 7, 10, 15 días… dentro de cada mes del Tarifario (ej. 7 días a $510.000; el 8º día se suma al precio normal). Si lo apagás, se usan descuentos en % por cantidad de días." },
];

/** Funciones opcionales del balneario. Si la base todavía no tiene la actualización 0060, se ve todo como antes. */
export function featuresOf(ws: Pick<Workspace, "features">): Features {
  const f = ws.features;
  if (!f) return { dolares: true, redondeo: true, paquetes: true };
  return { dolares: !!f.dolares, redondeo: !!f.redondeo, paquetes: !!f.paquetes };
}
