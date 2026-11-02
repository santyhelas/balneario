"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
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

const byHref = (h: string) => NAV.find((n) => n.href === h)!;
const TABS = [
  byHref("/"),
  byHref("/mapa"),
  { href: "/reservas/nueva", label: "Reservar", icon: "" },
  byHref("/reservas"),
  { href: "#mas", label: "Más", icon: "M5 12h.01M12 12h.01M19 12h.01" },
];
const MORE = [byHref("/caja"), byHref("/clientes"), byHref("/tarifas")];

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
      <aside className="sticky top-0 hidden h-dvh print:!hidden w-56 shrink-0 flex-col border-r border-line bg-surface p-3 md:flex">
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
        {/* Barra superior en el celular */}
        <header className="pt-safe-2 sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-line bg-surface/95 px-3 pb-2 backdrop-blur print:hidden md:hidden">
          <div className="flex min-w-0 items-center gap-2">
            <img src="/icon.svg" alt="" className="h-7 w-7 shrink-0" />
            <span className="truncate font-semibold">{ws.name}</span>
          </div>
          <button onClick={cycleTheme} className="rounded-lg p-2 hover:bg-surface-2" aria-label={`Tema: ${THEME_LABEL[theme]}`}>
            <Icon d="M12 3v1M12 20v1M4.2 4.2l.7.7M19.1 19.1l.7.7M3 12h1M20 12h1M4.2 19.8l.7-.7M19.1 4.9l.7-.7M12 7a5 5 0 100 10 5 5 0 000-10z" />
          </button>
        </header>
        <InstallBanner />
        <main className="px-safe pb-tabbar mx-auto w-full max-w-7xl flex-1 pt-4 md:pt-6 print:p-0">{children}</main>
      </div>

      {/* Barra inferior en el celular: lo más usado al alcance del pulgar */}
      <nav className="pb-safe-1 fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur print:hidden md:hidden" aria-label="Navegación principal">
        <div className="mx-auto grid max-w-md grid-cols-5 items-end px-1 pt-1">
          {TABS.map((t) => {
            if (t.href === "/reservas/nueva") {
              return (
                <Link key={t.href} href={t.href} onClick={() => setMenuOpen(false)} className="flex flex-col items-center gap-0.5 pb-1 text-[11px] font-medium text-accent" aria-label="Nueva reserva">
                  <span className="-mt-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-accent-fg shadow-lg">
                    <Icon d="M12 5v14M5 12h14" className="h-6 w-6" />
                  </span>
                  Reservar
                </Link>
              );
            }
            if (t.href === "#mas") {
              const active = menuOpen || MORE.some((m) => pathname.startsWith(m.href));
              return (
                <button key={t.href} onClick={() => setMenuOpen((v) => !v)} className={cx("flex flex-col items-center gap-0.5 py-1.5 text-[11px] font-medium", active ? "text-accent" : "text-muted")} aria-expanded={menuOpen}>
                  <Icon d={t.icon} className="h-6 w-6" />
                  {t.label}
                </button>
              );
            }
            const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href) && !pathname.startsWith("/reservas/nueva");
            return (
              <Link key={t.href} href={t.href} onClick={() => setMenuOpen(false)} className={cx("flex flex-col items-center gap-0.5 py-1.5 text-[11px] font-medium", active ? "text-accent" : "text-muted")} aria-current={active ? "page" : undefined}>
                <Icon d={t.icon} className="h-6 w-6" />
                {t.label}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Menú "Más" del celular */}
      {menuOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setMenuOpen(false)}>
          <div className="bottom-tabbar absolute inset-x-0 rounded-t-2xl border-t border-line bg-surface p-3" onClick={(e) => e.stopPropagation()}>
            <nav className="grid grid-cols-3 gap-2">
              {MORE.map((m) => (
                <Link key={m.href} href={m.href} onClick={() => setMenuOpen(false)}
                  className={cx("flex flex-col items-center gap-1 rounded-xl border p-3 text-sm font-medium", pathname.startsWith(m.href) ? "border-accent bg-accent-soft text-accent" : "border-line")}>
                  <Icon d={m.icon} className="h-6 w-6" />
                  {m.label}
                </Link>
              ))}
            </nav>
            <div className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-sm">
              <button onClick={cycleTheme} className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface-2">
                <Icon d="M12 3v1M12 20v1M4.2 4.2l.7.7M19.1 19.1l.7.7M3 12h1M20 12h1M4.2 19.8l.7-.7M19.1 4.9l.7-.7M12 7a5 5 0 100 10 5 5 0 000-10z" />
                Tema: {THEME_LABEL[theme]}
              </button>
              <InstallButton onDone={() => setMenuOpen(false)} />
              <div className="truncate px-3 py-1 text-xs text-muted">{email} · {role}</div>
              <button onClick={() => { setMenuOpen(false); setConfirmLogout(true); }} className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-danger hover:bg-surface-2">
                <Icon d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11" />
                Cerrar sesión
              </button>
            </div>
          </div>
        </div>
      )}

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

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

