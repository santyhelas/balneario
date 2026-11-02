"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { useWorkspace, type ThemePref } from "@/components/workspace";
import { ConfirmDialog, cx } from "@/components/ui";

const NAV = [
  { href: "/", label: "Panel", icon: "M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10" },
  { href: "/mapa", label: "Mapa", icon: "M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14" },
  { href: "/caja", label: "Caja", icon: "M3 7h18v12H3zM3 11h18M7 15h3" },
  { href: "/reservas", label: "Reservas", icon: "M8 3v3M16 3v3M4 8h16M5 5h14v15H5zM9 13h2M13 13h2M9 16h2" },
  { href: "/tarifas", label: "Tarifario", icon: "M20 12l-8 8-9-9V3h8l9 9zM7.5 7.5h.01" },
  { href: "/clientes", label: "Clientes", icon: "M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 19v-1a4 4 0 00-3-3.9M16 3.1a3.5 3.5 0 010 6.8" },
];

function Icon({ d, className }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={cx("h-5 w-5", className)} aria-hidden>
      <path d={d} />
    </svg>
  );
}

const THEME_LABEL: Record<ThemePref, string> = { claro: "Claro", oscuro: "Oscuro", sistema: "Automático" };

export function Shell({ children }: { children: ReactNode }) {
  const { ws, email, theme, setTheme, role } = useWorkspace();
  const pathname = usePathname();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  async function logout() {
    setLoggingOut(true);
    await getSupabase().auth.signOut();
    try {
      localStorage.removeItem("balneario-tema");
    } catch {
      /* nada */
    }
    window.location.assign("/login");
  }

  function cycleTheme() {
    const next: ThemePref = theme === "claro" ? "oscuro" : theme === "oscuro" ? "sistema" : "claro";
    setTheme(next).catch(() => {
      /* el tema ya se aplicó en pantalla; si falla guardarlo, se reintenta la próxima vez */
    });
  }

  const nav = (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMenuOpen(false)}
            className={cx(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium",
              active ? "bg-accent-soft text-accent" : "text-fg hover:bg-surface-2",
            )}
          >
            <Icon d={item.icon} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-line bg-surface p-3 md:flex">
        <div className="mb-5 flex items-center gap-2 px-2 pt-1">
          <img src="/icon.svg" alt="" className="h-8 w-8" />
          <span className="truncate font-semibold" title={ws.name}>{ws.name}</span>
        </div>
        {nav}
        <div className="mt-auto flex flex-col gap-1 border-t border-line pt-3 text-sm">
          <button onClick={cycleTheme} className="flex items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-2">
            <Icon d="M12 3v1M12 20v1M4.2 4.2l.7.7M19.1 19.1l.7.7M3 12h1M20 12h1M4.2 19.8l.7-.7M19.1 4.9l.7-.7M12 7a5 5 0 100 10 5 5 0 000-10z" />
            Tema: {THEME_LABEL[theme]}
          </button>
          <div className="truncate px-3 py-1 text-xs text-muted" title={email ?? ""}>
            {email} · {role}
          </div>
          <button onClick={() => setConfirmLogout(true)} className="flex items-center gap-3 rounded-lg px-3 py-2 text-left text-danger hover:bg-surface-2">
            <Icon d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11" />
            Cerrar sesión
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Barra superior en pantallas chicas */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-surface px-3 py-2 md:hidden">
          <button onClick={() => setMenuOpen((v) => !v)} className="rounded-lg p-2 hover:bg-surface-2" aria-label="Menú">
            <Icon d="M4 6h16M4 12h16M4 18h16" />
          </button>
          <span className="truncate font-semibold">{ws.name}</span>
          <button onClick={cycleTheme} className="rounded-lg p-2 hover:bg-surface-2" aria-label={`Tema: ${THEME_LABEL[theme]}`}>
            <Icon d="M12 3v1M12 20v1M4.2 4.2l.7.7M19.1 19.1l.7.7M3 12h1M20 12h1M4.2 19.8l.7-.7M19.1 4.9l.7-.7M12 7a5 5 0 100 10 5 5 0 000-10z" />
          </button>
        </header>
        {menuOpen && (
          <div className="border-b border-line bg-surface p-3 md:hidden">
            {nav}
            <button onClick={() => setConfirmLogout(true)} className="mt-2 w-full rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-surface-2">
              Cerrar sesión ({email})
            </button>
          </div>
        )}
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-6">{children}</main>
      </div>

      <ConfirmDialog
        open={confirmLogout}
        title="¿Cerrar sesión?"
        message="Vas a tener que volver a ingresar para usar el sistema. Los datos quedan guardados."
        confirmLabel="Cerrar sesión"
        danger
        busy={loggingOut}
        onConfirm={logout}
        onCancel={() => setConfirmLogout(false)}
      />
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Aviso cuando los datos en pantalla pueden estar desactualizados. */
export function SyncNotice({ error, stale, updatedAt, onRetry }: { error: string | null; stale: boolean; updatedAt: Date | null; onRetry: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-sm">
      <span>
        {stale
          ? `No se pudo actualizar (${error}). Lo que ves es de las ${updatedAt?.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })} y puede estar desactualizado.`
          : `No se pudieron cargar los datos: ${error}`}
      </span>
      <button onClick={onRetry} className="font-medium text-danger underline">Reintentar</button>
    </div>
  );
}
