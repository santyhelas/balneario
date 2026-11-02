"use client";
import { useEffect, useState } from "react";
import type { UserIdentity } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { Alert, Badge, Button, Card, Spinner } from "@/components/ui";
import { GoogleG } from "@/components/google";

const PROVIDER: Record<string, string> = { email: "Correo y contraseña", google: "Google" };

/** ¿Está activado el inicio con Google en Supabase? (consulta pública de la configuración de acceso) */
export async function googleEnabled(): Promise<boolean | null> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY! },
    });
    const s = (await res.json()) as { external?: { google?: boolean } };
    return !!s.external?.google;
  } catch {
    return null;
  }
}

/**
 * Cuentas con las que se puede entrar al mismo usuario.
 * Vincular Google permite entrar con "Continuar con Google" y seguir viendo los mismos datos.
 */
export function LinkedAccountsCard() {
  const { ws } = useWorkspace();
  const [identities, setIdentities] = useState<UserIdentity[] | null>(null);
  const [google, setGoogle] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger" | "warn"; text: string } | null>(null);

  async function load() {
    const sb = getSupabase();
    const [{ data, error }, g] = await Promise.all([sb.auth.getUserIdentities(), googleEnabled()]);
    if (error) setMsg({ tone: "danger", text: friendlyError(error) });
    setIdentities(data?.identities ?? []);
    setGoogle(g);
  }

  useEffect(() => {
    load();
    // Al volver de Google, Supabase agrega el resultado en la dirección.
    const p = new URLSearchParams(window.location.hash.slice(1) || window.location.search);
    const err = p.get("error_description");
    if (err) {
      setMsg({ tone: "danger", text: /already linked|identity_already_exists|already exists/i.test(err)
        ? "Esa cuenta de Google ya está vinculada a otro usuario. Usá otra cuenta de Google o pedí ayuda."
        : `Google no pudo vincularse: ${err}` });
      window.history.replaceState(null, "", "/configuracion");
    } else if (p.get("vinculado") === "google") {
      setMsg({ tone: "ok", text: "¡Listo! Tu cuenta de Google quedó vinculada. Desde ahora podés entrar con «Continuar con Google»." });
      window.history.replaceState(null, "", "/configuracion");
    }
  }, []);

  const hasGoogle = identities?.some((i) => i.provider === "google");

  async function connectGoogle() {
    setMsg(null);
    setBusy("google");
    const enabled = await googleEnabled();
    if (!enabled) {
      setBusy(null);
      setGoogle(enabled);
      return;
    }
    const { error } = await getSupabase().auth.linkIdentity({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/configuracion?vinculado=google")}` },
    });
    if (error) {
      setBusy(null);
      setMsg({ tone: "danger", text: /manual linking/i.test(error.message)
        ? "Falta activar «Manual linking» en Supabase (Authentication → Sign In / Providers). Mientras tanto, también podés salir y entrar con «Continuar con Google» usando el mismo correo: se vincula solo."
        : friendlyError(error) });
    }
    // Si no hubo error, el navegador ya está yendo a Google.
  }

  async function unlink(identity: UserIdentity) {
    if (!identities || identities.length < 2) return;
    setMsg(null);
    setBusy(identity.identity_id);
    const { error } = await getSupabase().auth.unlinkIdentity(identity);
    setBusy(null);
    if (error) return setMsg({ tone: "danger", text: friendlyError(error) });
    setMsg({ tone: "ok", text: `Se desvinculó ${PROVIDER[identity.provider] ?? identity.provider}.` });
    load();
  }

  void ws;
  return (
    <Card title="Cuentas vinculadas">
      {identities === null ? <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando…</div> : (
        <ul className="mb-3 divide-y divide-line text-sm">
          {identities.map((i) => (
            <li key={i.identity_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <div className="flex items-center gap-2 font-medium">
                  {i.provider === "google" && <GoogleG className="h-4 w-4" />}
                  {PROVIDER[i.provider] ?? i.provider}
                  <Badge tone="ok">Vinculada</Badge>
                </div>
                <div className="text-xs text-muted">
                  {(i.identity_data?.email as string | undefined) ?? ""}{i.last_sign_in_at ? ` · último ingreso ${formatDateTime(i.last_sign_in_at)}` : ""}
                </div>
              </div>
              {identities.length > 1 && i.provider !== "email" && (
                <Button variant="ghost" className="text-danger" loading={busy === i.identity_id} onClick={() => unlink(i)}>Desvincular</Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {identities !== null && !hasGoogle && (
        <>
          <Button variant="secondary" className="w-full" onClick={connectGoogle} loading={busy === "google"} disabled={google === false}>
            <GoogleG className="h-4 w-4" /> Conectar con Google
          </Button>
          {google === false && (
            <Alert tone="warn" className="mt-3">
              El inicio con Google todavía no está activado en el servidor. Hay que hacerlo una sola vez desde Google Cloud y Supabase (te paso los pasos). Mientras tanto seguís entrando con correo y contraseña.
            </Alert>
          )}
          {google !== false && (
            <p className="mt-2 text-xs text-muted">Te lleva a Google para elegir la cuenta. Después vas a poder entrar con «Continuar con Google» y ver los mismos datos.</p>
          )}
        </>
      )}
      {msg && <Alert tone={msg.tone} className="mt-3">{msg.text}</Alert>}
    </Card>
  );
}