function useInstall() {
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null);
  const [platform, setPlatform] = useState<"ios" | "android" | "otro">("otro");
  const [installed, setInstalled] = useState(true);

  useEffect(() => {
    const nav = window.navigator as Navigator & { standalone?: boolean };
    const standalone = window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
    setInstalled(standalone);
    const ua = nav.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
    setPlatform(ios ? "ios" : /Android/.test(ua) ? "android" : "otro");
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as InstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (!deferred) return false;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    setDeferred(null);
    if (choice.outcome === "accepted") setInstalled(true);
    return true;
  }

  const canOffer = !installed && (deferred !== null || platform === "ios");
  return { canOffer, platform, hasPrompt: deferred !== null, install };
}

function IosSteps() {
  return (
    <ol className="list-decimal space-y-0.5 pl-5 text-sm">
      <li>Tocá el botón <strong>Compartir</strong> (el cuadrado con la flecha hacia arriba).</li>
      <li>Elegí <strong>«Agregar a inicio»</strong> y confirmá con <strong>Agregar</strong>.</li>
    </ol>
  );
}

/** Aviso (una vez, se puede cerrar) para instalar el sistema como app en el celular. */
function InstallBanner() {
  const { canOffer, platform, hasPrompt, install } = useInstall();
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem("balneario-instalar-oculto") === "1");
    } catch {
      setHidden(false);
    }
  }, []);
  if (!canOffer || hidden) return null;
  function close() {
    setHidden(true);
    try {
      localStorage.setItem("balneario-instalar-oculto", "1");
    } catch {
      /* sin almacenamiento: se vuelve a mostrar la próxima vez */
    }
  }
  return (
    <div className="mx-3 mt-3 rounded-xl border border-accent/30 bg-accent-soft p-3 text-sm md:hidden print:hidden">
      <div className="flex items-start justify-between gap-2">
        <div>
          <strong>Instalá el sistema como app</strong>
          <p className="text-muted">Se abre desde la pantalla de inicio, a pantalla completa.</p>
        </div>
        <button onClick={close} className="rounded p-1 text-muted" aria-label="Cerrar aviso">✕</button>
      </div>
      <div className="mt-2">
        {platform === "ios" && !hasPrompt ? <IosSteps /> : (
          <button onClick={async () => { if (await install()) close(); }} className="rounded-lg bg-accent px-3 py-2 font-medium text-accent-fg">Instalar</button>
        )}
      </div>
    </div>
  );
}

/** Opción "Instalar app" dentro del menú Más. */
function InstallButton({ onDone }: { onDone: () => void }) {
  const { canOffer, platform, hasPrompt, install } = useInstall();
  const [showIos, setShowIos] = useState(false);
  if (!canOffer) return null;
  return (
    <div>
      <button
        onClick={async () => {
          if (platform === "ios" && !hasPrompt) setShowIos((v) => !v);
          else if (await install()) onDone();
        }}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface-2"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
        Instalar como app
      </button>
      {showIos && <div className="px-3 pb-2"><IosSteps /></div>}
    </div>
  );
}
