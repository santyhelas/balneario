"use client";
import { useEffect, useState, type FormEvent } from "react";
import { PASSWORD_HINT, passwordWeak } from "@/lib/password";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { USERNAME_RE, normalizeUsername } from "@/lib/remember";
import { Alert, Button, Spinner, TextField } from "@/components/ui";

/**
 * Llegada desde el mail de invitación (o de «elegí tu contraseña») que manda el dueño al habilitar un balneario.
 * El enlace trae la sesión en la dirección (#access_token=…); se guarda y se pide usuario y contraseña.
 * Enlace nuevo (?token_hash=…&type=invite): se valida recién cuando la persona toca «Continuar», así los
 * antivirus del correo (Hotmail/Outlook abren los enlaces para revisarlos) no lo gastan antes de tiempo.
 */
export default function WelcomePage() {
  const [state, setState] = useState<"cargando" | "confirmar" | "listo" | "error">("cargando");
  const [token, setToken] = useState<{ hash: string; type: string } | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadUser() {
    const sb = getSupabase();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { setError("El enlace venció o ya fue usado. Pedí que te lo manden de nuevo."); return setState("error"); }
    setEmail(user.email ?? null);
    const { data: u } = await sb.rpc("my_username");
    if (typeof u === "string") setUsuario(u);
    setState("listo");
  }

  async function confirmToken() {
    if (!token) return;
    setBusy(true);
    setError(null);
    const sb = getSupabase();
    const types = token.type === "invite" ? ["invite"] : [token.type, "email", "magiclink"];
    let lastErr: unknown = null;
    for (const t of types) {
      const { error: e } = await sb.auth.verifyOtp({ token_hash: token.hash, type: t as "invite" | "email" | "magiclink" });
      if (!e) { lastErr = null; break; }
      lastErr = e;
    }
    setBusy(false);
    window.history.replaceState(null, "", window.location.pathname);
    if (lastErr) { setError("El enlace venció o ya fue usado. Pedí que te lo manden de nuevo."); return setState("error"); }
    await loadUser();
  }

  useEffect(() => {
    (async () => {
      const sb = getSupabase();
      const h = new URLSearchParams(window.location.hash.slice(1));
      const q = new URLSearchParams(window.location.search);
      if (h.get("error_description") || q.get("error_description")) {
        const d = h.get("error_description") || q.get("error_description") || "";
        setError(/expired|invalid/i.test(d) ? "El enlace venció o ya fue usado. Pedí que te lo manden de nuevo." : d);
        return setState("error");
      }
      const th = q.get("token_hash");
      if (th) { setToken({ hash: th, type: q.get("type") ?? "invite" }); return setState("confirmar"); }
      const access = h.get("access_token");
      const refresh = h.get("refresh_token");
      if (access && refresh) {
        const { error: e } = await sb.auth.setSession({ access_token: access, refresh_token: refresh });
        window.history.replaceState(null, "", window.location.pathname);
        if (e) { setError(friendlyError(e)); return setState("error"); }
      }
      await loadUser();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const u = normalizeUsername(usuario);
    if (!u) return setError("Elegí un usuario para ingresar.");
    if (!USERNAME_RE.test(u)) return setError("El usuario debe tener entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo (sin espacios).");
    const weak = passwordWeak(password);
    if (weak) return setError(weak);
    if (password !== repeat) return setError("Las contraseñas no coinciden.");
    setBusy(true);
    const sb = getSupabase();
    // Primero el usuario (si está tomado, no se toca la contraseña); después la contraseña.
    const r2 = await sb.rpc("set_my_username", { p_username: u });
    if (r2.error) { setBusy(false); return setError(friendlyError(r2.error)); }
    const r1 = await sb.auth.updateUser({ password });
    // Si es la misma contraseña que quedó guardada en un intento anterior, ya está bien.
    if (r1.error && !/different from the old password/i.test(r1.error.message)) { setBusy(false); return setError(friendlyError(r1.error)); }
    window.location.assign("/");
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <img src="/logo.png" alt="" className="h-16 w-16" />
          <h1 className="text-xl font-bold">¡Bienvenido a Mi Balneario!</h1>
          {state === "listo" && <p className="text-sm text-muted">Creá tu usuario y tu contraseña para ingresar.</p>}
        </div>
        {state === "cargando" && <div className="flex items-center justify-center gap-2 text-muted"><Spinner small /> Abriendo tu invitación…</div>}
        {state === "confirmar" && (
          <div className="flex flex-col gap-3 text-center">
            <p className="text-sm text-muted">Tocá el botón para empezar a crear tu usuario y tu contraseña.</p>
            <Button onClick={confirmToken} loading={busy}>Continuar</Button>
          </div>
        )}
        {state === "error" && (
          <div className="flex flex-col gap-3">
            <Alert tone="danger">{error}</Alert>
            <a href="/login" className="text-center text-sm font-medium text-accent hover:underline">Ir a ingresar</a>
          </div>
        )}
        {state === "listo" && (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <TextField label="Correo" type="email" value={email ?? ""} readOnly disabled
              hint="Es el correo de tu cuenta: ahí te llegan los avisos y la recuperación de la contraseña." />
            <TextField label="Usuario" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="username" value={usuario} required
              onChange={(e) => setUsuario(e.target.value)} placeholder="Ej: laola"
              hint="Entre 3 y 30 caracteres, sin espacios. Con él ingresás; también podés entrar con Google." />
            <TextField label="Contraseña" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} hint={PASSWORD_HINT} required />
            <TextField label="Repetila" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
            {error && <Alert tone="danger">{error}</Alert>}
            <Button type="submit" loading={busy}>Guardar y crear mi balneario</Button>
          </form>
        )}
      </div>
    </main>
  );
}
