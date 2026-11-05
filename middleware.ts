import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { REMEMBER_COOKIE, applyRemember } from "@/lib/remember";

type CookieToSet = { name: string; value: string; options: CookieOptions };
import { NextResponse, type NextRequest } from "next/server";

// Rutas que se pueden ver sin haber iniciado sesión.
// /api/cron: tareas automáticas de Vercel (no tienen sesión; cada una se protege sola).
const PUBLIC_PATHS = ["/inicio", "/login", "/auth/callback", "/auth/restablecer", "/auth/ingresar", "/auth/registrar", "/api/cron"];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          const remember = request.cookies.get(REMEMBER_COOKIE)?.value !== "0";
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, applyRemember(options, remember)));
        },
      },
    },
  );

  // Renueva la sesión y verifica al usuario contra Supabase.
  const { data: { user } } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));

  // Sin sesión, la dirección principal muestra la página de presentación.
  if (!user && path === "/") {
    const url = request.nextUrl.clone();
    url.pathname = "/inicio";
    return NextResponse.rewrite(url, { request });
  }
  // Sin sesión, cualquier pantalla del sistema lleva a la presentación (desde ahí se ingresa).
  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }
  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  // Archivos públicos de la app instalable (manifiesto, service worker, pantalla sin conexión) no requieren sesión.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|offline.html|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)"],
};
