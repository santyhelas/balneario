import type { Metadata } from "next";
import { SITE_EMAIL, SITE_URL, SITE_WHATSAPP_URL, SITE_FOUNDER_LINKEDIN } from "@/lib/site";
import { PublicPage } from "@/components/public-page";

const DESCRIPCION = "Mi Balneario es un sistema de gestión para balnearios hecho por Santiago Helas, desde San Juan, Argentina. Quién lo hace, para quién es y cómo contactarnos.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Quiénes somos · Mi Balneario",
  description: DESCRIPCION,
  alternates: { canonical: "/quienes-somos" },
  openGraph: { type: "profile", locale: "es_AR", url: "/quienes-somos", siteName: "Mi Balneario", title: "Quiénes somos", description: DESCRIPCION, images: [{ url: "/og.png", width: 1200, height: 630 }] },
};

const ACTUALIZADO = "2026-11-20";

export default function QuienesSomosPage() {
  const ld = {
    "@context": "https://schema.org", "@type": "AboutPage", url: `${SITE_URL}/quienes-somos`, dateModified: ACTUALIZADO,
    mainEntity: {
      "@type": "Person", name: "Santiago Helas", jobTitle: "Fundador",
      worksFor: { "@type": "Organization", name: "Mi Balneario", url: SITE_URL },
      address: { "@type": "PostalAddress", addressLocality: "San Juan", addressCountry: "AR" },
      sameAs: [SITE_FOUNDER_LINKEDIN],
    },
  };
  return (
    <PublicPage>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <h1 className="pt-8 text-3xl font-extrabold leading-tight sm:text-4xl">Quiénes somos</h1>
      <div className="mt-6 space-y-4 text-lg leading-relaxed text-[#2c383e]">
        <p>
          Mi Balneario es un sistema de gestión para balnearios de la costa argentina: reservas de carpas y sombrillas por fecha,
          mapa del balneario, señas y deudas, tarifas por quincena y caja diaria, desde la compu o el celular.
        </p>
        <p>
          Lo hace <strong>Santiago Helas</strong>, desde San Juan, Argentina. El sistema nació para reemplazar el cuaderno y la planilla
          en los balnearios: que no se reserve dos veces la misma carpa, que se sepa al instante quién debe plata y que la caja cierre.
        </p>
        <p>
          Desde la temporada 2026/2027 lo usa el balneario Eólico, de Villa Gesell. La atención es directa, por WhatsApp o por mail,
          con la misma persona que hace el sistema.
        </p>
      </div>
      <section className="mt-10 rounded-2xl bg-white p-6 ring-1 ring-black/5">
        <h2 className="text-xl font-bold">Contacto</h2>
        <ul className="mt-3 space-y-2">
          {SITE_WHATSAPP_URL && <li>WhatsApp: <a href={SITE_WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="text-[#0b6a87] hover:underline">264 585-7461</a></li>}
          <li>Mail: <a href={`mailto:${SITE_EMAIL}`} className="text-[#0b6a87] hover:underline">{SITE_EMAIL}</a></li>
          <li>LinkedIn: <a href={SITE_FOUNDER_LINKEDIN} target="_blank" rel="noopener noreferrer" className="text-[#0b6a87] hover:underline">Santiago Helas</a></li>
        </ul>
      </section>
      <p className="mt-6 text-sm text-[#5b666c]">Actualizada el <time dateTime={ACTUALIZADO}>20/11/2026</time></p>
    </PublicPage>
  );
}
