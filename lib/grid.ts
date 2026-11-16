import type { SupabaseClient } from "@supabase/supabase-js";

const PAGE = 1000; // el servidor no devuelve más de 1000 filas por pedido

/**
 * Disponibilidad por espacio y por día (availability_grid), completa aunque pase de 1000 filas:
 * 90 carpas × 15 días ya son 1350 filas, así que se pide de a partes.
 */
export async function fetchGrid<T>(sb: SupabaseClient, args: { p_workspace_id: string; p_from: string; p_to: string; p_kind?: string | null }): Promise<T[]> {
  const first = await sb.rpc("availability_grid", args, { count: "exact" }).range(0, PAGE - 1);
  if (first.error) throw first.error;
  const rows = (first.data ?? []) as T[];
  const total = first.count ?? rows.length;
  if (total <= rows.length) return rows;
  const pages = [];
  for (let from = PAGE; from < total; from += PAGE) pages.push(sb.rpc("availability_grid", args).range(from, from + PAGE - 1));
  for (const res of await Promise.all(pages)) {
    if (res.error) throw res.error;
    rows.push(...((res.data ?? []) as T[]));
  }
  return rows;
}
