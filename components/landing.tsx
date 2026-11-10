"use client";
import { useEffect, useState, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { startDemo } from "@/lib/demo";
import { cx } from "@/components/ui";

/** ¿Hay una sesión abierta (no demo)? Para cambiar "Ingresar" por "Ir a mi balneario". */
function useLoggedIn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    getSupabase().auth.getSession().then(({ data }) => {
      const u = data.session?.user as { is_anonymous?: boolean } | undefined;
      setOn(!!u && !u.is_anonymous);
    }).catch(() => undefined);
  }, []);
  return on;
}

// Cuántas personas probaron la demo (una sola consulta aunque haya varios botones).
let demoCount: Promise<number | null> | null = null;
function useDemoCount(): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    demoCount ??= fetch("/api/demo").then((r) => r.json()).then((d: { cantidad?: number | null }) => (typeof d.cantidad === "number" ? d.cantidad : null)).catch(() => null);
    let alive = true;
    demoCount.then((v) => { if (alive) setN(v); });
    return () => { alive = false; };
  }, []);
  return n;
}

export function DemoButton({ className, children = "Probar la demo", countClassName }: { className?: string; children?: ReactNode; countClassName?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = useDemoCount();
  return (
    <span className="inline-flex flex-col">
      <button type="button" disabled={busy}
        onClick={async () => { setBusy(true); setError(null); const e = await startDemo(); if (e) { setBusy(false); setError(e); } }}
        className={cx("inline-flex items-center justify-center py-3 text-base font-bold transition disabled:opacity-60", className ?? "rounded-xl px-5")}>
        {busy ? "Preparando la demo…" : children}
      </button>
      {count != null && count > 0 && (
        <span className={cx("mt-1.5 text-center text-xs opacity-80", countClassName)}>
          Ya la {count === 1 ? "probó 1 persona" : `probaron ${count.toLocaleString("es-AR")} personas`}
        </span>
      )}
      {error && <span role="alert" className="mt-1 max-w-xs text-xs text-danger">{error}</span>}
    </span>
  );
}

export function LoginLink({ className }: { className?: string }) {
  const logged = useLoggedIn();
  return (
    <a href={logged ? "/" : "/login"} className={className}>
      {logged ? "Ir a mi balneario" : "Ingresar"}
    </a>
  );
}

/** Menú de arriba en el celular. */
export function MobileMenu({ links }: { links: { href: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="md:hidden">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="Menú"
        className="flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-surface">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
      </button>
      {open && (
        <nav className="absolute inset-x-0 top-full border-b border-line bg-surface px-4 py-3 shadow-lg">
          <ul className="flex flex-col gap-1">
            {links.map((l) => (
              <li key={l.href}><a href={l.href} onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2 font-medium hover:bg-surface-2">{l.label}</a></li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}

/** Aviso al volver de la demo (?demo=fin). */
export function DemoEndedNotice() {
  const [show, setShow] = useState<null | "demo" | "plan">(null);
  const [account, setAccount] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const kind = p.get("demo") === "fin" ? "demo" : p.get("sin_plan") ? "plan" : null;
    if (kind) {
      setShow(kind);
      const who = p.get("sin_plan");
      if (who && who.includes("@")) setAccount(who);
      setFailed(p.get("motivo") === "error");
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
      if (kind === "plan") document.getElementById("planes")?.scrollIntoView({ behavior: "smooth" });
    }
  }, []);
  if (!show) return null;
  return (
    <div role="status" className={show === "plan" ? "border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-950" : "border-b border-ok/40 bg-ok-soft px-4 py-2 text-center text-sm"}>
      {show === "plan"
        ? failed
          ? <>No pudimos verificar si {account ? <strong>{account}</strong> : "tu cuenta"} tiene un balneario habilitado. Probá de nuevo en un rato o escribinos.</>
          : <>{account ? <>La cuenta <strong>{account}</strong></> : "Esa cuenta"} todavía no tiene un balneario habilitado. Si ya contrataste, fijate de entrar con el mismo correo que nos pasaste. Si no, <a href="#planes" className="font-semibold underline">pedí tu presupuesto</a>.</>
        : <>Saliste de la demo y se borró todo lo que cargaste. ¿Te gustó? <a href="#planes" className="font-semibold text-accent underline">Pedí tu presupuesto</a>.</>}
      <button type="button" onClick={() => setShow(null)} className="ml-3 text-muted hover:text-fg" aria-label="Cerrar aviso">×</button>
    </div>
  );
}


/** «Escribinos por mail»: copia nuestro mail y avisa con un cartel que ya está copiado. */
export function CopyEmailButton({ email, className, children }: { email: string; className?: string; children: ReactNode }) {
  const [shown, setShown] = useState<"ok" | "manual" | null>(null);
  useEffect(() => {
    if (!shown) return;
    const id = window.setTimeout(() => setShown(null), 4000);
    return () => window.clearTimeout(id);
  }, [shown]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(email);
      setShown("ok");
    } catch {
      setShown("manual"); // sin permiso para copiar: se muestra el mail para copiarlo a mano
    }
  }
  return (
    <>
      <button type="button" onClick={copy} className={className}>{children}</button>
      {shown && (
        <div role="status" aria-live="polite"
          className="fixed bottom-6 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 rounded-2xl bg-[#0f2a3d] px-5 py-3 text-center text-sm text-white shadow-2xl">
          {shown === "ok"
            ? <><b>¡Mail copiado!</b> Pegalo en tu correo: <span className="font-semibold underline decoration-dotted">{email}</span></>
            : <>Copiá nuestro mail: <span className="select-all font-semibold">{email}</span></>}
        </div>
      )}
    </>
  );
}

/** Tema de la página de presentación (independiente del tema del sistema). Se guarda en este navegador. */
const TB_KEY = "mb_inicio_tema";
export const TB_THEME_SCRIPT = `try{var t=localStorage.getItem("${TB_KEY}");if(t==="oscuro")document.documentElement.setAttribute("data-tb","oscuro")}catch(e){}`;

export function LandingThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => { setDark(document.documentElement.getAttribute("data-tb") === "oscuro"); }, []);
  function toggle() {
    const next = !dark;
    setDark(next);
    if (next) document.documentElement.setAttribute("data-tb", "oscuro");
    else document.documentElement.removeAttribute("data-tb");
    try { localStorage.setItem(TB_KEY, next ? "oscuro" : "claro"); } catch { /* sin almacenamiento */ }
  }
  return (
    <button type="button" onClick={toggle} aria-pressed={dark}
      aria-label={dark ? "Pasar a modo claro" : "Pasar a modo oscuro"} title={dark ? "Modo claro" : "Modo oscuro"}
      className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--sand-2)] text-[var(--tinta)] hover:bg-[var(--foam)]">
      {dark ? (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4.5" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        </svg>
      )}
    </button>
  );
}

/**
 * Animaciones al bajar: lo que tiene data-reveal aparece suave cuando entra en pantalla.
 * Sin JavaScript, o con «reducir movimiento», todo se ve directo (no se oculta nada).
 */
export function ScrollReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Robots y capturas automáticas (navigator.webdriver) ven la página entera de una.
    if (reduced || navigator.webdriver || !("IntersectionObserver" in window)) return;
    const root = document.documentElement;
    root.classList.add("tb-anim");
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    for (const el of els) {
      // Lo que ya está a la vista al cargar no se esconde.
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.92) el.classList.add("is-in");
      else io.observe(el);
    }
    return () => { io.disconnect(); root.classList.remove("tb-anim"); };
  }, []);
  return null;
}
