"use client";
import { getSupabase, setRememberPreference } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { GUEST_MARK } from "@/lib/remember";
import { captchaToken } from "@/components/captcha";

/**
 * Demo: un balneario de prueba propio, con datos inventados, que se borra al salir o al cerrar la pestaña.
 * Si sale bien, entra al sistema; si no, devuelve el error para mostrar.
 */
export async function startDemo(): Promise<string | null> {
  let token: string | undefined;
  try { token = await captchaToken(); } catch (e) { return e instanceof Error ? e.message : "No se pudo verificar que no sos un robot."; }
  setRememberPreference(false); // la sesión de la demo no se recuerda
  const sb = getSupabase();
  const { error: e1 } = await sb.auth.signInAnonymously(token ? { options: { captchaToken: token } } : undefined);
  if (e1) {
    return /anonymous/i.test(e1.message)
      ? "La demo todavía no está activada en el servidor (Supabase → Authentication → Allow anonymous sign-ins)."
      : friendlyError(e1);
  }
  const { error: e2 } = await sb.rpc("start_guest_session");
  if (e2) {
    await sb.auth.signOut();
    return friendlyError(e2);
  }
  try { sessionStorage.setItem(GUEST_MARK, "1"); } catch { /* sin almacenamiento: igual funciona en esta pestaña */ }
  window.location.assign("/");
  return null;
}
