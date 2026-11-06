import { NextResponse, type NextRequest } from "next/server";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { mpConfig, syncPayment, syncPreapproval } from "@/lib/mercadopago";
import { verifyMpSignature } from "@/lib/mercadopago-core";

export const dynamic = "force-dynamic";

// Avisos de Mercado Pago sobre los débitos de los planes.
// Solo se aceptan avisos firmados con la clave secreta (MP_WEBHOOK_SECRET); igual, los datos
// se vuelven a pedir a Mercado Pago: nunca se confía en lo que trae el aviso.
export async function POST(req: NextRequest) {
  const cfg = mpConfig();
  const admin = getAdminSupabase();
  if (!cfg || !admin || !cfg.webhookSecret) return NextResponse.json({ ok: false, motivo: "sin configurar" }, { status: 503 });

  const url = new URL(req.url);
  let body: { type?: string; topic?: string; data?: { id?: string | number } } = {};
  try { body = await req.json(); } catch { /* sin cuerpo */ }
  const type = url.searchParams.get("type") ?? url.searchParams.get("topic") ?? body.type ?? body.topic ?? "";
  const dataId = url.searchParams.get("data.id") ?? (body.data?.id != null ? String(body.data.id) : null);

  const ok = verifyMpSignature({ signature: req.headers.get("x-signature"), requestId: req.headers.get("x-request-id"), dataId, secret: cfg.webhookSecret });
  if (!ok) return NextResponse.json({ ok: false }, { status: 401 });
  if (!dataId) return NextResponse.json({ ok: true });

  try {
    if (type === "subscription_preapproval" || type === "preapproval") await syncPreapproval(admin, dataId);
    else if (type === "subscription_authorized_payment" || type === "authorized_payment") await syncPayment(admin, dataId);
    // Otros avisos (pagos sueltos, etc.) no se usan.
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[mp-webhook]", type, err);
    // 500: Mercado Pago lo reintenta más tarde.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
