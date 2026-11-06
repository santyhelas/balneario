import { type NextRequest } from "next/server";
import { json } from "@/lib/auth-server";
import { currentMember } from "@/lib/drive";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { mp, mpConfig, type Preapproval } from "@/lib/mercadopago";
import { recurringFor } from "@/lib/mercadopago-core";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";

// El propietario activa el débito automático: se crea la suscripción en Mercado Pago
// y se lo manda a pagar ahí (carga su tarjeta de crédito, débito o dinero en cuenta).
export async function POST(req: NextRequest) {
  const admin = getAdminSupabase();
  if (!admin || !mpConfig()) return json({ error: "El cobro con Mercado Pago todavía no está configurado. Escribinos para pagar." }, 503);
  const me = await currentMember();
  if (!me) return json({ error: "Tenés que iniciar sesión." }, 401);
  if (me.role !== "propietario" || me.isDemo) return json({ error: "Solo el propietario del balneario puede activar el débito." }, 403);

  let payerEmail = "";
  try { payerEmail = String(((await req.json()) as { email?: string }).email ?? "").trim().toLowerCase(); } catch { /* sin datos */ }
  if (!payerEmail) payerEmail = (me.user.email ?? "").toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payerEmail) || payerEmail.endsWith(".invalid")) {
    return json({ error: "Poné el correo de tu cuenta de Mercado Pago (o el que vas a usar para pagar)." }, 400);
  }

  const { data: plan, error } = await admin.rpc("plan_for_checkout", { p_workspace_id: me.ws });
  if (error || !plan) return json({ error: "Tu balneario no tiene un plan asignado. Escribinos." }, 400);
  const p = plan as { plan: "mensual" | "temporada"; precio: number; estado: string; preapproval: string | null; balneario: string; hoy: string; inicio_temporada: string };
  if (p.estado === "exenta") return json({ error: "Tu plan no necesita pago." }, 400);
  if (!(Number(p.precio) > 0)) return json({ error: "Tu plan todavía no tiene precio. Escribinos." }, 400);

  // Si había un débito anterior sin terminar o cancelado, se reemplaza por uno nuevo.
  if (p.preapproval && p.estado === "activa") return json({ error: "El débito automático ya está activo." }, 409);
  if (p.preapproval) {
    await mp(`/preapproval/${encodeURIComponent(p.preapproval)}`, { method: "PUT", body: { status: "cancelled" } }).catch(() => undefined);
  }

  try {
    const pre = await mp<Preapproval>("/preapproval", {
      method: "POST",
      idempotencyKey: `${me.ws}:${Date.now()}`,
      body: {
        reason: `Mi Balneario · plan ${p.plan === "mensual" ? "mensual" : "por temporada"} · ${p.balneario}`.slice(0, 120),
        external_reference: me.ws,
        payer_email: payerEmail,
        auto_recurring: recurringFor(p.plan, Number(p.precio), p.inicio_temporada, p.hoy),
        back_url: `${SITE_URL}/configuracion?plan=listo#plan`,
        status: "pending",
      },
    });
    const { error: e2 } = await admin.rpc("plan_mp_link", { p_workspace_id: me.ws, p_preapproval_id: pre.id, p_payer_email: payerEmail });
    if (e2) throw new Error(e2.message);
    if (!pre.init_point) throw new Error("Mercado Pago no devolvió el enlace de pago.");
    return json({ url: pre.init_point });
  } catch (err) {
    console.error("[plan-suscribir]", err);
    return json({ error: `No se pudo crear el débito en Mercado Pago: ${err instanceof Error ? err.message : "error desconocido"}` }, 502);
  }
}
