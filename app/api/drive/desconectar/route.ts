import { json } from "@/lib/auth-server";
import { currentMember, revokeAndForget } from "@/lib/drive";
import { getAdminSupabase } from "@/lib/supabase/admin";

// Desconectar Google Drive: se retira el permiso en Google y se borra lo guardado. Las copias ya subidas quedan en tu Drive.
export async function POST() {
  const me = await currentMember();
  if (!me) return json({ error: "Tu sesión venció. Volvé a ingresar." }, 401);
  if (me.role !== "propietario") return json({ error: "Solo el propietario puede desconectar Google Drive." }, 403);
  const admin = getAdminSupabase();
  if (!admin) return json({ error: "Falta la clave secreta del servidor." }, 503);
  await revokeAndForget(admin, me.ws);
  return json({ ok: true });
}
