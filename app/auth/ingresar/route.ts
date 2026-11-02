import { getAdminSupabase } from "@/lib/supabase/admin";
import { SERVER_KEY_MISSING, json, signIn } from "@/lib/auth-server";
import { normalizeUsername } from "@/lib/remember";

// Ingreso con usuario (o correo) y contraseña.
// El correo asociado a un usuario se busca acá, en el servidor: nunca llega al navegador.
export async function POST(req: Request) {
  let body: { usuario?: string; password?: string; recordar?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Solicitud inválida." }, 400);
  }
  const usuario = (body.usuario ?? "").trim();
  const password = body.password ?? "";
  if (!usuario || !password) return json({ error: "Completá usuario y contraseña." }, 400);

  let email = usuario;
  if (!usuario.includes("@")) {
    const admin = getAdminSupabase();
    if (!admin) return json({ error: SERVER_KEY_MISSING }, 503);
    const { data, error } = await admin.rpc("login_email_for", { p_username: normalizeUsername(usuario) });
    if (error) return json({ error: "No se pudo verificar el usuario. Probá de nuevo." }, 500);
    if (!data) return json({ error: "Usuario o contraseña incorrectos." }, 401);
    email = data as string;
  }

  const problem = await signIn(email, password, body.recordar !== false);
  if (problem) return json({ error: problem.error }, problem.status);
  return json({ ok: true });
}
