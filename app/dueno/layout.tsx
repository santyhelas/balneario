"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { applyTheme, type ThemePref } from "@/components/workspace";
import { OwnerContext, type OwnerCtx } from "@/components/owner/context";
import { KPI_ICON } from "@/components/owner/board";
import { Button, ConfirmDialog, Spinner, cx } from "@/components/ui";

/** Zona propia del dueño de Mi Balneario: no hace falta tener un balneario; solo entran los administradores de la plataforma. */
const NAV = [
  { href: "/dueno", label: "Resumen", icon: "M4 13h4v7H4zM10 8h4v12h-4zM16 4h4v16h-4z" },
  { href: "/dueno/balnearios", label: "Balnearios", icon: KPI_ICON.casa },
  { href: "/dueno/altas", label: "Altas habilitadas", icon: "M12 5v14M5 12h14" },
  { href: "/dueno/gastos", label: "Gastos", icon: "M3 17l6-6 4 4 8-8M14 7h7v7" },
  { href: "/dueno/precios", label: "Precios", icon: KPI_ICON.plata },
  { href: "/dueno/soporte", label: "Soporte", icon: KPI_ICON.ojo },
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
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" className="h-9 w-9 rounded-xl" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold leading-tight">Mi Balneario · Panel del dueño</div>
              <div className="truncate text-xs text-muted">{ctx.email}</div>
            </div>
            <button type="button" onClick={toggleTheme} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface-2" title="Cambiar tema">
              {theme === "oscuro" ? "Tema claro" : "Tema oscuro"}
            </button>
            {ctx.mineId && <Link href="/" className="hidden rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface-2 sm:inline">Ir a {ctx.mineName ?? "mi balneario"}</Link>}
            <Button variant="ghost" onClick={() => setLeaving(true)}>Salir</Button>
          </div>
          <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-3 pb-2" aria-label="Secciones">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined}
                className={cx("flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors",
                  active(n.href) ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden><path d={n.icon} /></svg>
                {n.label}
              </Link>
            ))}
            {ctx.mineId && <Link href="/" className="flex shrink-0 items-center rounded-full px-4 py-2 text-sm text-muted hover:bg-surface-2 sm:hidden">Mi balneario</Link>}
          </nav>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </div>
      <ConfirmDialog open={leaving} title="Cerrar sesión" confirmLabel="Salir" onCancel={() => setLeaving(false)}
        message="¿Querés cerrar la sesión?"
        onConfirm={async () => { await getSupabase().auth.signOut(); window.location.assign("/"); }} />
    </OwnerContext.Provider>
  );
}
