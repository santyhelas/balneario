import { getAdminSupabase } from "@/lib/supabase/admin";
import { getServerSupabase } from "@/lib/supabase/server";
import { SERVER_KEY_MISSING, json } from "@/lib/auth-server";
import { SITE_URL } from "@/lib/site";

// Panel del dueño: le manda al cliente habilitado un mail para que elija su usuario y contraseña.
// Si la cuenta todavía no existe se usa la invitación de Supabase; si ya existe (por ejemplo,
// entró antes con Google), un mail para elegir contraseña. En los dos casos el enlace vuelve a
// /auth/bienvenida, que deja la sesión iniciada y pide usuario y contraseña.
export async function POST(req: Request) {
  const sb = await getServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user || user.is_anonymous) return json({ error: "Tu sesión venció. Volvé a ingresar." }, 401);
  const { data: isAdmin } = await sb.rpc("is_platform_admin");
  if (isAdmin !== true) return json({ error: "Solo el dueño de Mi Balneario puede mandar invitaciones." }, 403);
  const admin = getAdminSupabase();
  if (!admin) return json({ error: SERVER_KEY_MISSING }, 503);

  let body: { email?: string };
  try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
  const email = (body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Correo inválido." }, 400);

  const origin = new URL(req.url).origin;
  const base = origin.includes("localhost") || origin.includes("127.0.0.1") ? origin : SITE_URL;
  const redirectTo = `${base}/auth/bienvenida`;

  const inv = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
  if (!inv.error) return json({ ok: true, tipo: "invitacion" });
  if (/already|registered|exists/i.test(inv.error.message)) {
    const rec = await admin.auth.resetPasswordForEmail(email, { redirectTo });
    if (!rec.error) return json({ ok: true, tipo: "ya_tenia_cuenta" });
    return json({ error: mailProblem(rec.error.message) }, 502);
  }
  return json({ error: mailProblem(inv.error.message) }, 502);
}

function mailProblem(m: string) {
  if (/rate limit|too many/i.test(m)) return "Supabase no deja mandar más mails por ahora (límite por hora del correo gratuito). Configurá un SMTP propio en Supabase o probá más tarde.";
  if (/not authorized|authorized address|smtp/i.test(m)) return "El correo de Supabase solo manda mails a tu equipo. Configurá un SMTP propio (Supabase → Authentication → Emails → SMTP).";
  return `No se pudo mandar el mail: ${m}`;
}
