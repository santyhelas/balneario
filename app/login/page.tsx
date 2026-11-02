"use client";
import { useEffect, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { Alert, Button, TextField } from "@/components/ui";

type Mode = "ingresar" | "crear" | "recuperar";

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("ingresar");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("error") === "enlace") setError("El enlace venció o ya fue usado. Pedí uno nuevo.");
  }, []);

  async function google() {
    setBusy(true);
    setError(null);
    // Antes de salir hacia Google, verificar que esté activado (si no, Supabase muestra una página técnica).
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, {
        headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY! },
      });
      const settings = (await res.json()) as { external?: { google?: boolean } };
      if (!settings.external?.google) {
        setBusy(false);
        setError("El inicio con Google todavía no está activado. Por ahora usá correo y contraseña.");
        return;
      }
    } catch {
      setBusy(false);
      setError("No hay conexión con el servidor. Revisá internet.");
      return;
    }
    const { error } = await getSupabase().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setBusy(false);
      setError(
        /provider is not enabled|unsupported provider/i.test(error.message)
          ? "El inicio con Google todavía no está activado. Por ahora usá correo y contraseña."
          : friendlyError(error),
      );
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    const sb = getSupabase();
    try {
      if (mode === "ingresar") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        window.location.assign("/");
        return;
      }
      if (mode === "crear") {
        if (password.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres.");
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        if (error) throw error;
        if (data.session) {
          window.location.assign("/");
          return;
        }
        setInfo("Te enviamos un correo para confirmar la cuenta. Abrí el enlace y vas a entrar directamente.");
      }
      if (mode === "recuperar") {
        const { error } = await sb.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth/callback?next=/auth/restablecer`,
        });
        if (error) throw error;
        setInfo("Si el correo está registrado, vas a recibir un enlace para elegir una contraseña nueva.");
      }
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <img src="/icon.svg" alt="" className="h-10 w-10" />
          <div>
            <h1 className="text-lg font-semibold">Gestión del balneario</h1>
            <p className="text-sm text-muted">
              {mode === "ingresar" ? "Iniciá sesión para continuar" : mode === "crear" ? "Crear cuenta" : "Recuperar acceso"}
            </p>
          </div>
        </div>

        {mode !== "recuperar" && (
          <>
            <Button variant="secondary" className="w-full" onClick={google} disabled={busy}>
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
                <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.8-5.5 3.8-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.2 14.6 2.2 12 2.2 6.6 2.2 2.3 6.6 2.3 12S6.6 21.8 12 21.8c5.8 0 9.6-4.1 9.6-9.8 0-.7-.1-1.2-.2-1.8H12z" />
              </svg>
              Continuar con Google
            </Button>
            <div className="my-4 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-line" /> o con correo <span className="h-px flex-1 bg-line" />
            </div>
          </>
        )}

        <form onSubmit={submit} className="flex flex-col gap-3">
          <TextField label="Correo electrónico" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          {mode !== "recuperar" && (
            <TextField
              label="Contraseña"
              type="password"
              autoComplete={mode === "crear" ? "new-password" : "current-password"}
              required
              minLength={mode === "crear" ? 8 : undefined}
              hint={mode === "crear" ? "Mínimo 8 caracteres." : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
          {error && <Alert tone="danger">{error}</Alert>}
          {info && <Alert tone="ok">{info}</Alert>}
          <Button type="submit" loading={busy} className="w-full">
            {mode === "ingresar" ? "Ingresar" : mode === "crear" ? "Crear cuenta" : "Enviar enlace"}
          </Button>
        </form>

        <div className="mt-4 flex flex-col items-center gap-1 text-sm">
          {mode === "ingresar" ? (
            <>
              <button className="text-accent hover:underline" onClick={() => { setMode("recuperar"); setError(null); setInfo(null); }}>
                Olvidé mi contraseña
              </button>
              <button className="text-muted hover:underline" onClick={() => { setMode("crear"); setError(null); setInfo(null); }}>
                Crear una cuenta nueva
              </button>
            </>
          ) : (
            <button className="text-accent hover:underline" onClick={() => { setMode("ingresar"); setError(null); setInfo(null); }}>
              Volver a iniciar sesión
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
