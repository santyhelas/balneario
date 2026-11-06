import { json } from "@/lib/auth-server";
import { currentMember } from "@/lib/drive";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { mp, mpConfig, syncPreapproval } from "@/lib/mercadopago";

export const dynamic = "force-dynamic";

// "No renovar": cancela el débito en Mercado Pago. Sigue usando el sistema hasta el día pago.
export async function POST() {
  const admin = getAdminSupabase();
  if (!admin || !mpConfig()) return json({ error: "Mercado Pago no está configurado." }, 503);
  const me = await currentMember();
  if (!me) return json({ error: "Tenés que iniciar sesión." }, 401);
  if (me.role !== "propietario" || me.isDemo) return json({ error: "Solo el propietario puede cancelar el plan." }, 403);
  const { data: plan } = await admin.rpc("plan_for_checkout", { p_workspace_id: me.ws });
  const id = (plan as { preapproval?: string | null } | null)?.preapproval;
  if (!id) return json({ error: "No hay un débito automático para cancelar." }, 400);
  try {
    await mp(`/preapproval/${encodeURIComponent(id)}`, { method: "PUT", body: { status: "cancelled" } });
    await syncPreapproval(admin, id);
    return json({ ok: true });
  } catch (err) {
    console.error("[plan-cancelar]", err);
    return json({ error: `No se pudo cancelar en Mercado Pago: ${err instanceof Error ? err.message : "error"}. Probá de nuevo o escribinos.` }, 502);
  }
}
