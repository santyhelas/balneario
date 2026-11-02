import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase/server";

// Google y los enlaces de correo vuelven acá con un código que se cambia por la sesión.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  if (code) {
    const supabase = await getServerSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${safeNext}`);
    }
  }
  // Error devuelto por Google/Supabase (por ejemplo, al vincular una cuenta): volver a la pantalla de origen con el motivo.
  const errorDescription = searchParams.get("error_description");
  if (errorDescription && next) {
    const sep = safeNext.includes("?") ? "&" : "?";
    return NextResponse.redirect(`${origin}${safeNext.split("?")[0]}${sep === "&" ? "?" : "?"}error_description=${encodeURIComponent(errorDescription)}`);
  }
  return NextResponse.redirect(`${origin}/login?error=enlace`);
}
