// Planilla de clientes: datos de contacto y todo su historial de alquileres (sin cortesías).
import { getSupabase } from "@/lib/supabase/client";
import { downloadXlsx, type Cell } from "@/lib/xlsx";

type Cust = { id: string; first_name: string; last_name: string | null; phone: string | null; email: string | null; other_contact: string | null; notes: string | null; created_at: string };
type Seg = { space_id: string; start_date: string; end_date: string; active: boolean; spaces: { code: string; kind: string } | null };
type Res = {
  id: string; number: number; customer_id: string; start_date: string; end_date: string; status: string; is_courtesy: boolean;
  list_amount: number; discount_amount: number; total_amount: number; notes: string | null; created_at: string;
  reservation_segments: Seg[];
};
type Bal = { reservation_id: string; paid_amount: number; due_amount: number };

const PAGE = 1000;

/** Trae todas las filas de a 1000 (el servidor no devuelve más por consulta). */
async function all<T>(make: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const d = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
const days = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000) + 1;

export async function exportCustomersXlsx(workspaceId: string, workspaceName: string, today: string) {
  const sb = getSupabase();
  const customers = await all<Cust>((f, t) => sb.from("customers").select("id, first_name, last_name, phone, email, other_contact, notes, created_at")
    .eq("workspace_id", workspaceId).order("last_name").order("first_name").range(f, t));
  const reservations = await all<Res>((f, t) => sb.from("reservations")
    .select("id, number, customer_id, start_date, end_date, status, is_courtesy, list_amount, discount_amount, total_amount, notes, created_at, reservation_segments(space_id, start_date, end_date, active, spaces(code, kind))")
    .eq("workspace_id", workspaceId).eq("is_courtesy", false).order("start_date").range(f, t));
  const balances = await all<Bal>((f, t) => sb.from("reservation_balances").select("reservation_id, paid_amount, due_amount")
    .eq("workspace_id", workspaceId).range(f, t));
  const bal = new Map(balances.map((b) => [b.reservation_id, b]));
  const byCustomer = new Map<string, Res[]>();
  for (const r of reservations) byCustomer.set(r.customer_id, [...(byCustomer.get(r.customer_id) ?? []), r]);

  // Hoja 1: un renglón por alquiler (sin cortesías).
  const rentRows: Cell[][] = [];
  for (const c of customers) {
    for (const r of byCustomer.get(c.id) ?? []) {
      const segs = r.reservation_segments.filter((s) => s.active).sort((a, b) => a.start_date.localeCompare(b.start_date));
      const places = segs.map((s) => `${s.spaces?.kind === "sombrilla" ? "Sombrilla" : "Carpa"} ${s.spaces?.code ?? "?"}${segs.length > 1 ? ` (${d(s.start_date)} al ${d(s.end_date)})` : ""}`).join(" · ");
      const b = bal.get(r.id);
      const n = days(r.start_date, r.end_date);
      rentRows.push([
        c.last_name ?? "", c.first_name, c.phone ?? "", c.email ?? "", c.notes ?? "",
        r.number, r.status === "cancelada" ? "Cancelada" : "Confirmada", places,
        d(r.start_date), d(r.end_date), n,
        Number(r.list_amount), Number(r.discount_amount), Number(r.total_amount), n > 0 ? Math.round((Number(r.total_amount) / n) * 100) / 100 : null,
        Number(b?.paid_amount ?? 0), Number(b?.due_amount ?? 0), r.notes ?? "",
      ]);
    }
  }

  // Hoja 2: un renglón por cliente, con totales.
  const custRows: Cell[][] = customers.map((c) => {
    const list = (byCustomer.get(c.id) ?? []).filter((r) => r.status === "confirmada");
    const totalDays = list.reduce((s, r) => s + days(r.start_date, r.end_date), 0);
    const contracted = list.reduce((s, r) => s + Number(r.total_amount), 0);
    const paid = list.reduce((s, r) => s + Number(bal.get(r.id)?.paid_amount ?? 0), 0);
    const due = list.reduce((s, r) => s + Number(bal.get(r.id)?.due_amount ?? 0), 0);
    const last = list.map((r) => r.start_date).sort().pop();
    return [c.last_name ?? "", c.first_name, c.phone ?? "", c.email ?? "", c.other_contact ?? "", c.notes ?? "",
      list.length, totalDays, contracted, paid, due, d(last), d(c.created_at.slice(0, 10))];
  });

  const safeName = workspaceName.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "") || "balneario";
  downloadXlsx(`clientes_${safeName}_${today}.xlsx`, [
    {
      name: "Alquileres",
      header: ["Apellido", "Nombre", "Teléfono", "Correo", "Observaciones del cliente", "Reserva N°", "Estado", "Carpa / sombrilla",
        "Entrada", "Salida", "Días", "Precio de lista", "Descuentos", "Precio total", "Precio por día", "Pagado", "Saldo", "Observaciones de la reserva"],
      rows: rentRows,
      widths: [16, 14, 20, 26, 28, 10, 11, 30, 11, 11, 6, 14, 12, 14, 13, 13, 12, 30],
      money: [11, 12, 13, 14, 15, 16],
    },
    {
      name: "Clientes",
      header: ["Apellido", "Nombre", "Teléfono", "Correo", "Otro contacto", "Observaciones", "Alquileres", "Días en total",
        "Total contratado", "Total pagado", "Saldo", "Último alquiler", "Cliente desde"],
      rows: custRows,
      widths: [16, 14, 20, 26, 20, 28, 10, 12, 15, 14, 12, 14, 13],
      money: [8, 9, 10],
    },
  ]);
  return { customers: customers.length, rentals: rentRows.length };
}
