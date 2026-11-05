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

export function DemoButton({ className, children = "Probar la demo" }: { className?: string; children?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col">
      <button type="button" disabled={busy}
        onClick={async () => { setBusy(true); setError(null); const e = await startDemo(); if (e) { setBusy(false); setError(e); } }}
        className={cx("inline-flex items-center justify-center rounded-xl px-5 py-3 text-base font-semibold transition disabled:opacity-60", className)}>
        {busy ? "Preparando la demo…" : children}
      </button>
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
