import type { Metadata } from "next";
import { GUIAS, fechaAR } from "@/lib/guias";
import { SITE_URL } from "@/lib/site";
import { PublicPage } from "@/components/public-page";

const DESCRIPCION = "Guías prácticas para dueños y encargados de balnearios: reservas de carpas y sombrillas, tarifario por quincena, caja diaria y cómo pasar del cuaderno a un sistema.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Guías para balnearios · Mi Balneario",
  description: DESCRIPCION,
  alternates: { canonical: "/guias" },
  openGraph: { type: "website", locale: "es_AR", url: "/guias", siteName: "Mi Balneario", title: "Guías para balnearios", description: DESCRIPCION, images: [{ url: "/og.png", width: 1200, height: 630 }] },
};

export default function GuiasPage() {
  return (
    <PublicPage>
      <h1 className="pt-8 text-3xl font-extrabold leading-tight sm:text-4xl">Guías para balnearios</h1>
      <p className="mt-4 text-lg leading-relaxed text-[#4a565c]">{DESCRIPCION}</p>
      <ul className="mt-8 space-y-4">
        {GUIAS.map((g) => (
          <li key={g.slug} className="rounded-2xl bg-white p-5 ring-1 ring-black/5">
            <a href={`/guias/${g.slug}`} className="text-xl font-bold text-[#0b4f6c] hover:underline">{g.titulo}</a>
            <p className="mt-2 leading-relaxed text-[#2c383e]">{g.resumen}</p>
            <p className="mt-2 text-sm text-[#5b666c]">Actualizada el <time dateTime={g.actualizado}>{fechaAR(g.actualizado)}</time></p>
          </li>
        ))}
      </ul>
    </PublicPage>
  );
}
