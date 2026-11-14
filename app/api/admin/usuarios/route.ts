import { getAdminSupabase } from "@/lib/supabase/admin";
import { getServerSupabase } from "@/lib/supabase/server";
import { SERVER_KEY_MISSING, json, passwordProblem } from "@/lib/auth-server";
import { USERNAME_RE, USER_EMAIL_DOMAIN, normalizeUsername } from "@/lib/remember";

// Panel del dueño: crear un usuario (usuario y contraseña) dentro de la cuenta de un balneario.
export async function POST(req: Request) {
  const sb = await getServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user || user.is_anonymous) return json({ error: "Tu sesión venció. Volvé a ingresar." }, 401);
  const { data: isAdmin } = await sb.rpc("is_platform_admin");
  if (isAdmin !== true) return json({ error: "Solo el dueño de Mi Balneario puede crear usuarios en otras cuentas." }, 403);
  const admin = getAdminSupabase();
  if (!admin) return json({ error: SERVER_KEY_MISSING }, 503);

  let body: { workspace_id?: string; usuario?: string; password?: string; password2?: string; rol?: string };
  try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
  const ws = body.workspace_id ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(ws)) return json({ error: "Balneario inválido." }, 400);
  const { data: exists } = await admin.from("workspaces").select("id").eq("id", ws).maybeSingle();
  if (!exists) return json({ error: "Ese balneario no existe." }, 404);
  const usuario = normalizeUsername(body.usuario ?? "");
  if (!USERNAME_RE.test(usuario)) return json({ error: "El usuario debe tener entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo (sin espacios)." }, 400);
  const rol = body.rol === "administrador" ? "administrador" : "operador";
  const pw = passwordProblem(body.password, body.password2);
  if (pw) return json({ error: pw }, 400);
  const { data: taken } = await admin.rpc("login_email_for", { p_username: usuario });
  if (taken) return json({ error: "Ese usuario ya existe. Elegí otro." }, 409);

  const email = `${usuario}@${USER_EMAIL_DOMAIN}`;
  const { data: created, error } = await admin.auth.admin.createUser({ email, password: body.password!, email_confirm: true, user_metadata: { username: usuario } });
  if (error || !created.user) return json({ error: `No se pudo crear el usuario: ${error?.message ?? "error desconocido"}` }, 500);
  const { error: e2 } = await admin.rpc("register_login", { p_user_id: created.user.id, p_username: usuario, p_login_email: email, p_workspace_id: ws, p_role: rol });
  if (e2) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: e2.message }, 400);
  }
  return json({ ok: true, usuario });
}
