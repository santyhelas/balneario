// Historial: convierte los registros del historial de cambios (audit_log) en frases entendibles.
// Lógica pura (sin base de datos) para poder probarla.

export type AuditRow = {
  id: number;
  table_name: string;
  row_id: string | null;
  action: "alta" | "modificacion" | "baja";
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  reason: string | null;
  actor_id: string | null;
  actor_email: string | null;
  at: string;
};

export type Category = "reservas" | "clientes" | "tarifas" | "caja" | "gastos" | "espacios" | "mapa" | "convenios" | "configuracion";

export const CATEGORY_LABEL: Record<Category | "cobros", string> = {
  reservas: "Reservas",
  cobros: "Cobros y devoluciones",
  clientes: "Clientes",
  tarifas: "Tarifas y descuentos",
  convenios: "Convenios",
  caja: "Caja",
  gastos: "Gastos",
  espacios: "Carpas y sombrillas",
  mapa: "Plano",
  configuracion: "Configuración",
};

/** Tablas del historial de cada categoría. */
export const CATEGORY_TABLES: Record<Category, string[]> = {
  reservas: ["reservations", "reservation_segments"],
  clientes: ["customers"],
  tarifas: ["rates", "package_discounts"],
  convenios: ["agreements"],
  caja: ["cash_sessions"],
  gastos: ["expenses"],
  espacios: ["spaces", "maintenance_blocks"],
  mapa: ["map_features"],
  configuracion: ["workspaces"],
};

export type Lookups = {
  spaces: Map<string, { code: string; kind: string }>;
  customers: Map<string, string>;
  reservations: Map<string, { number: number; customer_id: string }>;
};

export type Described = { category: Category; title: string; details: string[]; href?: string } | null;

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** Temporada de una fecha: de julio a junio (ene 2027 → 2026/2027). */
export function seasonOf(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return m >= 7 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}

const money = (v: unknown) =>
  v == null || v === "" ? "—" : new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(v));
const date = (v: unknown) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
};
const str = (v: unknown) => (v == null || v === "" ? "—" : String(v));

/** Nombre de cada dato y cómo mostrarlo. Los que no están acá no se muestran (son internos). */
const FIELDS: Record<string, Record<string, [string, (v: unknown) => string]>> = {
  reservations: {
    start_date: ["Entrada", date], end_date: ["Salida", date], total_amount: ["Total", money], notes: ["Observaciones", str],
    status: ["Estado", str], cancel_reason: ["Motivo de cancelación", str], courtesy_beneficiary: ["Cortesía para", str],
  },
  customers: {
    first_name: ["Nombre", str], last_name: ["Apellido", str], phone: ["Teléfono", str], email: ["Correo", str],
    locality: ["Localidad", str], other_contact: ["Otro contacto", str], notes: ["Observaciones", str],
  },
  rates: { daily_price: ["Precio por día", money] },
  package_discounts: { min_days: ["Desde días", str], percent: ["Descuento %", (v) => `${str(v)}%`], active: ["Activo", (v) => (v ? "sí" : "no")] },
  agreements: {
    name: ["Nombre", str], percent: ["Descuento", (v) => `${str(v)}%`], active: ["Activo", (v) => (v ? "sí" : "no")],
    valid_from: ["Vigente desde", date], valid_to: ["Vigente hasta", date], conditions: ["Condiciones", str],
  },
  spaces: { code: ["Número", str], active: ["Activa", (v) => (v ? "sí" : "no")], kind: ["Tipo", str] },
  maintenance_blocks: { start_date: ["Desde", date], end_date: ["Hasta", date], reason: ["Motivo", str], active: ["Vigente", (v) => (v ? "sí" : "no")] },
  map_features: { label: ["Texto", str], color: ["Color", str], layer: ["Capa", str] },
  expenses: { amount: ["Importe", money], concept: ["Concepto", str], void_reason: ["Motivo de anulación", str] },
  cash_sessions: { counted_cash: ["Efectivo contado", money], expected_cash: ["Esperado", money], difference: ["Diferencia", money], close_notes: ["Notas", str] },
  workspaces: {
    name: ["Nombre del balneario", str], subtitle: ["Subtítulo", str], latitude: ["Latitud", str], longitude: ["Longitud", str],
    cash_discount_percent: ["Descuento por efectivo", (v) => `${str(v)}%`], timezone: ["Zona horaria", str],
    logo_data: ["Logo", () => "(imagen)"], tent_style: ["Diseño de carpas", () => "(diseño)"],
  },
};

