import type { ReactNode } from "react";
import { SITE_EMAIL, gmailCompose } from "@/lib/site";

/** Página de texto legal (términos, privacidad). */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <a href="/" className="flex items-center gap-2 font-bold"><img src="/logo.png" alt="" className="h-9 w-9" />Mi Balneario</a>
          <a href="/" className="text-sm text-accent hover:underline">Volver al inicio</a>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-3xl font-extrabold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted">Última actualización: {updated}</p>
        <div className="legal mt-8 space-y-4 leading-relaxed [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-bold [&_li]:ml-5 [&_li]:list-disc [&_p]:text-[15px]">
          {children}
        </div>
        <p className="mt-10 border-t border-line pt-4 text-sm text-muted">Consultas: <a className="text-accent hover:underline" href={gmailCompose(SITE_EMAIL)} target="_blank" rel="noopener noreferrer">{SITE_EMAIL}</a></p>
      </main>
    </div>
  );
}
