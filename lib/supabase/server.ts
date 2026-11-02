import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { REMEMBER_COOKIE, applyRemember } from "@/lib/remember";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/** Cliente de Supabase en el servidor, con la sesión tomada de las cookies. */
export async function getServerSupabase(rememberOverride?: boolean) {
  const cookieStore = await cookies();
  const remember = rememberOverride ?? cookieStore.get(REMEMBER_COOKIE)?.value !== "0";
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, applyRemember(options, remember)));
          } catch {
            // Llamado desde un Server Component: el middleware ya renueva la sesión.
          }
        },
      },
    },
  );
}
