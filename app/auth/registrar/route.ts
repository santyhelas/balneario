import { getAdminSupabase } from "@/lib/supabase/admin";
import { SERVER_KEY_MISSING, json, passwordProblem, signIn } from "@/lib/auth-server";
import { USERNAME_RE, USER_EMAIL_DOMAIN, normalizeUsername } from "@/lib/remember";

// Creación de cuenta desde la pantalla de inicio.
// Solo está habilitada mientras el balneario no exista (primera instalación).
// Después, las cuentas nuevas las crea el propietario desde Configuración → Usuarios.
export async function GET() {
  const admin = getAdminSupabase();
  if (!admin) return json({ abierto: false, configurado: false });
  const { data, error } = await admin.rpc("setup_done");
  return json({ abierto: !error && data === false, configurado: true });
}

export async function POST(req: Request) {
  const admin = getAdminSupabase();
  if (!admin) return json({ error: SERVER_KEY_MISSING }, 503);
  const { data: done, error: e1 } = await admin.rpc("setup_done");
  if (e1) return json({ error: "No se pudo verificar el estado del sistema." }, 500);
  if (done) return json({ error: "Las cuentas nuevas las crea el propietario del balneario desde Configuración → Usuarios." }, 403);

  let body: { usuario?: string; password?: string; password2?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Solicitud inválida." }, 400);
  }
  const usuario = normalizeUsername(body.usuario ?? "");
  if (!USERNAME_RE.test(usuario)) return json({ error: "El usuario debe tener entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo (sin espacios)." }, 400);
  const pw = passwordProblem(body.password, body.password2);
  if (pw) return json({ error: pw }, 400);

  const { data: exists } = await admin.rpc("login_email_for", { p_username: usuario });
  if (exists) return json({ error: "Ese usuario ya existe. Elegí otro." }, 409);

  const email = `${usuario}@${USER_EMAIL_DOMAIN}`;
  const { data: created, error } = await admin.auth.admin.createUser({ email, password: body.password!, email_confirm: true, user_metadata: { username: usuario } });
  if (error || !created.user) return json({ error: `No se pudo crear la cuenta: ${error?.message ?? "error desconocido"}` }, 500);
  const { error: e2 } = await admin.rpc("register_login", { p_user_id: created.user.id, p_username: usuario, p_login_email: email });
  if (e2) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: e2.message }, 400);
  }
  const problem = await signIn(email, body.password!, true);
  if (problem) return json({ error: problem.error }, problem.status);
  return json({ ok: true });
}
