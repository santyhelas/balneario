import { NextResponse, type NextRequest } from "next/server";
import { verifyState } from "@/lib/drive-core";
import { createFolder, currentMember, driveConfig, encryptToken, exchangeCode, uploadBackup, DRIVE_SCOPE } from "@/lib/drive";
import { getAdminSupabase } from "@/lib/supabase/admin";

export const maxDuration = 60;

// Paso 2: Google vuelve con el permiso; se guarda cifrado, se crea la carpeta y se sube la primera copia.
export async function GET(req: NextRequest) {
  const back = (msg: string) => {
    const r = NextResponse.redirect(new URL(`/copias?drive=${encodeURIComponent(msg)}`, req.url));
    r.cookies.delete({ name: "drive_nonce", path: "/api/drive" });
    return r;
  };
  const cfg = driveConfig();
  const admin = getAdminSupabase();
  if (!cfg || !admin) return back("sin-configurar");
  const p = req.nextUrl.searchParams;
  if (p.get("error")) return back("cancelado");
  const raw = verifyState(p.get("state") ?? "", cfg.stateKey);
  if (!raw) return back("error");
  const st = JSON.parse(raw) as { ws: string; u: string; n: string; t: number };
  const me = await currentMember();
  if (!me || me.ws !== st.ws || me.user.id !== st.u || me.role !== "propietario" || me.isDemo) return back("error");
  if (req.cookies.get("drive_nonce")?.value !== st.n || Date.now() - st.t > 10 * 60_000) return back("vencido");
  if (!(p.get("scope") ?? "").includes(DRIVE_SCOPE)) return back("sin-permiso");

  try {
    const tok = await exchangeCode(p.get("code") ?? "", new URL("/api/drive/callback", req.url).toString());
    if (!tok.refresh) return back("sin-permiso");
    const folder = await createFolder(tok.access, `Copias de seguridad - ${me.wsName}`);
    const { error } = await admin.rpc("drive_save_link", { p_workspace_id: me.ws, p_user: me.user.id, p_token_enc: encryptToken(tok.refresh), p_folder: folder, p_email: tok.email });
    if (error) return back("error");
    const first = await uploadBackup(admin, me.ws);
    return back(first.ok ? "conectado" : "conectado-sin-copia");
  } catch {
    return back("error");
  }
}
