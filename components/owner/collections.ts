import { cuotas, sinPagos, type Balneario } from "@/components/owner/board";

export type Due = { key: string; b: Balneario; concepto: string; fecha: string; importe: number; auto: boolean };

/** Lo que cada balneario tiene que pagar en los próximos 12 meses (y lo vencido), según su plan. */
export function upcoming(list: Balneario[], hoy: string): Due[] {
  const out: Due[] = [];
  const limit = `${Number(hoy.slice(0, 4)) + 1}${hoy.slice(4)}`;
  for (const b of list) {
    const p = b.plan;
    if (!p || p.estado === "exenta" || b.pausado) continue;
    if (p.debito) {
      if (p.proximo_debito) out.push({ key: `${b.id}-deb`, b, concepto: "Débito automático", fecha: p.proximo_debito, importe: Number(p.precio), auto: true });
      continue;
    }
    if (p.plan === "temporada") {
      if (sinPagos(p)) out.push({ key: `${b.id}-ent`, b, concepto: "Entrada de la temporada", fecha: hoy, importe: Number(p.entrada ?? p.precio), auto: false });
      for (const c of cuotas(p, hoy)) if (!c.pagada) out.push({ key: `${b.id}-${c.vence}`, b, concepto: c.nombre, fecha: c.vence, importe: Number(p.cuota ?? 0), auto: false });
      if (!sinPagos(p) && p.pago_hasta) out.push({ key: `${b.id}-ren`, b, concepto: "Entrada de la próxima temporada", fecha: p.pago_hasta, importe: Number(p.entrada ?? p.precio), auto: false });
    } else {
      const label = p.plan === "anual" ? "Plan anual" : "Plan mensual";
      out.push({ key: `${b.id}-plan`, b, concepto: sinPagos(p) ? `${label} (sin pagos registrados)` : `Renovación ${label.toLowerCase()}`, fecha: sinPagos(p) || !p.pago_hasta ? hoy : p.pago_hasta, importe: Number(p.precio), auto: false });
    }
  }
  return out.filter((d) => d.fecha <= limit).sort((a, b) => a.fecha.localeCompare(b.fecha));
}
