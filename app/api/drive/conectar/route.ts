import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { signState } from "@/lib/drive-core";
import { DRIVE_SCOPE, currentMember, driveConfig } from "@/lib/drive";

// Paso 1: lleva al propietario a Google para dar permiso (solo archivos que crea la página).
export async function GET(req: NextRequest) {
  const back = (msg: string) => NextResponse.redirect(new URL(`/copias?drive=${encodeURIComponent(msg)}`, req.url));
  const cfg = driveConfig();
  if (!cfg) return back("sin-configurar");
  const me = await currentMember();
  if (!me) return NextResponse.redirect(new URL("/login", req.url));
  if (me.role !== "propietario") return back("solo-propietario");
  if (me.isDemo) return back("invitado");

  const nonce = randomBytes(16).toString("hex");
  const state = signState(JSON.stringify({ ws: me.ws, u: me.user.id, n: nonce, t: Date.now() }), cfg.stateKey);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", cfg.id);
  url.searchParams.set("redirect_uri", new URL("/api/drive/callback", req.url).toString());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", `openid email ${DRIVE_SCOPE}`);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  const res = NextResponse.redirect(url);
  res.cookies.set("drive_nonce", nonce, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/drive", maxAge: 600 });
  return res;
}
