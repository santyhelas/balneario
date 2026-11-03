import { getAdminSupabase } from "@/lib/supabase/admin";
import { getServerSupabase } from "@/lib/supabase/server";
import { SERVER_KEY_MISSING, json, passwordProblem } from "@/lib/auth-server";
import { USERNAME_RE, USER_EMAIL_DOMAIN, normalizeUsername } from "@/lib/remember";

// Gestión de usuarios del balneario (propietario o administrador).

async function caller() {
  const sb = await getServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: json({ error: "Tu sesión venció. Volvé a ingresar." }, 401) };
  if (user.is_anonymous) return { error: json({ error: "En el modo invitado no se pueden crear ni cambiar usuarios." }, 403) };
  const { data: m } = await sb.from("workspace_members").select("workspace_id, role").eq("user_id", user.id).maybeSingle();
  if (!m || !["propietario", "administrador"].includes(m.role)) {
    return { error: json({ error: "Solo el propietario o un administrador pueden gestionar usuarios." }, 403) };
  }
  return { sb, user, ws: m.workspace_id as string, role: m.role as string };
}

// Crear un usuario con acceso al balneario.
export async function POST(req: Request) {
  const c = await caller();
  if ("error" in c) return c.error;
  const admin = getAdminSupabase();
  if (!admin) return json({ error: SERVER_KEY_MISSING }, 503);
  let body: { usuario?: string; password?: string; password2?: string; rol?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Solicitud inválida." }, 400);
  }
  const usuario = normalizeUsername(body.usuario ?? "");
  if (!USERNAME_RE.test(usuario)) return json({ error: "El usuario debe tener entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo (sin espacios)." }, 400);
  const rol = body.rol === "administrador" ? "administrador" : "operador";
  if (rol === "administrador" && c.role !== "propietario") return json({ error: "Solo el propietario puede crear administradores." }, 403);
  const pw = passwordProblem(body.password, body.password2);
  if (pw) return json({ error: pw }, 400);
  const { data: exists } = await admin.rpc("login_email_for", { p_username: usuario });
  if (exists) return json({ error: "Ese usuario ya existe. Elegí otro." }, 409);

  const email = `${usuario}@${USER_EMAIL_DOMAIN}`;
  const { data: created, error } = await admin.auth.admin.createUser({ email, password: body.password!, email_confirm: true, user_metadata: { username: usuario } });
  if (error || !created.user) return json({ error: `No se pudo crear el usuario: ${error?.message ?? "error desconocido"}` }, 500);
  const { error: e2 } = await admin.rpc("register_login", { p_user_id: created.user.id, p_username: usuario, p_login_email: email, p_workspace_id: c.ws, p_role: rol });
  if (e2) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: e2.message }, 400);
  }
  return json({ ok: true, usuario });
}

// Cambiar la contraseña de otro usuario.
export async function PATCH(req: Request) {
  const c = await caller();
  if ("error" in c) return c.error;
  const admin = getAdminSupabase();
  if (!admin) return json({ error: SERVER_KEY_MISSING }, 503);
  let body: { user_id?: string; password?: string; password2?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Solicitud inválida." }, 400);
  }
  if (!body.user_id || body.user_id === c.user.id) return json({ error: "Para tu propia contraseña usá «Cambiar contraseña» en tu perfil." }, 400);
  const pw = passwordProblem(body.password, body.password2);
  if (pw) return json({ error: pw }, 400);
  const { data: target } = await c.sb.from("workspace_members").select("role").eq("workspace_id", c.ws).eq("user_id", body.user_id).maybeSingle();
  if (!target) return json({ error: "Ese usuario no tiene acceso a este balneario." }, 404);
  if (target.role === "propietario" || (c.role === "administrador" && target.role !== "operador")) {
    return json({ error: "No tenés permiso para cambiar la contraseña de ese usuario." }, 403);
  }
  const { error } = await admin.auth.admin.updateUserById(body.user_id, { password: body.password! });
  if (error) return json({ error: `No se pudo cambiar la contraseña: ${error.message}` }, 500);
  return json({ ok: true });
}
