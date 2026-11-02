import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase/server";
import { REMEMBER_COOKIE, REMEMBER_MAX_AGE } from "@/lib/remember";

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Inicia sesión en el servidor y deja las cookies de sesión en la respuesta. */
export async function signIn(email: string, password: string, remember: boolean) {
  const store = await cookies();
  const base = { path: "/", sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", httpOnly: false };
  store.set(REMEMBER_COOKIE, remember ? "1" : "0", remember ? { ...base, maxAge: REMEMBER_MAX_AGE } : base);
  const sb = await getServerSupabase(remember);
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (!error) return null;
  if (/invalid login credentials/i.test(error.message)) return { status: 401, error: "Usuario o contraseña incorrectos." };
  if (/email not confirmed/i.test(error.message)) return { status: 401, error: "La cuenta todavía no confirmó el correo. Revisá tu bandeja de entrada." };
  if (/rate limit|too many/i.test(error.message)) return { status: 429, error: "Demasiados intentos seguidos. Esperá unos minutos." };
  return { status: 500, error: "No se pudo iniciar sesión. Probá de nuevo." };
}

export function passwordProblem(p: unknown, p2: unknown): string | null {
  if (typeof p !== "string" || p.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
  if (p.length > 72) return "La contraseña puede tener hasta 72 caracteres.";
  if (p !== p2) return "Las contraseñas no coinciden.";
  return null;
}

export const SERVER_KEY_MISSING =
  "Falta configurar la clave secreta del servidor (SUPABASE_SECRET_KEY) en Vercel. Mientras tanto, ingresá con tu correo.";
