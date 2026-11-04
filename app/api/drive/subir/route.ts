import { json } from "@/lib/auth-server";
import { currentMember, uploadBackup } from "@/lib/drive";
import { getAdminSupabase } from "@/lib/supabase/admin";

export const maxDuration = 60;

// "Subir una copia ahora" (propietario o administrador).
export async function POST() {
  const me = await currentMember();
  if (!me) return json({ error: "Tu sesión venció. Volvé a ingresar." }, 401);
  if (!["propietario", "administrador"].includes(me.role) || me.isDemo) return json({ error: "No tenés permiso para subir copias." }, 403);
  const admin = getAdminSupabase();
  if (!admin) return json({ error: "Falta la clave secreta del servidor." }, 503);
  const r = await uploadBackup(admin, me.ws);
  return r.ok ? json({ ok: true, archivo: r.file }) : json({ error: r.error }, 502);
}
