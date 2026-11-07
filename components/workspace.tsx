"use client";
import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { Alert, Button, Spinner, TextField } from "@/components/ui";
import { GUEST_MARK } from "@/lib/remember";
import { LocationPicker } from "@/components/location-picker";

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
  logo_data: string | null;
  subtitle: string | null;
  sea_bearing?: number | null;
  /** En pausa (lo decide el dueño del sistema): se ve todo pero no se cargan cambios. */
  paused_at?: string | null;
  paused_reason?: string | null;
  version: number;
};

/** Plan de Mi Balneario de este balneario (null: sin plan, no vence). */
export type MyPlan = {
  plan: "mensual" | "temporada"; precio: number; estado: "pendiente" | "activa" | "cancelada" | "manual" | "exenta";
  pago_hasta: string | null; bloquea_desde: string | null; vencido: boolean; dias_gracia: number; proximo_debito: string | null;
  debito_automatico: boolean; pagador: string | null; ultimo_pago: string | null; ultimo_estado: "aprobado" | "rechazado" | null;
  temporada_hasta: string; hoy: string;
  movimientos: { tipo: string; importe: number | null; detalle: string | null; fecha: string }[];
};

export type Profile = { displayName: string | null; avatar: string | null };

type Ctx = {
  ws: Workspace;
  role: Role;
  isAdmin: boolean;
  userId: string;
  email: string | null;
  /** Entró como invitado: balneario de demostración que se borra al salir. */
  isGuest: boolean;
  profile: Profile;
  theme: ThemePref;
  tempUnit: "C" | "F";
  setTheme: (t: ThemePref) => Promise<void>;
  setTempUnit: (u: "C" | "F") => Promise<void>;
  reloadWorkspace: () => Promise<void>;
  saveProfile: (p: Partial<{ display_name: string | null; avatar_data: string | null }>) => Promise<void>;
  /** Ya vio (o salteó) la guía de bienvenida. */
  guideDone: boolean;
  setGuideDone: (v: boolean) => Promise<void>;
  /** Es el dueño de Mi Balneario (ve el panel de todos los balnearios). */
  isPlatformAdmin: boolean;
  /** Avisos sin ver del panel del dueño (cancelaciones, débitos rechazados, vencidos). */
  adminAlerts: number;
  plan: MyPlan | null;
  reloadPlan: () => Promise<void>;
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

export { GUEST_MARK };

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "onboarding"; userId: string; email: string | null }
  | { kind: "ready"; ws: Workspace; role: Role; userId: string; email: string | null; isGuest: boolean };

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [theme, setThemeState] = useState<ThemePref>("sistema");
  const [tempUnit, setTempUnitState] = useState<"C" | "F">("C");
  const [profile, setProfile] = useState<Profile>({ displayName: null, avatar: null });
  const [guideDone, setGuideDoneState] = useState(true);
  const [isPlatformAdmin, setPlatformAdmin] = useState(false);
  const [adminAlerts, setAdminAlerts] = useState(0);
  const [plan, setPlan] = useState<MyPlan | null>(null);

  const load = useCallback(async () => {
    const sb = getSupabase();
    try {
      const { data: auth, error: authErr } = await sb.auth.getUser();
      if (authErr || !auth.user) {
        window.location.assign("/");
        return;
      }
      const user = auth.user;
      const isGuest = !!(user as { is_anonymous?: boolean }).is_anonymous;
      // Invitado que vuelve en otra pestaña o después de cerrar el sitio: se borra la demostración y empieza de cero.
      if (isGuest) {
        let marked = false;
        try { marked = sessionStorage.getItem(GUEST_MARK) === "1"; } catch { /* sin almacenamiento */ }
        if (!marked) {
          await sb.rpc("end_guest_session").then(() => undefined, () => undefined);
          await sb.auth.signOut();
          window.location.assign("/?demo=fin");
          return;
        }
      }

      // Si la base todavía no tiene la actualización 0010, se piden solo las columnas anteriores.
      let prefs = await sb.from("user_preferences").select("theme, temperature_unit, display_name, avatar_data, guide_done").eq("user_id", user.id).maybeSingle();
      if (prefs.error?.code === "42703") {
        prefs = (await sb.from("user_preferences").select("theme, temperature_unit, display_name, avatar_data").eq("user_id", user.id).maybeSingle()) as typeof prefs;
      }
      if (prefs.error?.code === "42703") {
        prefs = (await sb.from("user_preferences").select("theme, temperature_unit").eq("user_id", user.id).maybeSingle()) as typeof prefs;
      }
      if (prefs.error) throw prefs.error;
      if (prefs.data) {
        setThemeState(prefs.data.theme as ThemePref);
        setTempUnitState(prefs.data.temperature_unit as "C" | "F");
        applyTheme(prefs.data.theme as ThemePref);
        setProfile({ displayName: prefs.data.display_name ?? null, avatar: prefs.data.avatar_data ?? null });
        setGuideDoneState((prefs.data as { guide_done?: boolean }).guide_done !== false);
      }
      sb.rpc("is_platform_admin").then(({ data }) => {
        setPlatformAdmin(data === true);
        if (data === true) sb.rpc("admin_alert_count").then(({ data: n }) => setAdminAlerts(typeof n === "number" ? n : 0), () => undefined);
      }, () => undefined);

      type MemberRow = { role: string; workspaces: unknown };
      const memberQuery = async (cols: string) =>
        (await sb.from("workspace_members").select(`role, workspaces(${cols})` as "role").eq("user_id", user.id).limit(1).maybeSingle()) as unknown as {
          data: MemberRow | null;
          error: { code?: string; message: string } | null;
        };
      let mem = await memberQuery("id, name, timezone, latitude, longitude, map_width, map_height, sea_side, logo_data, subtitle, sea_bearing, paused_at, paused_reason, version");
      if (mem.error?.code === "42703") {
        mem = await memberQuery("id, name, timezone, latitude, longitude, map_width, map_height, sea_side, logo_data, subtitle, sea_bearing, version");
      }
      if (mem.error?.code === "42703") {
        mem = await memberQuery("id, name, timezone, latitude, longitude, map_width, map_height, sea_side, version");
      }
      if (mem.error) throw mem.error;
      if (!mem.data) {
        // Las altas son por plan: solo puede crear su balneario una cuenta habilitada.
        // Si la función no existe todavía (falta la actualización 0028), también se bloquea.
        const allowed = await sb.rpc("can_create_workspace");
        if (allowed.error || allowed.data !== true) {
          await sb.auth.signOut();
          window.location.assign("/?sin_plan=1#planes");
          return;
        }
        setState({ kind: "onboarding", userId: user.id, email: user.email ?? null });
        return;
      }
      const ws = mem.data.workspaces as unknown as Workspace;
      // Plan (si falta la actualización 0030 o no tiene plan, queda en null).
      if (!isGuest) sb.rpc("my_plan", { p_workspace_id: ws.id }).then(({ data }) => setPlan((data as MyPlan | null) ?? null), () => undefined);
      setState({ kind: "ready", ws, role: mem.data.role as Role, userId: user.id, email: user.email ?? null, isGuest });
    } catch (err) {
      setState({ kind: "error", message: friendlyError(err) });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const savePrefs = useCallback(async (patch: { theme?: ThemePref; temperature_unit?: "C" | "F"; display_name?: string | null; avatar_data?: string | null; guide_done?: boolean }) => {
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

  const saveProfile = useCallback(async (p: Partial<{ display_name: string | null; avatar_data: string | null }>) => {
    await savePrefs(p);
    setProfile((prev) => ({
      displayName: p.display_name !== undefined ? p.display_name : prev.displayName,
      avatar: p.avatar_data !== undefined ? p.avatar_data : prev.avatar,
    }));
  }, [savePrefs]);

  const setGuideDone = useCallback(async (v: boolean) => {
    setGuideDoneState(v);
    await savePrefs({ guide_done: v });
  }, [savePrefs]);

  const reloadPlan = useCallback(async () => {
    if (state.kind !== "ready" || state.isGuest) return;
    const { data, error } = await getSupabase().rpc("my_plan", { p_workspace_id: state.ws.id });
    if (!error) setPlan((data as MyPlan | null) ?? null);
  }, [state]);

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
    isGuest: state.isGuest,
    profile,
    theme,
    tempUnit,
    setTheme,
    setTempUnit,
    reloadWorkspace: load,
    saveProfile,
    guideDone,
    setGuideDone,
    isPlatformAdmin,
    adminAlerts,
    plan,
    reloadPlan,
  };
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

function Onboarding({ email, onDone }: { email: string | null; onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tents, setTents] = useState("90");
  const [umbrellas, setUmbrellas] = useState("10");
  const [lat, setLat] = useState<number | null>(null);
  const [lon, setLon] = useState<number | null>(null);
  // Lo que incluye la habilitación (carpas y sombrillas contratadas), si lo dice.
  const [limits, setLimits] = useState<{ carpas: number | null; sombrillas: number | null } | null>(null);
  useEffect(() => {
    getSupabase().rpc("my_signup_limits").then(({ data }) => {
      const l = data as { carpas: number | null; sombrillas: number | null } | null;
      if (!l) return;
      setLimits(l);
      if (l.carpas != null) setTents(String(l.carpas));
      if (l.sombrillas != null) setUmbrellas(String(l.sombrillas));
    });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const sb = getSupabase();
    const { data: wsId, error } = await sb.rpc("create_workspace", { p_name: name, p_tents: Number(tents) || 0, p_umbrellas: Number(umbrellas) || 0 });
    if (error) {
      setBusy(false);
      setError(friendlyError(error));
      return;
    }
    // Ubicación para el clima (si la eligió). Si fallara, se puede cargar después en Configuración.
    if (lat != null && lon != null && typeof wsId === "string") {
      const cur = await sb.from("workspaces").select("version").eq("id", wsId).single();
      if (!cur.error) await sb.from("workspaces").update({ latitude: lat, longitude: lon, version: (cur.data as { version: number }).version + 1 }).eq("id", wsId);
    }
    setBusy(false);
    await onDone();
  }

  async function logout() {
    await getSupabase().auth.signOut();
    window.location.assign("/");
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <h1 className="text-lg font-semibold">Creá tu balneario</h1>
          <p className="text-sm text-muted">
            Vas a quedar como propietario{email ? ` (${email})` : ""}. Tus datos son solo tuyos: ningún otro balneario los ve.
            El plano arranca con filas de carpas y sombrillas que después acomodás en el Mapa.
          </p>
          <TextField label="Nombre del balneario" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Carpas" type="number" inputMode="numeric" min={0} max={limits?.carpas ?? 600} value={tents} onChange={(e) => setTents(e.target.value)} />
            <TextField label="Sombrillas" type="number" inputMode="numeric" min={0} max={limits?.sombrillas ?? 300} value={umbrellas} onChange={(e) => setUmbrellas(e.target.value)} />
          </div>
          {limits && (limits.carpas != null || limits.sombrillas != null) && (
            <p className="text-xs text-muted">Tu plan incluye hasta {limits.carpas ?? "—"} carpas y {limits.sombrillas ?? "—"} sombrillas.</p>
          )}
          <LocationPicker lat={lat} lon={lon} onChange={(a, b) => { setLat(a); setLon(b); }} />
          <p className="text-xs text-muted">La ubicación es para mostrarte el clima, el viento y el sol de tu playa. Si no la ponés ahora, la cargás después en Configuración. Las carpas y sombrillas se pueden mover, renombrar y desactivar cuando quieras; la cantidad máxima es la de tu plan.</p>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" loading={busy}>Crear balneario</Button>
          <button type="button" className="text-sm text-muted hover:underline" onClick={logout}>Usar otra cuenta</button>
        </form>
      </div>
    </main>
  );
}
