"use client";
import { createBrowserClient, parseCookieHeader, serializeCookieHeader, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { REMEMBER_COOKIE, applyRemember } from "@/lib/remember";

let client: SupabaseClient | null = null;

/** Cliente de Supabase para el navegador (usa la sesión del usuario; los permisos los aplica la base). */
export function getSupabase(): SupabaseClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) {
      throw new Error("Falta configurar NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
    }
    client = createBrowserClient(url, key, {
      cookies: {
        getAll() {
          return parseCookieHeader(document.cookie).map((c) => ({ name: c.name, value: c.value ?? "" }));
        },
        setAll(list: { name: string; value: string; options: CookieOptions }[]) {
          const remember = !document.cookie.split(/;\s*/).includes(`${REMEMBER_COOKIE}=0`);
          list.forEach(({ name, value, options }) => {
            document.cookie = serializeCookieHeader(name, value, applyRemember(options, remember));
          });
        },
      },
    });
  }
  return client;
}

/** Guarda la preferencia "Mantener la sesión iniciada" antes de ingresar (por ejemplo, con Google). */
export function setRememberPreference(remember: boolean) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${REMEMBER_COOKIE}=${remember ? "1" : "0"}; Path=/; SameSite=Lax${remember ? `; Max-Age=${60 * 60 * 24 * 400}` : ""}${secure}`;
}
