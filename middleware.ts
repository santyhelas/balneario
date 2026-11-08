import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { REMEMBER_COOKIE, applyRemember } from "@/lib/remember";

type CookieToSet = { name: string; value: string; options: CookieOptions };
import { NextResponse, type NextRequest } from "next/server";

// Rutas que se pueden ver sin haber iniciado sesión.
// /api/cron: tareas automáticas de Vercel (no tienen sesión; cada una se protege sola).
const PUBLIC_PATHS = ["/inicio", "/terminos", "/privacidad", "/robots.txt", "/sitemap.xml", "/login", "/auth/callback", "/auth/restablecer", "/auth/ingresar", "/auth/registrar", "/api/cron", "/api/mp/webhook"];

// Dirección vieja del sitio: quien entra por ahí pasa a la nueva (cuando NEXT_PUBLIC_SITE_URL ya es la nueva).
const OLD_HOSTS = ["balneario-beta.vercel.app"];

export async function middleware(request: NextRequest) {
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  const host = request.headers.get("host") ?? "";
  if (site && OLD_HOSTS.includes(host) && (request.method === "GET" || request.method === "HEAD")) {
    const target = new URL(site);
    const p = request.nextUrl.pathname;
    // Las tareas automáticas, los avisos de Mercado Pago y un ingreso a medio hacer siguen en la vieja.
    if (target.host !== host && !p.startsWith("/api/") && !p.startsWith("/auth/")) {
      const to = new URL(p + request.nextUrl.search, target);
      return NextResponse.redirect(to, 308);
    }
  }

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
  // Sin sesión, los pedidos a la API reciben un error claro (no la página de presentación).
  if (!user && !isPublic && path.startsWith("/api/")) {
    return NextResponse.json({ error: "Tenés que iniciar sesión." }, { status: 401 });
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
