import type { ReactNode } from "react";
import { SITE_WHATSAPP_URL } from "@/lib/site";

/** Marco de las páginas públicas de contenido (guías, quiénes somos): encabezado, cuerpo y pie con links internos. */
export function PublicPage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-[#fbf7ee] text-[#1f2a30]">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <a href="/" className="flex items-center gap-2 font-bold"><img src="/logo-96.png" alt="" width={36} height={36} className="h-9 w-9 rounded-xl" />Mi Balneario</a>
        <a href={SITE_WHATSAPP_URL || "/#planes"} target="_blank" rel="noopener noreferrer"
          className="rounded-full border-2 border-[#0b6a87] px-4 py-1.5 text-sm font-bold text-[#0b6a87] hover:bg-[#0b6a87] hover:text-white">
          Pedí tu presupuesto
        </a>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-16 [&_h1]:text-balance [&_h2]:text-balance [&_p]:text-pretty">{children}</main>
      <footer className="border-t border-black/10">
        <nav aria-label="Más de Mi Balneario" className="mx-auto flex max-w-5xl flex-wrap gap-x-6 gap-y-2 px-4 py-6 text-sm text-[#4a565c]">
          <a href="/" className="hover:text-[#0b6a87]">Inicio</a>
          <a href="/guias" className="hover:text-[#0b6a87]">Guías para balnearios</a>
          <a href="/quienes-somos" className="hover:text-[#0b6a87]">Quiénes somos</a>
          <a href="/terminos" className="hover:text-[#0b6a87]">Términos</a>
          <a href="/privacidad" className="hover:text-[#0b6a87]">Privacidad</a>
        </nav>
      </footer>
    </div>
  );
}