/** Cambios visibles entre el estado anterior y el nuevo ("Total: $1 → $2"). */
export function diffFields(table: string, oldD: Record<string, unknown> | null, newD: Record<string, unknown> | null): string[] {
  const f = FIELDS[table] ?? {};
  const out: string[] = [];
  for (const [k, [label, fmt]] of Object.entries(f)) {
    const a = oldD?.[k];
    const b = newD?.[k];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    out.push(`${label}: ${fmt(a)} → ${fmt(b)}`);
  }
  return out;
}

function spaceName(l: Lookups, id: unknown): string {
  const s = l.spaces.get(String(id));
  return s ? `${s.kind === "sombrilla" ? "Sombrilla" : "Carpa"} ${s.code}` : "Espacio";
}
function resName(l: Lookups, id: unknown): string {
  const r = l.reservations.get(String(id));
  if (!r) return "Reserva";
  const c = l.customers.get(r.customer_id);
  return `Reserva #${r.number}${c ? ` (${c})` : ""}`;
}
const half = (h: unknown) => (Number(h) === 1 ? "1ª quincena" : "2ª quincena");

/** Frase para un registro del historial. Devuelve null para cambios internos sin interés. */
export function describeAudit(row: AuditRow, l: Lookups): Described {
  const n = row.new_data ?? {};
  const o = row.old_data ?? {};
  const d = row.new_data ?? row.old_data ?? {};
  const changes = row.action === "modificacion" ? diffFields(row.table_name, row.old_data, row.new_data) : [];
  const withReason = (list: string[]) => (row.reason ? [...list, `Motivo: ${row.reason}`] : list);

  switch (row.table_name) {
    case "reservations": {
      const href = `/reservas/${row.row_id}`;
      const c = l.customers.get(String(d.customer_id ?? "")) ?? "";
      const name = `Reserva #${str(d.number)}${c ? ` (${c})` : ""}`;
      if (row.action === "alta") {
        return { category: "reservas", title: `${name} creada`, href,
          details: [`Del ${date(n.start_date)} al ${date(n.end_date)}`, n.is_courtesy ? "Cortesía familiar" : `Total ${money(n.total_amount)}`] };
      }
      if (o.status !== "cancelada" && n.status === "cancelada") return { category: "reservas", title: `${name} cancelada`, href, details: withReason([]) };
      if (o.status === "cancelada" && n.status === "confirmada") return { category: "reservas", title: `${name} reactivada (se revirtió la cancelación)`, href, details: withReason([]) };
      if (changes.length === 0) return null;
      return { category: "reservas", title: `${name} modificada`, href, details: withReason(changes) };
    }
    case "reservation_segments": {
      const href = `/reservas/${d.reservation_id}`;
      const what = `${spaceName(l, d.space_id)} del ${date(d.start_date)} al ${date(d.end_date)}`;
      if (row.action === "alta") return { category: "reservas", title: `${resName(l, d.reservation_id)}: ocupa ${what}`, href, details: withReason([]) };
      if (o.active === true && n.active === false) return { category: "reservas", title: `${resName(l, d.reservation_id)}: deja ${what}`, href, details: withReason([]) };
      return null;
    }
    case "customers": {
      const name = `${str(d.first_name)} ${d.last_name ? String(d.last_name) : ""}`.trim();
      if (row.action === "alta") return { category: "clientes", title: `Cliente nuevo: ${name}`, details: [d.phone ? `Teléfono ${d.phone}` : ""].filter(Boolean) };
      if (changes.length === 0) return null;
      return { category: "clientes", title: `Cliente modificado: ${name}`, details: changes };
    }
    case "rates": {
      const what = `${d.space_kind === "sombrilla" ? "Sombrillas" : "Carpas"} · ${MONTHS[Number(d.month) - 1] ?? "?"} ${str(d.year)} · ${half(d.half)}`;
      if (row.action === "alta") return { category: "tarifas", title: `Tarifa nueva: ${what}`, details: [`Precio por día ${money(n.daily_price)}`] };
      if (changes.length === 0) return null;
      return { category: "tarifas", title: `Tarifa cambiada: ${what}`, details: changes };
    }
    case "package_discounts": {
      const what = `Descuento por estadía de ${str(d.min_days)} días o más`;
      if (row.action === "alta") return { category: "tarifas", title: `${what}: ${str(n.percent)}%`, details: [] };
      if (changes.length === 0) return null;
      return { category: "tarifas", title: `${what} modificado`, details: changes };
    }
    case "agreements": {
      if (row.action === "alta") return { category: "convenios", title: `Convenio nuevo: ${str(n.name)} (${str(n.percent)}%)`, details: [] };
      if (changes.length === 0) return null;
      return { category: "convenios", title: `Convenio modificado: ${str(d.name)}`, details: changes };
    }
    case "spaces": {
      const name = spaceName(l, row.row_id) === "Espacio" ? `${d.kind === "sombrilla" ? "Sombrilla" : "Carpa"} ${str(d.code)}` : spaceName(l, row.row_id);
      if (row.action === "alta") return { category: "espacios", title: `${name} agregada`, details: [] };
      if (changes.length > 0) return { category: "espacios", title: `${name} modificada`, details: changes };
      if (o.x !== n.x || o.y !== n.y || o.rotation !== n.rotation) return { category: "mapa", title: `${name} movida en el plano`, details: [] };
      return null;
    }
    case "maintenance_blocks": {
      const what = `${spaceName(l, d.space_id)} del ${date(d.start_date)} al ${date(d.end_date)}`;
      if (row.action === "alta") return { category: "espacios", title: `Mantenimiento: ${what}`, details: [`Motivo: ${str(n.reason)}`] };
      if (o.active === true && n.active === false) return { category: "espacios", title: `Mantenimiento quitado: ${what}`, details: [] };
      if (changes.length === 0) return null;
      return { category: "espacios", title: `Mantenimiento modificado: ${what}`, details: changes };
    }
    case "map_features": {
      const name = d.label ? `"${d.label}"` : "un camino";
      if (row.action === "alta") return { category: "mapa", title: `Plano: se agregó ${name}`, details: [] };
      if (o.active === true && n.active === false) return { category: "mapa", title: `Plano: se quitó ${name}`, details: [] };
      if (changes.length > 0) return { category: "mapa", title: `Plano: se cambió ${name}`, details: changes };
      if (o.x !== n.x || o.y !== n.y || o.width !== n.width || o.height !== n.height || o.rotation !== n.rotation) {
        return { category: "mapa", title: `Plano: se movió o cambió el tamaño de ${name}`, details: [] };
      }
      return null;
    }
    case "cash_sessions": {
      if (row.action === "alta") return { category: "caja", title: `Apertura de caja del ${date(n.business_date)}`, details: [`Efectivo inicial ${money(n.opening_cash)}`] };
      if (!o.closed_at && n.closed_at) {
        return { category: "caja", title: `Cierre de caja del ${date(n.business_date)}`,
          details: [`Esperado ${money(n.expected_cash)}`, `Contado ${money(n.counted_cash)}`, `Diferencia ${money(n.difference)}`, n.close_notes ? `Notas: ${n.close_notes}` : ""].filter(Boolean) };
      }
      return null;
    }
    case "expenses": {
      if (row.action === "alta") {
        return { category: "gastos", title: `Gasto: ${str(n.concept)}`,
          details: [`${money(n.amount)} · ${str(n.method)}`, n.supplier ? `Proveedor: ${n.supplier}` : ""].filter(Boolean) };
      }
      if (!o.voided_at && n.voided_at) return { category: "gastos", title: `Gasto anulado: ${str(d.concept)}`, details: [`${money(d.amount)}`, `Motivo: ${str(n.void_reason)}`] };
      return null;
    }
    case "workspaces": {
      if (changes.length === 0) return null;
      return { category: "configuracion", title: "Configuración del balneario", details: changes };
    }
    default:
      return null;
  }
}

/** Nombre corto de quién hizo el cambio. */
export function actorName(email: string | null, users: Map<string, string>, id: string | null): string {
  if (id && users.has(id)) return users.get(id)!;
  if (!email) return "Sistema";
  return email.endsWith("@usuarios.balneario.invalid") ? email.split("@")[0] : email;
}
