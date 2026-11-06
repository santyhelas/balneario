import { json } from "@/lib/auth-server";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { mpConfig, syncAll } from "@/lib/mercadopago";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Revisión diaria de los débitos (por si se perdió algún aviso de Mercado Pago).
// Es segura aunque alguien la llame a mano: solo copia a la base lo que dice Mercado Pago.
export async function GET() {
  const admin = getAdminSupabase();
  if (!admin || !mpConfig()) return json({ ok: false, motivo: "sin configurar" });
  const { data, error } = await admin.rpc("plan_mp_pending");
  if (error) return json({ ok: false, motivo: "sin la actualización 0030" });
  const started = Date.now();
  let ok = 0;
  let fail = 0;
  for (const id of (data ?? []) as string[]) {
    if (Date.now() - started > 45_000) break;
    try { await syncAll(admin, id); ok += 1; } catch (err) { fail += 1; console.error("[cron-planes]", id, err); }
  }
  return json({ ok: true, revisados: ok, fallas: fail });
}
