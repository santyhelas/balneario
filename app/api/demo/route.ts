import { createHash } from "node:crypto";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { json } from "@/lib/auth-server";
import { createClient } from "@supabase/supabase-js";

// Contador de la demo: cuántas conexiones distintas la probaron.
// De la IP se guarda solo un código irreversible (hash con una sal del servidor).

export async function GET() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await sb.rpc("demo_visitor_count");
  if (error) return json({ cantidad: null }); // sin la actualización 0040 no se muestra nada
  return Response.json({ cantidad: data as number }, { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } });
}

export async function POST(req: Request) {
  const admin = getAdminSupabase();
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "";
  if (!admin || !ip) return json({ ok: false });
  const salt = process.env.SUPABASE_SECRET_KEY ?? "";
  const hash = createHash("sha256").update(`demo:${salt}:${ip}`).digest("hex");
  await admin.rpc("demo_register_visit", { p_hash: hash }).then(() => undefined, () => undefined);
  return json({ ok: true });
}
