import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Cliente con la clave secreta del servidor (SUPABASE_SECRET_KEY).
 * Solo se usa en el servidor, para: buscar el correo de un usuario al ingresar y crear cuentas.
 * Nunca se envía al navegador. Devuelve null si la clave no está configurada.
 */
export function getAdminSupabase(): SupabaseClient | null {
  const key = process.env.SUPABASE_SECRET_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!key || !url) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
