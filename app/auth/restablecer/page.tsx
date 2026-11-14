"use client";
import { useState, type FormEvent } from "react";
import { PASSWORD_HINT, passwordWeak } from "@/lib/password";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { Alert, Button, TextField } from "@/components/ui";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const weak = passwordWeak(password);
    if (weak) return setError(weak);
    if (password !== repeat) return setError("Las contraseñas no coinciden.");
    setBusy(true);
    const { error } = await getSupabase().auth.updateUser({ password });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    window.location.assign("/");
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-line bg-surface p-6">
        <h1 className="text-lg font-semibold">Elegí una contraseña nueva</h1>
        <TextField label="Contraseña nueva" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} hint={PASSWORD_HINT} required />
        <TextField label="Repetila" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" loading={busy}>Guardar y entrar</Button>
      </form>
    </main>
  );
}
