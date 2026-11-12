"use client";
import { HOTKEYS } from "@/lib/hotkeys";
import { SupportModal } from "@/components/support";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { allowLeave, leaveAllowed } from "@/lib/leave";
import { GUEST_MARK, useWorkspace, type ThemePref, type Workspace } from "@/components/workspace";
import { useStatus, type Notice } from "@/components/status";
import { useUndo } from "@/components/undo";
import { ConfirmDialog, cx } from "@/components/ui";
import { DayNotes, usePendingNotes } from "@/components/day-notes";
import { CloseCashModal, OpenCashModal, type CashSummary } from "@/components/cash";
import { DemoTour, TOUR_MENU_EVENT, Tour, startTour, useTourActive } from "@/components/demo-tour";
import { PrintHeader } from "@/components/print-header";

type NavItem = { href: string; label: string; icon: string };

// Las 13 secciones del sistema, en el orden del menú.
export const NAV: NavItem[] = [
  { href: "/", label: "Inicio / Panel", icon: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z" },
  { href: "/mapa", label: "Mapa del balneario", icon: "M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" },
  { href: "/disponibilidad", label: "Disponibilidad", icon: "M8 3v3M16 3v3M4 8h16M5 5h14v15H5zM8 12h2M12 12h2M16 12h0M8 16h2M12 16h2" },
  { href: "/reservas", label: "Reservas", icon: "M6 3h12v18l-6-4-6 4z" },
  { href: "/tarifas", label: "Tarifario", icon: "M20 12l-8 8-9-9V3h8l9 9zM7.5 7.5h.01" },
  { href: "/convenios", label: "Convenios y descuentos", icon: "M8 12l3 3 5-6M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0" },
  { href: "/clientes", label: "Clientes", icon: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 19v-1a4 4 0 0 0-3-3.9M16 3.1a3.5 3.5 0 0 1 0 6.8" },
  { href: "/renovacion", label: "Renovación de temporada", icon: "M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5" },
  { href: "/cobros", label: "Cobros y señas", icon: "M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3S9.5 10.5 12 11s4.5 1.3 4.5 3-2 3-4.5 3-4.5-1.3-4.5-3" },
  { href: "/caja", label: "Caja diaria", icon: "M3 7h18v12H3zM3 11h18M7 15h3" },
  { href: "/gastos", label: "Gastos", icon: "M3 7l6 6 4-4 8 8M15 17h6v-6" },
  { href: "/reportes", label: "Reportes", icon: "M4 20V10M10 20V4M16 20v-7M22 20H2" },
  { href: "/historial", label: "Historial", icon: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2" },
  { href: "/copias", label: "Copias de seguridad", icon: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" },
  { href: "/configuracion", label: "Configuración", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" },
];

/** Íconos de los apartados de Configuración (en la página y en el menú). */
export const CONFIG_ICONS = {
  perfil: "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
  balneario: "M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6",
  mensajes: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z",
  reglas: "M3 7h18v12H3zM3 11h18M7 15h3",
  cuentas: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  usuarios: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 19v-1a4 4 0 0 0-3-3.9M16 3.1a3.5 3.5 0 0 1 0 6.8",
  plan: "M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 2 2.5 4.5 3 4.5 1.3 4.5 3-2 3-4.5 3-4.5-1.3-4.5-3",
} as const;
/** Apartados de Configuración, en el orden de la página. */
export const CONFIG_SECTIONS: { id: keyof typeof CONFIG_ICONS; label: string; owners?: boolean }[] = [
  { id: "perfil", label: "Mi perfil" },
  { id: "balneario", label: "Datos del balneario" },
  { id: "mensajes", label: "Mensajes a clientes" },
  { id: "reglas", label: "Caja, descuentos y reservas" },
  { id: "cuentas", label: "Cuentas vinculadas", owners: true },
  { id: "usuarios", label: "Usuarios", owners: true },
  { id: "plan", label: "Mi plan", owners: true },
];

const byHref = (h: string) => NAV.find((n) => n.href === h)!;
const TABS = ["/", "/mapa", "+", "/reservas", "#mas"];
const MORE = NAV.filter((n) => !["/", "/mapa", "/reservas"].includes(n.href));

const ICON_SUN = "M12 3v1M12 20v1M4.2 4.2l.7.7M19.1 19.1l.7.7M3 12h1M20 12h1M4.2 19.8l.7-.7M19.1 4.9l.7-.7M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z";
const ICON_MOON = "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z";
const ICON_AUTO = "M12 3a9 9 0 1 0 0 18V3zM12 3a9 9 0 0 1 0 18";
const ICON_BELL = "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0";
const ICON_LOGOUT = "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11";

export const ICON_HELP = "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01";

export function Icon({ d, className }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={cx("h-5 w-5 shrink-0", className)} aria-hidden>
      <path d={d} />
    </svg>
  );
}

const THEME_LABEL: Record<ThemePref, string> = { claro: "Claro", oscuro: "Oscuro", sistema: "Automático" };
const THEME_ICON: Record<ThemePref, string> = { claro: ICON_SUN, oscuro: ICON_MOON, sistema: ICON_AUTO };

/** Logo del balneario (el que se cargó en Configuración, o el ícono por defecto). */
export function BrandLogo({ ws, className }: { ws: Workspace; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={ws.logo_data || "/logo.png"} alt="" className={cx("shrink-0 rounded-xl object-cover", className)} />;
}

function Avatar({ src, name, className }: { src: string | null; name: string; className?: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className={cx("shrink-0 rounded-full object-cover", className)} />;
  }
  const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");
  return <span className={cx("flex shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent", className)}>{initials || "?"}</span>;
}

function longDate(iso: string, timeZone: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const s = new Intl.DateTimeFormat("es-AR", { weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
  void timeZone;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function Shell({ children }: { children: ReactNode }) {
  const [supportOpen, setSupportOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const { ws, email, theme, setTheme, role, profile, isGuest, guideDone, setGuideDone, isPlatformAdmin, adminAlerts } = useWorkspace();
  const status = useStatus();
  const pathname = usePathname();
  const router = useRouter();
  const [confirmLogout, setConfirmLogout] = useState(false);
  // Menú lateral: cerrado por defecto (pantalla limpia); se abre con el botón de tres rayas.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => setDrawerOpen(false), [pathname]);
  // Atajos de teclado (F2 nueva reserva, F4 mapa…): en cualquier pantalla, salvo con una ventana abierta.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const hk = HOTKEYS.find((h) => h.key === e.key);
      if (!hk || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      router.push(hk.href);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
  // El tutorial abre el menú para señalar dónde está cada sección.
  useEffect(() => {
    const on = (e: Event) => setDrawerOpen(!!(e as CustomEvent<boolean>).detail);
    window.addEventListener(TOUR_MENU_EVENT, on);
    return () => window.removeEventListener(TOUR_MENU_EVENT, on);
  }, []);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);
  const menuButton = (
    <button onClick={() => setDrawerOpen(true)} className="rounded-lg p-2 hover:bg-surface-2" aria-label="Abrir menú" title="Menú" aria-expanded={drawerOpen}>
      <Icon d="M4 6h16M4 12h16M4 18h16" />
    </button>
  );
  const [loggingOut, setLoggingOut] = useState(false);
  const [closeForLogout, setCloseForLogout] = useState(false);
  const cashOpen = status.summary?.caja.estado === "abierta";
  const [menuOpen, setMenuOpen] = useState(false);
  const undo = useUndo(() => status.reload());

  useEffect(() => setMenuOpen(false), [pathname]);

  async function logout() {
    setLoggingOut(true);
    if (isGuest) {
      // Invitado: se borra todo lo que cargó en la demostración.
      await getSupabase().rpc("end_guest_session").then(() => undefined, () => undefined);
      try { sessionStorage.removeItem(GUEST_MARK); } catch { /* nada */ }
    }
    await getSupabase().auth.signOut();
    try {
      localStorage.removeItem("balneario-tema");
    } catch {
      /* nada */
    }
    allowLeave();
    window.location.assign(isGuest ? "/?demo=fin" : "/");
  }

  function cycleTheme() {
    const next: ThemePref = theme === "claro" ? "oscuro" : theme === "oscuro" ? "sistema" : "claro";
    setTheme(next).catch(() => {
      /* el tema ya se aplicó en pantalla; si falla guardarlo, se reintenta la próxima vez */
    });
  }

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/")) && !(href === "/reservas" && pathname.startsWith("/reservas/nueva"));
  const alerts = status.unseen;
  const carpa = status.summary?.espacios.carpa;
  const sombrilla = status.summary?.espacios.sombrilla;
  const userName = profile.displayName || email || "";

  return (
    <div className="flex min-h-dvh">
      {/* ---------------- Menú lateral (se abre con las tres rayas) ---------------- */}
      {drawerOpen && <div className="fixed inset-0 z-50 bg-black/40 print:hidden" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}
      <aside
        className={cx(
          "pt-safe-2 fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-line bg-surface shadow-2xl transition-transform duration-200 print:!hidden",
          drawerOpen ? "translate-x-0" : "-translate-x-full invisible",
        )}
        aria-label="Menú"
        aria-hidden={!drawerOpen}
      >
        <div className="flex items-start">
        <Link href="/configuracion" className="flex min-w-0 flex-1 items-center gap-3 px-4 pb-3 pt-4 hover:opacity-90" title="Cambiar nombre y foto en Configuración">
          <BrandLogo ws={ws} className="h-12 w-12" />
          <div className="min-w-0">
            <div className="truncate font-bold uppercase tracking-wide">{ws.name}</div>
            <div className="truncate text-xs font-medium text-accent">{ws.subtitle || "Gestión del balneario"}</div>
          </div>
        </Link>
        <button onClick={() => setDrawerOpen(false)} className="m-2 rounded-lg p-2 text-muted hover:bg-surface-2" aria-label="Cerrar menú" title="Cerrar">
          <Icon d="M6 6l12 12M18 6L6 18" />
        </button>
        </div>
        <div className="mx-4 mb-2 flex items-center justify-between border-y border-line py-2 text-xs">
          <span className="text-muted">{carpa?.total_activos ?? "–"} Carpas · {sombrilla?.total_activos ?? "–"} Sombrillas</span>
        </div>
        {carpa && sombrilla && (
          <div className="mx-4 mb-2 -mt-1 flex items-center justify-between pb-2 text-xs" title="Situación de hoy (carpas y sombrillas juntas)">
            <span className="text-muted">Hoy</span>
            <span className="flex gap-3 font-mono font-semibold">
              <span className="text-danger">{carpa.ocupados + sombrilla.ocupados} ocupadas</span>
              <span className="text-ok">{carpa.disponibles + sombrilla.disponibles} libres</span>
            </span>
          </div>
        )}
        <nav className="flex-1 overflow-y-auto px-2 pb-2" aria-label="Secciones">
          {NAV.map((item, i) => {
            const active = isActive(item.href);
            if (item.href === "/configuracion") {
              return (
                <div key={item.href}>
                  <button type="button" onClick={() => setConfigOpen((v) => !v)} aria-expanded={configOpen}
                    className={cx("mb-0.5 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium",
                      active ? "bg-accent text-accent-fg" : "text-fg hover:bg-surface-2")}>
                    <Icon d={item.icon} className="h-[18px] w-[18px]" />
                    <span className="flex-1 truncate">{i + 1}. {item.label}</span>
                    <Icon d="M6 9l6 6 6-6" className={cx("h-4 w-4 transition-transform duration-200", configOpen && "rotate-180")} />
                  </button>
                  <div className={cx("grid transition-[grid-template-rows] duration-200 ease-out", configOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
                    <div className="overflow-hidden">
                      <div className="mb-1 ml-5 border-l border-line pl-2">
                        {CONFIG_SECTIONS.filter((c) => !c.owners || !isGuest).map((c) => (
                          <Link key={c.id} href={`/configuracion#${c.id}`} onClick={() => setDrawerOpen(false)} tabIndex={configOpen ? 0 : -1}
                            className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-fg/90 hover:bg-surface-2">
                            <Icon d={CONFIG_ICONS[c.id]} className="h-4 w-4 text-muted" />
                            {c.label}
                          </Link>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }
            return (
              <Link
                key={item.href}
                href={item.href}
                data-tour={`nav-${item.href}`}
                className={cx(
                  "mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium",
                  active ? "bg-accent text-accent-fg" : "text-fg hover:bg-surface-2",
                )}
                aria-current={active ? "page" : undefined}
              >
                <Icon d={item.icon} className="h-[18px] w-[18px]" />
                <span className="flex-1 truncate">{i + 1}. {item.label}</span>
                {item.href === "/" && alerts > 0 && (
                  <span className="rounded-full bg-warn px-1.5 text-xs font-bold text-bg">{alerts}</span>
                )}
              </Link>
            );
          })}
          {isPlatformAdmin && (
            <Link href="/admin" aria-current={isActive("/admin") ? "page" : undefined}
              className={cx("mt-2 flex items-center gap-3 rounded-lg border border-dashed border-line px-3 py-2 text-sm font-medium",
                isActive("/admin") ? "bg-accent text-accent-fg" : "text-fg hover:bg-surface-2")}>
              <Icon d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" className="h-[18px] w-[18px]" />
              <span className="flex-1 truncate">Panel del dueño</span>
              {adminAlerts > 0 && <span className="rounded-full bg-danger px-1.5 text-xs font-bold text-white">{adminAlerts}</span>}
            </Link>
          )}
        </nav>
        <div className="flex items-center gap-2 border-t border-line px-3 py-2">
          <Link href="/configuracion" className="flex min-w-0 flex-1 items-center gap-2 rounded-lg p-1 hover:bg-surface-2" title={email ?? ""}>
            <Avatar src={profile.avatar} name={userName} className="h-8 w-8" />
            <div className="min-w-0 text-xs">
              <div className="truncate font-semibold">{userName}</div>
              <div className="truncate text-muted">{role}</div>
            </div>
          </Link>
          <button onClick={cycleTheme} className="rounded-lg border border-line p-2 hover:bg-surface-2" title={`Tema: ${THEME_LABEL[theme]}`} aria-label={`Tema: ${THEME_LABEL[theme]}`}>
            <Icon d={THEME_ICON[theme]} className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col gap-1.5 px-3 pb-3">
          <button onClick={() => { setDrawerOpen(false); setSupportOpen(true); }} className="flex w-full items-center justify-center gap-2 rounded-lg border border-line py-2 text-sm font-medium hover:bg-surface-2">
            <Icon d={ICON_HELP} className="h-4 w-4 text-accent" />
            Consultas
          </button>
          <button onClick={() => setConfirmLogout(true)} className="flex w-full items-center justify-center gap-2 rounded-lg bg-surface-2 py-2 text-sm font-medium hover:opacity-80">
            <Icon d={ICON_LOGOUT} className="h-4 w-4 text-danger" />
            Cerrar sesión
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ---------------- Barra superior (computadora) ---------------- */}
        <header className="sticky top-0 z-30 hidden items-center gap-2 border-b border-line bg-surface/95 px-4 py-2 backdrop-blur print:hidden md:flex">
          {menuButton}
          <div className="min-w-[8rem] flex-1">
            <div className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted">{ws.name}</div>
            <div className="truncate text-sm font-bold">{status.summary ? longDate(status.summary.fecha, ws.timezone) : "…"}</div>
          </div>
          <div data-tour="caja-chip"><CashChip /></div>
          <div data-tour="notas"><NotesButton /></div>
          <Link data-tour="nueva-reserva" href="/reservas/nueva" className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-fg hover:opacity-90" title="Nueva reserva">
            <Icon d="M12 5v14M5 12h14" className="h-4 w-4" /><span className="hidden xl:inline">Nueva reserva</span>
          </Link>
          <Link data-tour="nuevo-gasto" href="/gastos?nuevo=1" className="flex items-center gap-1.5 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-sm font-semibold text-danger hover:opacity-90" title="Nuevo gasto">
            <Icon d="M5 12h14" className="h-4 w-4" /><span className="hidden xl:inline">Nuevo gasto</span>
          </Link>
          <button data-tour="deshacer" onClick={undo.start} className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg" title="Deshacer último cambio" aria-label="Deshacer último cambio">
            <Icon d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" className="h-[18px] w-[18px]" />
          </button>
          <button onClick={cycleTheme} className="rounded-lg p-2 hover:bg-surface-2" title={`Tema: ${THEME_LABEL[theme]}`} aria-label={`Tema: ${THEME_LABEL[theme]}`}>
            <Icon d={THEME_ICON[theme]} />
          </button>
          <NoticesBell notices={status.notices} count={alerts} />
          <div className="flex items-center gap-1 rounded-lg p-1 pr-2 hover:bg-surface-2">
            <Link href="/configuracion" className="flex items-center gap-2" title={email ?? ""}>
              <Avatar src={profile.avatar} name={userName} className="h-8 w-8" />
              <span className="hidden max-w-32 truncate text-sm font-semibold lg:inline">{userName}</span>
            </Link>
            <SyncDot />
          </div>
          <button onClick={() => setConfirmLogout(true)} className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-danger" title="Cerrar sesión" aria-label="Cerrar sesión">
            <Icon d={ICON_LOGOUT} />
          </button>
        </header>

        {/* ---------------- Barra superior (celular) ---------------- */}
        <header className="pt-safe-2 sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-line bg-surface/95 px-3 pb-2 backdrop-blur print:hidden md:hidden">
          {menuButton}
          <Link href="/" className="flex min-w-0 flex-1 items-center gap-2">
            <BrandLogo ws={ws} className="h-8 w-8 rounded-lg" />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-bold uppercase">{ws.name}</div>
              <div className="truncate text-[11px] text-muted">{status.summary ? longDate(status.summary.fecha, ws.timezone) : ""}</div>
            </div>
          </Link>
          <div className="flex items-center">
            <button onClick={cycleTheme} className="rounded-lg p-2" aria-label={`Tema: ${THEME_LABEL[theme]}`}><Icon d={THEME_ICON[theme]} /></button>
            <div data-tour="notas"><NotesButton compact /></div>
            <NoticesBell notices={status.notices} count={alerts} />
          </div>
        </header>

        {isGuest && (
          <div data-tour="demo" className="px-safe flex flex-wrap items-center justify-between gap-2 border-b border-amber-300 bg-amber-100 py-2 text-sm text-amber-950 print:hidden dark:border-amber-700/60 dark:bg-amber-900/40 dark:text-amber-100">
            <span><strong>Demo:</strong> es un balneario de prueba con datos inventados. Podés probar todo, pero <strong>nada se guarda</strong>: al salir o cerrar la pestaña se borra.</span>
            <span className="flex gap-2">
              <button onClick={() => startTour("demo")} className="rounded-lg border border-amber-400 bg-white/60 px-3 py-1 font-semibold hover:bg-white dark:bg-transparent">Ver tutorial</button>
              <button onClick={() => startTour("novedades")} className="rounded-lg border border-amber-400 bg-white/60 px-3 py-1 font-semibold hover:bg-white dark:bg-transparent">Novedades</button>
              <button onClick={() => setConfirmLogout(true)} className="rounded-lg border border-amber-400 bg-white/60 px-3 py-1 font-semibold hover:bg-white dark:bg-transparent">Salir de la demo</button>
            </span>
          </div>
        )}
        {ws.paused_at && (
          <div role="alert" className="px-safe border-b border-danger/40 bg-danger/10 py-2 text-sm print:hidden">
            <strong>Balneario en pausa:</strong> podés ver y descargar todo, pero no cargar cambios
            {ws.paused_reason ? ` (${ws.paused_reason})` : ""}. Escribinos para reactivarlo.
          </div>
        )}
        <PlanBanner />
        <InstallBanner />
        {undo.message && <div className="px-safe pt-3">{undo.message}</div>}
        <main className="px-safe pb-tabbar w-full flex-1 pt-4 md:pt-6 print:p-0"><PrintHeader /><div key={pathname} className="mb-page">{children}</div></main>
        <DemoTour enabled={isGuest} />
        <Tour id="guia" enabled={!isGuest && role === "propietario"} unseen={!guideDone} finalLabel="Empezar"
          onFinish={() => { if (!guideDone) setGuideDone(true).catch(() => undefined); }} />
        {/* Novedades: solo en la demo, y solo si se la pide con el botón. */}
        <Tour id="novedades" enabled={isGuest} unseen={false} />
      </div>

      {/* ---------------- Barra inferior (celular) ---------------- */}
      <nav className="pb-safe-1 fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur print:hidden md:hidden" aria-label="Navegación principal">
        <div className="mx-auto grid max-w-md grid-cols-5 items-end px-1 pt-1">
          {TABS.map((t) => {
            if (t === "+") {
              return (
                <Link key={t} data-tour="nueva-reserva" href="/reservas/nueva" className="flex flex-col items-center gap-0.5 pb-1 text-[11px] font-medium text-accent" aria-label="Nueva reserva">
                  <span className="-mt-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-accent-fg shadow-lg">
                    <Icon d="M12 5v14M5 12h14" className="h-6 w-6" />
                  </span>
                  Reservar
                </Link>
              );
            }
            if (t === "#mas") {
              const active = menuOpen || MORE.some((m) => isActive(m.href));
              return (
                <button key={t} onClick={() => setMenuOpen((v) => !v)} className={cx("flex flex-col items-center gap-0.5 py-1.5 text-[11px] font-medium", active ? "text-accent" : "text-muted")} aria-expanded={menuOpen}>
                  <Icon d="M5 12h.01M12 12h.01M19 12h.01" className="h-6 w-6" />
                  Más
                </button>
              );
            }
            const item = byHref(t);
            const active = isActive(t);
            const short = t === "/" ? "Panel" : t === "/mapa" ? "Mapa" : "Reservas";
            return (
              <Link key={t} href={t} className={cx("relative flex flex-col items-center gap-0.5 py-1.5 text-[11px] font-medium", active ? "text-accent" : "text-muted")} aria-current={active ? "page" : undefined}>
                <Icon d={item.icon} className="h-6 w-6" />
                {short}
                {t === "/" && alerts > 0 && <span className="absolute right-3 top-0.5 rounded-full bg-warn px-1 text-[10px] font-bold text-bg">{alerts}</span>}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Menú "Más" del celular: el resto de las secciones */}
      {menuOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setMenuOpen(false)}>
          <div className="bottom-tabbar absolute inset-x-0 max-h-[75dvh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface p-3" onClick={(e) => e.stopPropagation()}>
            <Link href="/configuracion" className="mb-3 flex items-center gap-3 rounded-xl bg-surface-2 p-3">
              <BrandLogo ws={ws} className="h-10 w-10" />
              <div className="min-w-0">
                <div className="truncate font-bold uppercase">{ws.name}</div>
                <div className="truncate text-xs text-muted">{carpa?.total_activos ?? "–"} carpas · {sombrilla?.total_activos ?? "–"} sombrillas activas</div>
              </div>
            </Link>
            <nav className="grid grid-cols-3 gap-2">
              {MORE.map((m) => (
                <Link key={m.href} href={m.href}
                  className={cx("flex flex-col items-center gap-1 rounded-xl border p-2.5 text-center text-xs font-medium", isActive(m.href) ? "border-accent bg-accent-soft text-accent" : "border-line")}>
                  <Icon d={m.icon} className="h-6 w-6" />
                  {m.label}
                </Link>
              ))}
              {isPlatformAdmin && (
                <Link href="/admin"
                  className={cx("relative flex flex-col items-center gap-1 rounded-xl border border-dashed p-2.5 text-center text-xs font-medium", isActive("/admin") ? "border-accent bg-accent-soft text-accent" : "border-line")}>
                  <Icon d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" className="h-6 w-6" />
                  Panel del dueño
                  {adminAlerts > 0 && <span className="absolute right-1.5 top-1.5 rounded-full bg-danger px-1.5 text-[10px] font-bold text-white">{adminAlerts}</span>}
                </Link>
              )}
            </nav>
            <div className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-sm">
              <button onClick={() => { setMenuOpen(false); undo.start(); }} className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface-2">
                <Icon d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" /> Deshacer último cambio
              </button>
              <button onClick={() => { setMenuOpen(false); setSupportOpen(true); }} className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface-2">
                <Icon d={ICON_HELP} /> Consultas
              </button>
              <InstallButton onDone={() => setMenuOpen(false)} />
              <Link href="/configuracion" className="flex items-center gap-3 rounded-lg px-3 py-2">
                <Avatar src={profile.avatar} name={userName} className="h-7 w-7" />
                <span className="min-w-0 truncate text-xs text-muted">{userName} · {role}</span>
              </Link>
              <button onClick={() => { setMenuOpen(false); setConfirmLogout(true); }} className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-danger hover:bg-surface-2">
                <Icon d={ICON_LOGOUT} /> Cerrar sesión
              </button>
            </div>
          </div>
        </div>
      )}

      {undo.dialog}
      <SupportModal open={supportOpen} onClose={() => setSupportOpen(false)} />
      <CashGuard closeRequest={closeForLogout} onClosedForLogout={() => { setCloseForLogout(false); logout(); }} onCancelClose={() => setCloseForLogout(false)} />
      <ConfirmDialog
        open={confirmLogout}
        title={isGuest ? "¿Salir de la demo?" : "¿Cerrar sesión?"}
        message={isGuest ? "Se borra todo lo que cargaste en la demostración." : cashOpen ? (
          <div className="flex flex-col gap-3">
            <p>La <strong>caja de hoy sigue abierta</strong>. ¿Querés cerrarla antes de salir?</p>
            <p className="text-xs text-muted">Cerrala solo si terminó el día. Si vas a seguir trabajando más tarde, salí sin cerrarla (si la cerrás por error, un administrador la puede reabrir desde Caja).</p>
            <button type="button" onClick={() => { setConfirmLogout(false); setCloseForLogout(true); }}
              className="rounded-lg border border-accent bg-accent-soft px-3 py-2 text-sm font-semibold text-accent hover:opacity-90">Cerrar la caja y salir</button>
          </div>
        ) : "Vas a tener que volver a ingresar para usar el sistema. Los datos quedan guardados."}
        confirmLabel={isGuest ? "Salir y borrar" : cashOpen ? "Salir sin cerrar la caja" : "Cerrar sesión"}
        danger
        busy={loggingOut}
        onConfirm={logout}
        onCancel={() => setConfirmLogout(false)}
      />
    </div>
  );
}

/**
 * Caja del día:
 * - al empezar un día nuevo ofrece abrirla (y, si quedó abierta la de otro día, primero cerrarla);
 * - al cerrar la pestaña con la caja abierta, el navegador pregunta antes de salir;
 * - al cerrar sesión, si se elige "Cerrar la caja y salir", muestra el cierre.
 */
function CashGuard({ closeRequest, onClosedForLogout, onCancelClose }: { closeRequest: boolean; onClosedForLogout: () => void; onCancelClose: () => void }) {
  const { ws, isGuest, role, guideDone } = useWorkspace();
  const st = useStatus();
  const sb = getSupabase();
  const [openNew, setOpenNew] = useState(false);
  // Con la guía de bienvenida en curso no se pide la caja: se pide al terminarla.
  const touring = useTourActive(!isGuest && role === "propietario", "guia", !guideDone);
  const [closing, setClosing] = useState<{ summary: CashSummary; forLogout: boolean } | null>(null);
  const s = st.summary;

  const asked = (k: string) => { try { return sessionStorage.getItem(`caja-preg:${k}`) === "1"; } catch { return false; } };
  const mark = (k: string) => { try { sessionStorage.setItem(`caja-preg:${k}`, "1"); } catch { /* nada */ } };

  // Inicio del día: primero cerrar la caja que quedó abierta; después abrir la de hoy.
  useEffect(() => {
    if (!s || isGuest || touring) return;
    if (s.caja_anterior_sin_cerrar) {
      const k = `cerrar:${s.caja_anterior_sin_cerrar.session_id}`;
      if (asked(k)) return;
      mark(k);
      sb.rpc("cash_session_summary", { p_session_id: s.caja_anterior_sin_cerrar.session_id }).then(({ data, error }) => {
        if (!error && data) setClosing({ summary: data as CashSummary, forLogout: false });
      });
    } else if (s.caja.estado === "sin_abrir") {
      const k = `abrir:${s.fecha}`;
      if (asked(k)) return;
      mark(k);
      setOpenNew(true);
    }
  }, [s?.fecha, s?.caja.estado, s?.caja_anterior_sin_cerrar?.session_id, isGuest, touring]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cerrar la pestaña con la caja abierta: el navegador pregunta si salir.
  useEffect(() => {
    if (s?.caja.estado !== "abierta" || isGuest) return;
    const h = (e: BeforeUnloadEvent) => { if (leaveAllowed()) return; e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [s?.caja.estado, isGuest]);

  // Cerrar la caja antes de cerrar sesión.
  useEffect(() => {
    if (!closeRequest || !s?.caja.session_id) return;
    sb.rpc("cash_session_summary", { p_session_id: s.caja.session_id }).then(({ data, error }) => {
      if (!error && data) setClosing({ summary: data as CashSummary, forLogout: true });
      else onCancelClose();
    });
  }, [closeRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <OpenCashModal open={openNew} workspaceId={ws.id} onClose={() => setOpenNew(false)} onDone={() => { setOpenNew(false); st.reload(); }} />
      <CloseCashModal
        open={closing !== null}
        summary={closing?.summary ?? null}
        onClose={() => { const f = closing?.forLogout; setClosing(null); if (f) onCancelClose(); }}
        onDone={() => { const f = closing?.forLogout; setClosing(null); st.reload(); if (f) onClosedForLogout(); }}
      />
    </>
  );
}

/**
 * Estado de la conexión con la base, como un punto al lado del usuario: verde si está conectado.
 * Si falla, se muestra el texto en rojo (no se muestran datos viejos como actuales). Tocándolo se actualiza.
 */
function SyncDot() {
  const s = useStatus();
  const ok = s.online && !s.error;
  const time = s.updatedAt?.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  const label = !s.online ? "Sin internet" : "Sin conexión";
  return (
    <button onClick={s.reload}
      title={ok
        ? `Conectado. Todo lo que guardás queda online y se ve en las otras computadoras y celulares. Actualizado a las ${time ?? "—"}. Tocá para actualizar ahora.`
        : `${s.error ?? "No hay internet"}. Lo que ves puede estar desactualizado y no se puede guardar nada nuevo. Tocá para reintentar.`}
      aria-label={ok ? `Conectado, actualizado a las ${time ?? "—"}` : label}
      className={cx("flex items-center gap-1.5 rounded-full p-1 text-xs font-semibold", !ok && "border border-danger/40 bg-danger-soft px-2 text-danger")}>
      <span className={cx("h-2.5 w-2.5 rounded-full ring-2 ring-surface", ok ? "bg-ok" : "bg-danger", s.loading && "animate-pulse")} />
      {!ok && <span>{label}</span>}
    </button>
  );
}

/** Botón amarillo de "Notas del día": abre las notas del personal en un panel. */
function NotesButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const pending = usePendingNotes();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`Notas del día (${pending} pendientes)`} title="Notas del día"
        className={cx("relative flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-100 text-sm font-semibold text-amber-900 hover:bg-amber-200 dark:border-amber-700/60 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900/60",
          compact ? "p-2" : "px-3 py-2")}>
        <Icon d="M5 3h14v18H5zM9 7h6M9 11h6M9 15h4" className="h-4 w-4" />
        {!compact && <span>Notas</span>}
        {pending > 0 && <span className={cx("rounded-full bg-amber-500 px-1.5 text-[10px] font-bold leading-4 text-white", compact && "absolute -right-1 -top-1")}>{pending}</span>}
      </button>
      {open && (
        <div className="mb-drop fixed inset-x-3 top-16 z-50 max-h-[75dvh] overflow-y-auto rounded-2xl shadow-xl md:absolute md:inset-x-auto md:left-0 md:top-12 md:w-[26rem]">
          <DayNotes />
        </div>
      )}
    </div>
  );
}

function CashChip() {
  const s = useStatus();
  const c = s.summary?.caja.estado;
  const prev = s.summary?.caja_anterior_sin_cerrar;
  const [text, tone] = prev ? ["Caja anterior sin cerrar", "danger"] as const
    : c === "abierta" ? ["Caja abierta", "ok"] as const
    : c === "cerrada" ? ["Caja cerrada (hoy)", "muted"] as const
    : ["Caja cerrada (abrir turno)", "warn"] as const;
  const cls = { ok: "border-ok/40 bg-ok-soft text-ok", warn: "border-warn/40 bg-warn-soft text-warn", danger: "border-danger/40 bg-danger-soft text-danger", muted: "border-line bg-surface-2 text-muted" }[tone];
  if (!s.summary) return null;
  return (
    <Link href="/caja" className={cx("hidden items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold lg:flex", cls)}>
      <Icon d={byHref("/caja").icon} className="h-4 w-4" />
      {text}
    </Link>
  );
}

const NOTICE_TONE: Record<Notice["tone"], string> = {
  danger: "border-danger/40 bg-danger-soft",
  warn: "border-warn/40 bg-warn-soft",
  info: "border-accent/30 bg-accent-soft",
};
const DOT: Record<Notice["tone"], string> = { danger: "bg-danger", warn: "bg-warn", info: "bg-accent" };

/**
 * Campanita con los avisos operativos (cajas, deudas, ingresos del día).
 * Al abrirla se apaga el número (quedan vistos); cada aviso se puede eliminar de la lista.
 * Eliminar un aviso no cambia deudas ni pagos: solo deja de mostrarse hasta mañana.
 */
function NoticesBell({ notices, count }: { notices: Notice[]; count: number }) {
  const { markRead, markSeen } = useStatus();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  // Mientras está abierta, lo que llega también queda visto.
  useEffect(() => { if (open) markSeen(); }, [open, notices, markSeen]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="relative" ref={ref} data-tour="avisos">
      <button onClick={() => setOpen((v) => !v)} className="relative rounded-lg p-2 hover:bg-surface-2" aria-label={count ? `Avisos (${count} nuevos)` : "Avisos"} aria-expanded={open}>
        <Icon d={ICON_BELL} />
        {count > 0 && <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-bold leading-4 text-bg">{count}</span>}
      </button>
      {open && (
        <div className="mb-drop fixed inset-x-3 top-16 z-50 max-h-[70dvh] overflow-y-auto rounded-xl border border-line bg-surface p-3 shadow-xl md:absolute md:inset-x-auto md:right-0 md:top-12 md:w-96">
          <div className="mb-2 flex items-center justify-between gap-2">
            <strong className="text-sm">Avisos <span className="font-normal text-muted">({notices.length})</span></strong>
            {notices.length > 0 && (
              <button onClick={() => markRead(notices.map((n) => n.id))} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-danger hover:bg-danger-soft">
                <Icon d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" className="h-3.5 w-3.5" />Eliminar todos
              </button>
            )}
          </div>
          {notices.length === 0 ? <p className="py-4 text-center text-sm text-muted">Sin avisos. Las deudas siguen en Cobros.</p> : (
            <ul className="flex flex-col gap-2">
              {notices.map((n) => (
                <li key={n.id} className={cx("flex items-start gap-1 rounded-lg border text-sm", NOTICE_TONE[n.tone])}>
                  <Link href={n.href} className="min-w-0 flex-1 p-2.5 hover:opacity-90">
                    <div className="flex items-center gap-2 font-semibold"><span className={cx("h-2 w-2 shrink-0 rounded-full", DOT[n.tone])} />{n.title}</div>
                    <div className="pl-4 text-xs text-muted">{n.detail}</div>
                  </Link>
                  <button onClick={() => markRead([n.id])} className="m-1.5 shrink-0 rounded-md p-1 text-muted hover:bg-surface hover:text-danger" title="Eliminar aviso" aria-label={`Eliminar aviso: ${n.title}`}>
                    <Icon d="M6 6l12 12M18 6L6 18" className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {notices.length > 0 && <p className="mt-2 text-[11px] text-muted">Eliminar un aviso no borra la deuda ni el pago: si sigue pendiente, vuelve a aparecer mañana.</p>}
        </div>
      )}
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

/** Avisos del plan de Mi Balneario: vencido (solo lectura), débito rechazado o por vencer. */
function PlanBanner() {
  const { plan, role } = useWorkspace();
  if (!plan || plan.estado === "exenta") return null;
  const fmt = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—");
  const lastDay = plan.bloquea_desde ? new Date(new Date(plan.bloquea_desde + "T12:00:00Z").getTime() - 86_400_000).toISOString().slice(0, 10) : null;
  const daysLeft = lastDay ? Math.round((new Date(lastDay + "T12:00:00Z").getTime() - new Date(plan.hoy + "T12:00:00Z").getTime()) / 86_400_000) : null;
  const action = role === "propietario"
    ? <Link href="/configuracion#plan" className="ml-2 font-semibold underline">Ver mi plan</Link>
    : <span className="ml-1">Avisale al propietario del balneario.</span>;
  let tone: "danger" | "warn" | null = null;
  let text = "";
  if (plan.vencido) {
    tone = "danger";
    text = `Tu plan de Mi Balneario venció el ${fmt(plan.pago_hasta)}: podés ver y descargar todo, pero no cargar cambios.`;
  } else if (plan.ultimo_estado === "rechazado" && !plan.debito_automatico) {
    tone = "warn";
    text = `Mercado Pago no pudo cobrar tu plan. Si no se regulariza, desde el ${fmt(plan.bloquea_desde)} el sistema queda en solo lectura.`;
  } else if (plan.ultimo_estado === "rechazado" && daysLeft !== null && daysLeft <= plan.dias_gracia) {
    tone = "warn";
    text = `Mercado Pago no pudo cobrar tu plan (lo va a reintentar). Revisá tu tarjeta: desde el ${fmt(plan.bloquea_desde)} el sistema queda en solo lectura.`;
  } else if (!plan.debito_automatico && daysLeft !== null && daysLeft <= 7) {
    tone = "warn";
    text = plan.estado === "pendiente"
      ? `Activá tu plan antes del ${fmt(plan.bloquea_desde)} para seguir cargando reservas.`
      : `Tu plan vence el ${fmt(plan.pago_hasta)}. Desde el ${fmt(plan.bloquea_desde)} el sistema queda en solo lectura si no lo renovás.`;
  }
  if (!tone) return null;
  return (
    <div role="alert" className={cx("px-safe border-b py-2 text-sm print:hidden", tone === "danger" ? "border-danger/40 bg-danger/10" : "border-warn/40 bg-warn-soft")}>
      {text}{action}
    </div>
  );
}
