"use client";
import { useEffect, useState, type FormEvent } from "react";
import { getSupabase, setRememberPreference } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { Alert, Button, Field, Input, TextField } from "@/components/ui";
import { GoogleG } from "@/components/google";
import { SITE_EMAIL } from "@/lib/site";
import { captchaToken } from "@/components/captcha";

type Mode = "ingresar" | "crear" | "recuperar";

async function post(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? { ok: true } : { ok: false, error: data.error ?? "No se pudo completar la operación." };
  } catch {
    return { ok: false, error: "No hay conexión con el servidor. Revisá internet." };
  }
}

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("ingresar");
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [email, setEmail] = useState("");
  const [remember, setRemember] = useState(true);
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [canRegister, setCanRegister] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("error") === "enlace") setError("El enlace venció o ya fue usado. Pedí uno nuevo.");
    if (p.get("invitado") === "fin") setInfo("Saliste de la demo. Todo lo que cargaste se borró.");
    if (p.get("modo") === "crear") window.location.replace("/#planes"); // las altas son por plan
    fetch("/auth/registrar").then((r) => r.json()).then((d: { abierto?: boolean }) => setCanRegister(!!d.abierto)).catch(() => undefined);
  }, []);

  function go(m: Mode) {
    setMode(m);
    setError(null);
    setInfo(null);
    setPassword("");
    setPassword2("");
  }

  async function google() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY! } });
      const s = (await res.json()) as { external?: { google?: boolean } };
      if (!s.external?.google) {
        setBusy(false);
        return setError("El ingreso con Google todavía no está activado en el servidor. Por ahora ingresá con tu usuario y contraseña.");
      }
    } catch {
      setBusy(false);
      return setError("No hay conexión con el servidor. Revisá internet.");
    }
    setRememberPreference(remember);
    const { error } = await getSupabase().auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}/auth/callback` } });
    if (error) {
      setBusy(false);
      setError(friendlyError(error));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (mode === "ingresar") {
      setBusy(true);
      let captcha: string | undefined;
      try { captcha = await captchaToken(); } catch (err) { setBusy(false); return setError((err as Error).message); }
      const r = await post("/auth/ingresar", { usuario, password, recordar: remember, captchaToken: captcha });
      if (!r.ok) {
        setBusy(false);
        return setError(r.error!);
      }
      window.location.assign("/");
      return;
    }
    if (mode === "crear") {
      if (password.length < 8) return setError("La contraseña debe tener al menos 8 caracteres.");
      if (password !== password2) return setError("Las contraseñas no coinciden. Escribila igual en los dos campos.");
      setBusy(true);
      const r = await post("/auth/registrar", { usuario, password, password2 });
      if (!r.ok) {
        setBusy(false);
        return setError(r.error!);
      }
      window.location.assign("/");
      return;
    }
    setBusy(true);
    let captcha: string | undefined;
    try { captcha = await captchaToken(); } catch (err) { setBusy(false); return setError((err as Error).message); }
    const { error } = await getSupabase().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/restablecer`,
      captchaToken: captcha,
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setInfo("Si ese correo está registrado, vas a recibir un enlace para elegir una contraseña nueva.");
  }

  const mismatch = mode === "crear" && password2.length > 0 && password !== password2;

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
      <a href="/" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">← Volver a la página principal</a>
      <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <img src="/logo.png" alt="" className="h-20 w-20" />
          <h1 className="text-xl font-bold">Mi Balneario</h1>
          <p className="text-sm text-muted">
            {mode === "ingresar" ? "Gestión de balnearios · Ingresá con tu usuario" : mode === "crear" ? "Creá tu cuenta y tu balneario" : "Recuperar acceso"}
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          {mode === "recuperar" ? (
            <>
              <TextField label="Correo de tu cuenta" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              <p className="text-xs text-muted">Solo funciona si tu cuenta tiene un correo. Si ingresás con usuario, pedile al propietario que te ponga una contraseña nueva desde Configuración → Usuarios.</p>
            </>
          ) : (
            <>
              <TextField
                label="Usuario"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                value={usuario}
                onChange={(e) => setUsuario(e.target.value)}
                hint={mode === "crear" ? "Entre 3 y 30 caracteres, sin espacios. Ej: santi" : undefined}
              />
              <Field label="Contraseña" htmlFor="pw">
                <div className="relative">
                  <Input
                    id="pw"
                    type={showPw ? "text" : "password"}
                    autoComplete={mode === "crear" ? "new-password" : "current-password"}
                    required
                    minLength={mode === "crear" ? 8 : undefined}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pr-20"
                  />
                  <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute inset-y-0 right-2 my-auto h-8 rounded px-2 text-xs font-medium text-accent">
                    {showPw ? "Ocultar" : "Mostrar"}
                  </button>
                </div>
              </Field>
              {mode === "crear" && (
                <TextField
                  label="Repetí la contraseña"
                  type={showPw ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value)}
                  error={mismatch ? "No coincide con la contraseña." : null}
                  hint="Mínimo 8 caracteres."
                />
              )}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4" />
                Mantener la sesión iniciada
              </label>
            </>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
          {info && <Alert tone="ok">{info}</Alert>}
          <Button type="submit" loading={busy} className="w-full py-2.5" disabled={mismatch}>
            {mode === "ingresar" ? "Ingresar" : mode === "crear" ? "Crear cuenta" : "Enviar enlace"}
          </Button>
        </form>

        {mode === "ingresar" && (
          <>
            <div className="my-5 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-line" /> o ingresá con <span className="h-px flex-1 bg-line" />
            </div>
            <div className="flex justify-center">
              <button
                type="button"
                onClick={google}
                disabled={busy}
                title="Continuar con Google"
                aria-label="Continuar con Google"
                className="flex h-14 w-14 items-center justify-center rounded-xl border border-line bg-white shadow-sm transition hover:shadow-md disabled:opacity-50"
              >
                <GoogleG />
              </button>
            </div>
          </>
        )}

        <div className="mt-5 flex flex-col items-center gap-1 text-sm">
          {mode === "ingresar" ? (
            <>
              <button className="text-accent hover:underline" onClick={() => go("recuperar")}>Olvidé mi contraseña</button>
              {canRegister ? (
                <button className="text-muted hover:underline" onClick={() => go("crear")}>¿No tenés cuenta? Registrate y creá tu balneario</button>
              ) : (
                <p className="text-center text-xs text-muted">
                  ¿Todavía no usás Mi Balneario? <a href="/#planes" className="font-medium text-accent hover:underline">Pedí tu presupuesto</a>.
                  <br />Si trabajás en un balneario, pedile tu usuario al propietario.
                </p>
              )}
            </>
          ) : (
            <button className="text-accent hover:underline" onClick={() => go("ingresar")}>Volver a ingresar</button>
          )}
        </div>
        <p className="mt-5 border-t border-line pt-3 text-center text-xs text-muted">
          <a href="/terminos" className="hover:underline">Términos</a> · <a href="/privacidad" className="hover:underline">Privacidad</a>
          <br />Consultas: <a href={`mailto:${SITE_EMAIL}`} className="text-accent hover:underline">{SITE_EMAIL}</a>
        </p>
      </div>
      </div>
    </main>
  );
}
