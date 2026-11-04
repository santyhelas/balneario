import { json } from "@/lib/auth-server";
import { uploadBackup, driveConfig } from "@/lib/drive";
import { getAdminSupabase } from "@/lib/supabase/admin";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Copia diaria en Drive (la llama Vercel una vez por día; ver vercel.json).
// Es segura aunque alguien la llame a mano: solo sube a los Drive de cada dueño y
// a cada balneario como máximo una vez cada 20 horas.
export async function GET() {
  const admin = getAdminSupabase();
  if (!admin || !driveConfig()) return json({ ok: false, motivo: "sin configurar" });
  const { data, error } = await admin.rpc("drive_pending", { p_limit: 20 });
  if (error) return json({ ok: false, motivo: "sin la actualización 0024" });
  const started = Date.now();
  const results: { ok: boolean }[] = [];
  for (const ws of (data ?? []) as string[]) {
    if (Date.now() - started > 45_000) break; // se sigue en la próxima pasada
    results.push(await uploadBackup(admin, ws));
  }
  return json({ ok: true, subidas: results.filter((r) => r.ok).length, fallas: results.filter((r) => !r.ok).length });
}
