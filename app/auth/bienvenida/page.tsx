"use client";
import { useEffect, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { USERNAME_RE, normalizeUsername } from "@/lib/remember";
import { Alert, Button, Spinner, TextField } from "@/components/ui";

/**
 * Llegada desde el mail de invitación (o de «elegí tu contraseña») que manda el dueño al habilitar un balneario.
 * El enlace trae la sesión en la dirección (#access_token=…); se guarda y se pide usuario y contraseña.
 */
export default function WelcomePage() {
  const [state, setState] = useState<"cargando" | "listo" | "error">("cargando");
  const [email, setEmail] = useState<string | null>(null);
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const sb = getSupabase();
      const h = new URLSearchParams(window.location.hash.slice(1));
      const q = new URLSearchParams(window.location.search);
      if (h.get("error_description") || q.get("error_description")) {
        setError(h.get("error_description") || q.get("error_description"));
        return setState("error");
      }
      const access = h.get("access_token");
      const refresh = h.get("refresh_token");
      if (access && refresh) {
        const { error: e } = await sb.auth.setSession({ access_token: access, refresh_token: refresh });
        window.history.replaceState(null, "", window.location.pathname);
        if (e) { setError(friendlyError(e)); return setState("error"); }
      }
      const { data: { user } } = await sb.auth.getUser();
      if (!user) { setError("El enlace venció o ya fue usado. Pedí que te lo manden de nuevo."); return setState("error"); }
      setEmail(user.email ?? null);
      const { data: u } = await sb.rpc("my_username");
      if (typeof u === "string") setUsuario(u);
      setState("listo");
    })();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const u = normalizeUsername(usuario);
    if (u && !USERNAME_RE.test(u)) return setError("El usuario debe tener entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo (sin espacios).");
    if (password.length < 8) return setError("La contraseña debe tener al menos 8 caracteres.");
    if (password !== repeat) return setError("Las contraseñas no coinciden.");
    setBusy(true);
    const sb = getSupabase();
    const r1 = await sb.auth.updateUser({ password });
    if (r1.error) { setBusy(false); return setError(friendlyError(r1.error)); }
    if (u) {
      const r2 = await sb.rpc("set_my_username", { p_username: u });
      if (r2.error) { setBusy(false); return setError(friendlyError(r2.error)); }
    }
    window.location.assign("/");
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <img src="/logo.png" alt="" className="h-16 w-16" />
          <h1 className="text-xl font-bold">¡Bienvenido a Mi Balneario!</h1>
          {state === "listo" && <p className="text-sm text-muted">Elegí cómo vas a ingresar{email ? <> con <strong className="text-fg">{email}</strong></> : null}.</p>}
        </div>
        {state === "cargando" && <div className="flex items-center justify-center gap-2 text-muted"><Spinner small /> Abriendo tu invitación…</div>}
        {state === "error" && (
          <div className="flex flex-col gap-3">
            <Alert tone="danger">{error}</Alert>
            <a href="/login" className="text-center text-sm font-medium text-accent hover:underline">Ir a ingresar</a>
          </div>
        )}
        {state === "listo" && (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <TextField label="Usuario (opcional)" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={usuario}
              onChange={(e) => setUsuario(e.target.value)} placeholder="Ej: laola" />
            <p className="-mt-2 text-xs text-muted">Si no elegís uno, ingresás con tu correo. También vas a poder entrar con Google.</p>
            <TextField label="Contraseña" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <TextField label="Repetila" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
            {error && <Alert tone="danger">{error}</Alert>}
            <Button type="submit" loading={busy}>Guardar y crear mi balneario</Button>
          </form>
        )}
      </div>
    </main>
  );
}
