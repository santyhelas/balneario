import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { backupFileName, decrypt, deriveKey, encrypt, multipartBody } from "@/lib/drive-core";
import { getServerSupabase } from "@/lib/supabase/server";

// Copias en Google Drive: conexión (OAuth con permiso "drive.file": solo los archivos que crea la página),
// subida de la copia y limpieza de copias viejas (quedan las últimas 30).

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const KEEP = 30;

export function driveConfig() {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  const server = process.env.SUPABASE_SECRET_KEY;
  if (!id || !secret || !server) return null;
  return { id, secret, tokenKey: deriveKey(server, "drive-token"), stateKey: deriveKey(server, "drive-state") };
}

export const DRIVE_NOT_CONFIGURED =
  "Falta configurar Google Drive en el servidor (GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Vercel).";

/** Usuario actual y su balneario (para las rutas que conecta o usa el dueño). */
export async function currentMember() {
  const sb = await getServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data: m } = await sb.from("workspace_members").select("workspace_id, role, workspaces(name, is_demo)").eq("user_id", user.id).maybeSingle();
  if (!m) return null;
  const w = m.workspaces as unknown as { name: string; is_demo?: boolean } | null;
  return { user, ws: m.workspace_id as string, role: m.role as string, wsName: w?.name ?? "Balneario", isDemo: !!w?.is_demo || !!user.is_anonymous };
}

export async function exchangeCode(code: string, redirectUri: string) {
  const cfg = driveConfig()!;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: cfg.id, client_secret: cfg.secret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(body.error_description || body.error || "Google no aceptó la conexión.");
  let email: string | null = null;
  if (body.id_token) {
    try { email = JSON.parse(Buffer.from(body.id_token.split(".")[1], "base64url").toString()).email ?? null; } catch { /* sin correo */ }
  }
  return { access: body.access_token, refresh: body.refresh_token ?? null, email };
}

async function accessFromRefresh(refresh: string): Promise<string> {
  const cfg = driveConfig()!;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refresh, client_id: cfg.id, client_secret: cfg.secret, grant_type: "refresh_token" }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error === "invalid_grant" ? "Google retiró el permiso. Volvé a conectar Google Drive." : "Google no respondió. Se reintenta más tarde.");
  }
  return body.access_token;
}

export async function createFolder(access: string, name: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
  });
  const body = (await res.json()) as { id?: string; error?: { message?: string } };
  if (!res.ok || !body.id) throw new Error(`No se pudo crear la carpeta en Drive: ${body.error?.message ?? res.status}`);
  return body.id;
}

async function folderExists(access: string, id: string): Promise<boolean> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,trashed`, { headers: { Authorization: `Bearer ${access}` } });
  if (!res.ok) return false;
  const b = (await res.json()) as { trashed?: boolean };
  return !b.trashed;
}

export function encryptToken(refresh: string) {
  return encrypt(refresh, driveConfig()!.tokenKey);
}

/** Sube la copia del balneario a su carpeta de Drive y deja solo las últimas 30. */
export async function uploadBackup(admin: SupabaseClient, ws: string): Promise<{ ok: true; file: string } | { ok: false; error: string }> {
  const cfg = driveConfig();
  if (!cfg) return { ok: false, error: DRIVE_NOT_CONFIGURED };
  try {
    const { data: link, error: e1 } = await admin.rpc("drive_get_link", { p_workspace_id: ws });
    if (e1 || !link) throw new Error("Google Drive no está conectado.");
    const l = link as { token_enc: string; folder_id: string | null };
    const refresh = decrypt(l.token_enc, cfg.tokenKey);
    if (!refresh) throw new Error("Hay que volver a conectar Google Drive (cambió la clave del servidor).");
    const access = await accessFromRefresh(refresh);

    const { data: wsRow } = await admin.from("workspaces").select("name").eq("id", ws).single();
    const wsName = (wsRow as { name?: string } | null)?.name ?? "Balneario";
    let folder = l.folder_id;
    if (!folder || !(await folderExists(access, folder))) {
      folder = await createFolder(access, `Copias de seguridad - ${wsName}`);
      await admin.rpc("drive_set_folder", { p_workspace_id: ws, p_folder: folder });
    }

    const { data: payload, error: e2 } = await admin.rpc("backup_payload", { p_workspace_id: ws });
    if (e2 || !payload) throw new Error("No se pudo armar la copia.");
    const name = backupFileName(wsName, new Date());
    const boundary = `balneario${Date.now()}`;
    const up = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipartBody({ name, parents: [folder], mimeType: "application/json" }, JSON.stringify(payload), boundary),
    });
    if (!up.ok) {
      const b = (await up.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(`Drive no aceptó el archivo: ${b.error?.message ?? up.status}`);
    }

    // Limpieza: quedan las últimas 30 copias de la carpeta (solo archivos creados por la página).
    const q = encodeURIComponent(`'${folder}' in parents and trashed = false and mimeType = 'application/json'`);
    const list = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&pageSize=100&fields=files(id)`, { headers: { Authorization: `Bearer ${access}` } });
    if (list.ok) {
      const files = ((await list.json()) as { files?: { id: string }[] }).files ?? [];
      for (const f of files.slice(KEEP)) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${access}` } }).catch(() => undefined);
      }
    }
    await admin.rpc("drive_mark", { p_workspace_id: ws, p_ok: true, p_file: name, p_error: null });
    return { ok: true, file: name };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error desconocido.";
    await admin.rpc("drive_mark", { p_workspace_id: ws, p_ok: false, p_file: null, p_error: msg }).then(() => undefined, () => undefined);
    return { ok: false, error: msg };
  }
}

export async function revokeAndForget(admin: SupabaseClient, ws: string) {
  const cfg = driveConfig();
  const { data: link } = await admin.rpc("drive_get_link", { p_workspace_id: ws });
  const refresh = cfg && link ? decrypt((link as { token_enc: string }).token_enc, cfg.tokenKey) : null;
  if (refresh) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: "POST" }).catch(() => undefined);
  }
  await admin.rpc("drive_delete_link", { p_workspace_id: ws });
}
