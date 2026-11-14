"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { applyTheme, type ThemePref } from "@/components/workspace";
import { OwnerContext, type OwnerCtx } from "@/components/owner/context";
import { KPI_ICON } from "@/components/owner/board";
import { ConfirmDialog, Spinner, cx } from "@/components/ui";

/** Zona propia del dueño de Mi Balneario: no hace falta tener un balneario; solo entran los administradores de la plataforma. */
const NAV = [
  { href: "/dueno", label: "Resumen", icon: "M4 13h4v7H4zM10 8h4v12h-4zM16 4h4v16h-4z" },
  { href: "/dueno/balnearios", label: "Balnearios", icon: KPI_ICON.casa },
  { href: "/dueno/cobros", label: "Cobros", icon: KPI_ICON.calendario },
  { href: "/dueno/renovacion", label: "Renovación", icon: "M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4" },
  { href: "/dueno/interesados", label: "Interesados", icon: KPI_ICON.personas },
  { href: "/dueno/gastos", label: "Gastos", icon: "M3 17l6-6 4 4 8-8M14 7h7v7" },
  { href: "/dueno/instagram", label: "Instagram", icon: "M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM17.5 6.5h.01" },
  { href: "/dueno/soporte", label: "Soporte", icon: KPI_ICON.ojo },
  { href: "/dueno/altas", label: "Altas", icon: "M12 5v14M5 12h14" },
  { href: "/dueno/precios", label: "Precios", icon: KPI_ICON.plata },
];

export default function OwnerLayout({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [ctx, setCtx] = useState<OwnerCtx | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>("sistema");
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    (async () => {
      const sb = getSupabase();
      try { const t = localStorage.getItem("balneario-tema") as ThemePref | null; if (t) { setTheme(t); applyTheme(t); } } catch { /* sin almacenamiento */ }
      const { data: auth } = await sb.auth.getUser();
      if (!auth.user) { window.location.assign("/"); return; }
      const adm = await sb.rpc("is_platform_admin");
      if (adm.error) { setError("No se pudo comprobar el acceso. Revisá la conexión y recargá."); return; }
      if (adm.data !== true) { window.location.assign("/"); return; }
      const prefs = await sb.from("user_preferences").select("theme").eq("user_id", auth.user.id).maybeSingle();
      if (prefs.data?.theme) { setTheme(prefs.data.theme as ThemePref); applyTheme(prefs.data.theme as ThemePref); }
      const mem = await sb.from("workspace_members").select("workspace_id, workspaces(name)").eq("user_id", auth.user.id).limit(1).maybeSingle();
      const w = mem.data as unknown as { workspace_id: string; workspaces: { name: string } | null } | null;
      setCtx({ userId: auth.user.id, email: auth.user.email ?? null, mineId: w?.workspace_id ?? null, mineName: w?.workspaces?.name ?? null });
    })().catch(() => setError("No se pudo cargar el panel. Revisá la conexión y recargá."));
  }, []);

  async function toggleTheme() {
    const next: ThemePref = document.documentElement.getAttribute("data-theme") === "dark" ? "claro" : "oscuro";
    setTheme(next);
    applyTheme(next);
    if (ctx) await getSupabase().from("user_preferences").upsert({ user_id: ctx.userId, theme: next }, { onConflict: "user_id" });
  }

  if (error) return <div className="p-8 text-center text-sm text-danger">{error}</div>;
  if (!ctx) return <div className="flex min-h-screen items-center justify-center gap-2 text-muted"><Spinner small /> Cargando…</div>;

  const active = (h: string) => (h === "/dueno" ? path === "/dueno" : path === h || path.startsWith(h + "/"));
  return (
    <OwnerContext.Provider value={ctx}>
      <div className="min-h-screen bg-bg text-fg">
        <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur print:hidden">
          <div className="mx-auto flex max-w-7xl items-center gap-2 px-3 py-1.5">
            <Link href="/dueno" className="flex shrink-0 items-center gap-2" title="Panel del dueño">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="" className="h-7 w-7 rounded-lg" />
              <span className="hidden text-sm font-bold xl:inline">Panel del dueño</span>
            </Link>
            <nav className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto" aria-label="Secciones">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined}
                  className={cx("flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-medium transition-colors",
                    active(n.href) ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden><path d={n.icon} /></svg>
                  {n.label}
                </Link>
              ))}
            </nav>
            <button type="button" onClick={toggleTheme} className="shrink-0 rounded-full p-1.5 text-muted hover:bg-surface-2 hover:text-fg" title={theme === "oscuro" ? "Tema claro" : "Tema oscuro"} aria-label="Cambiar tema">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
                <path d={theme === "oscuro" ? "M12 3v1M12 20v1M4.2 4.2l.7.7M19.1 19.1l.7.7M3 12h1M20 12h1M4.2 19.8l.7-.7M19.1 4.9l.7-.7M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z" : "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"} />
              </svg>
            </button>
            {ctx.mineId && <Link href="/" className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[13px] font-medium hover:bg-surface-2"><span className="sm:hidden">Mi balneario</span><span className="hidden sm:inline">Ir a mi balneario</span></Link>}
            <button type="button" onClick={() => setLeaving(true)} className="shrink-0 rounded-full px-2.5 py-1 text-[13px] text-muted hover:bg-surface-2 hover:text-fg" title={ctx.email ?? ""}>Salir</button>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-5">{children}</main>
      </div>
      <ConfirmDialog open={leaving} title="Cerrar sesión" confirmLabel="Salir" onCancel={() => setLeaving(false)}
        message="¿Querés cerrar la sesión?"
        onConfirm={async () => { await getSupabase().auth.signOut(); window.location.assign("/"); }} />
    </OwnerContext.Provider>
  );
}
