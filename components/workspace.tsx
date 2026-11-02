"use client";
import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { Alert, Button, Spinner, TextField } from "@/components/ui";

export type Role = "propietario" | "administrador" | "operador";
export type ThemePref = "claro" | "oscuro" | "sistema";

export type Workspace = {
  id: string;
  name: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
  map_width: number;
  map_height: number;
  sea_side: "top" | "bottom" | "left" | "right";
  version: number;
};

type Ctx = {
  ws: Workspace;
  role: Role;
  isAdmin: boolean;
  userId: string;
  email: string | null;
  theme: ThemePref;
  tempUnit: "C" | "F";
  setTheme: (t: ThemePref) => Promise<void>;
  setTempUnit: (u: "C" | "F") => Promise<void>;
  reloadWorkspace: () => Promise<void>;
};

const WorkspaceContext = createContext<Ctx | null>(null);

export function useWorkspace(): Ctx {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace fuera de WorkspaceProvider");
  return ctx;
}

export function applyTheme(t: ThemePref) {
  const dark = t === "oscuro" || (t === "sistema" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  // Color de la barra del sistema en el celular, acorde al tema elegido.
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.removeAttribute("media");
    m.setAttribute("content", dark ? "#162027" : "#ffffff");
  });
  try {
    localStorage.setItem("balneario-tema", t);
  } catch {
    /* sin almacenamiento local: no pasa nada, la preferencia está en la base */
  }
}

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "onboarding"; userId: string; email: string | null }
  | { kind: "ready"; ws: Workspace; role: Role; userId: string; email: string | null };

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [theme, setThemeState] = useState<ThemePref>("sistema");
  const [tempUnit, setTempUnitState] = useState<"C" | "F">("C");

  const load = useCallback(async () => {
    const sb = getSupabase();
    try {
      const { data: auth, error: authErr } = await sb.auth.getUser();
      if (authErr || !auth.user) {
        window.location.assign("/login");
        return;
      }
      const user = auth.user;

      const prefs = await sb.from("user_preferences").select("theme, temperature_unit").eq("user_id", user.id).maybeSingle();
      if (prefs.error) throw prefs.error;
      if (prefs.data) {
        setThemeState(prefs.data.theme as ThemePref);
        setTempUnitState(prefs.data.temperature_unit as "C" | "F");
        applyTheme(prefs.data.theme as ThemePref);
      }

      const mem = await sb
        .from("workspace_members")
        .select("role, workspaces(id, name, timezone, latitude, longitude, map_width, map_height, sea_side, version)")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle();
      if (mem.error) throw mem.error;
      if (!mem.data) {
        setState({ kind: "onboarding", userId: user.id, email: user.email ?? null });
        return;
      }
      const ws = mem.data.workspaces as unknown as Workspace;
      setState({ kind: "ready", ws, role: mem.data.role as Role, userId: user.id, email: user.email ?? null });
    } catch (err) {
      setState({ kind: "error", message: friendlyError(err) });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const savePrefs = useCallback(async (patch: { theme?: ThemePref; temperature_unit?: "C" | "F" }) => {
    const sb = getSupabase();
    const { data: auth } = await sb.auth.getUser();
    if (!auth.user) return;
    const { error } = await sb
      .from("user_preferences")
      .upsert({ user_id: auth.user.id, ...patch, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) throw error;
  }, []);

  const setTheme = useCallback(async (t: ThemePref) => {
    applyTheme(t);
    setThemeState(t);
    await savePrefs({ theme: t });
  }, [savePrefs]);

  const setTempUnit = useCallback(async (u: "C" | "F") => {
    setTempUnitState(u);
    await savePrefs({ temperature_unit: u });
  }, [savePrefs]);

  // Si la preferencia es "sistema", acompañar los cambios del sistema operativo.
  useEffect(() => {
    if (theme !== "sistema") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("sistema");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center gap-3 text-muted">
        <Spinner /> Cargando el balneario…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 p-4">
        <Alert tone="danger">No se pudo cargar la información: {state.message}</Alert>
        <Button onClick={() => { setState({ kind: "loading" }); load(); }}>Reintentar</Button>
      </div>
    );
  }
  if (state.kind === "onboarding") {
    return <Onboarding email={state.email} onDone={load} />;
  }

  const value: Ctx = {
    ws: state.ws,
    role: state.role,
    isAdmin: state.role === "propietario" || state.role === "administrador",
    userId: state.userId,
    email: state.email,
    theme,
    tempUnit,
    setTheme,
    setTempUnit,
    reloadWorkspace: load,
  };
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

function Onboarding({ email, onDone }: { email: string | null; onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await getSupabase().rpc("create_workspace", { p_name: name });
    setBusy(false);
    if (error) {
      if (/ya fue creado/i.test(error.message)) setBlocked(true);
      setError(friendlyError(error));
      return;
    }
    await onDone();
  }

  async function logout() {
    await getSupabase().auth.signOut();
    window.location.assign("/login");
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6">
        {blocked ? (
          <>
            <h1 className="mb-2 text-lg font-semibold">Sin acceso</h1>
            <p className="mb-4 text-sm text-muted">
              La cuenta {email} no tiene permiso para usar este balneario. Pedile al propietario que te invite.
            </p>
            <Button variant="secondary" onClick={logout}>Cerrar sesión</Button>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <h1 className="text-lg font-semibold">Bienvenido</h1>
            <p className="text-sm text-muted">
              Es la primera vez que se usa el sistema. Vas a quedar como propietario del balneario ({email}). Se cargan
              90 carpas y 10 sombrillas iniciales, que después podés modificar.
            </p>
            <TextField label="Nombre del balneario" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            {error && <Alert tone="danger">{error}</Alert>}
            <Button type="submit" loading={busy}>Crear balneario</Button>
            <button type="button" className="text-sm text-muted hover:underline" onClick={logout}>Usar otra cuenta</button>
          </form>
        )}
      </div>
    </main>
  );
}
