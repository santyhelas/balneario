import { createHash } from "node:crypto";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { json } from "@/lib/auth-server";

/** Pedido de presupuesto desde la web: queda en «Interesados» del panel del dueño. Máximo 5 por día por conexión. */
export async function POST(req: Request) {
  const admin = getAdminSupabase();
  if (!admin) return json({ error: "Ahora no se puede mandar. Escribinos por WhatsApp." }, 503);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
  // Campo trampa: los programas automáticos lo completan, las personas no lo ven.
  if (typeof body.web === "string" && body.web) return json({ ok: true, presupuesto: {} });
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "sin-ip";
  const hash = createHash("sha256").update(`presupuesto:${process.env.SUPABASE_SECRET_KEY ?? ""}:${ip}`).digest("hex");
  const pick = (k: string) => (typeof body[k] === "string" || typeof body[k] === "number" ? String(body[k]).slice(0, 2000) : "");
  const p = { nombre: pick("nombre"), balneario: pick("balneario"), telefono: pick("telefono"), correo: pick("correo"), ciudad: pick("ciudad"),
    carpas: pick("carpas"), sombrillas: pick("sombrillas"), mensaje: pick("mensaje") };
  const { data, error } = await admin.rpc("submit_quote_request", { p_hash: hash, p });
  if (error) return json({ error: error.message.replace(/^.*?: /, "") }, 400);
  return json({ ok: true, presupuesto: data ?? {} });
}
