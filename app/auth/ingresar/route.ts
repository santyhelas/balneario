import { getAdminSupabase } from "@/lib/supabase/admin";
import { SERVER_KEY_MISSING, json, signIn } from "@/lib/auth-server";
import { normalizeUsername } from "@/lib/remember";

// Ingreso con usuario (o correo) y contraseña.
// El correo asociado a un usuario se busca acá, en el servidor: nunca llega al navegador.
export async function POST(req: Request) {
  let body: { usuario?: string; password?: string; recordar?: boolean; captchaToken?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Solicitud inválida." }, 400);
  }
  const usuario = (body.usuario ?? "").trim();
  const password = body.password ?? "";
  if (!usuario || !password) return json({ error: "Completá usuario y contraseña." }, 400);

  // Límite de intentos: 10 contraseñas incorrectas por usuario (o 30 por conexión) en 15 minutos.
  const admin = getAdminSupabase();
  const userKey = `u:${usuario.toLowerCase()}`;
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "";
  const ipKey = ip ? `ip:${ip}` : null;
  if (admin) {
    const { data: allowed, error: eLim } = await admin.rpc("login_allowed", { p_user_key: userKey, p_ip_key: ipKey });
    // Si la base todavía no tiene la actualización 0023, se sigue sin límite (no se bloquea a nadie por eso).
    if (!eLim && allowed === false) {
      return json({ error: "Demasiados intentos con contraseña incorrecta. Por seguridad, esperá 15 minutos y probá de nuevo." }, 429);
    }
  }

  let email = usuario;
  if (!usuario.includes("@")) {
    if (!admin) return json({ error: SERVER_KEY_MISSING }, 503);
    const { data, error } = await admin.rpc("login_email_for", { p_username: normalizeUsername(usuario) });
    if (error) return json({ error: "No se pudo verificar el usuario. Probá de nuevo." }, 500);
    if (!data) {
      await admin.rpc("login_record", { p_user_key: userKey, p_ip_key: ipKey, p_ok: false }).then(() => undefined, () => undefined);
      return json({ error: "Usuario o contraseña incorrectos." }, 401);
    }
    email = data as string;
  }

  const captcha = typeof body.captchaToken === "string" && body.captchaToken.length < 4096 ? body.captchaToken : undefined;
  const problem = await signIn(email, password, body.recordar !== false, captcha);
  if (admin && (!problem || problem.status === 401)) {
    await admin.rpc("login_record", { p_user_key: userKey, p_ip_key: ipKey, p_ok: !problem }).then(() => undefined, () => undefined);
  }
  if (problem) return json({ error: problem.error }, problem.status);
  return json({ ok: true });
}
