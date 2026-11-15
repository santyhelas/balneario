import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ZONAS, zonaBySlug } from "@/lib/zonas";
import { SITE_URL, SITE_WHATSAPP_URL } from "@/lib/site";
import { DemoButton } from "@/components/landing";

export const dynamicParams = false;
export function generateStaticParams() {
  return ZONAS.map((z) => ({ zona: z.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ zona: string }> }): Promise<Metadata> {
  const z = zonaBySlug((await params).zona);
  if (!z) return {};
  const title = `Sistema para balnearios ${z.donde} · Mi Balneario`;
  const description = `Software de gestión para balnearios ${z.donde}: mapa de carpas y sombrillas, reservas, señas, deudas y caja diaria, desde la compu o el celular. Probá la demo gratis.`;
  return {
    metadataBase: new URL(SITE_URL), title, description,
    alternates: { canonical: `/sistema-para-balnearios/${z.slug}` },
    openGraph: { type: "website", locale: "es_AR", url: `/sistema-para-balnearios/${z.slug}`, siteName: "Mi Balneario", title, description, images: [{ url: "/og.png", width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, description, images: ["/og.png"] },
  };
}

const FEATURES = [
  { t: "El mapa de tu balneario", d: "Tus carpas y sombrillas en su lugar. Elegís un día y ves qué está libre, quién está en cada una y hasta cuándo." },
  { t: "Reservas sin superponer", d: "El sistema no te deja reservar dos veces la misma carpa y te propone otra cuando hay días ocupados." },
  { t: "Señas y deudas al peso", d: "Cobrás todo, una seña o después. Sabés exactamente quién te debe y cuánto, sin rangos ni cuentas a mano." },
  { t: "Caja del día", d: "Apertura, cobros en efectivo, transferencia y tarjeta, gastos y cierre con lo que tendría que haber." },
  { t: "WhatsApp listo para mandar", d: "Con un toque se arma el mensaje con fechas, carpa e importe para el cliente." },
  { t: "Para vos y tus empleados", d: "Cada uno con su usuario, desde la compu o el celular, y todos ven lo mismo al instante." },
];

export default async function ZonaPage({ params }: { params: Promise<{ zona: string }> }) {
  const z = zonaBySlug((await params).zona);
  if (!z) notFound();
  const faqs = [
    { q: `¿Sirve para cualquier balneario ${z.donde}?`, a: "Sí: para balnearios con carpas, sombrillas o las dos, chicos o grandes. Armamos el mapa con tu distribución real y cargamos tus tarifas." },
    { q: "¿Cuánto se tarda en implementar el sistema?", a: "En 72 horas tenés tu balneario funcionando. Cuanto antes empieces, mejor: llegás a la temporada con tus clientes y reservas ya cargados." },
    { q: "¿Si tengo un problema, qué pasa?", a: "Tenés soporte 24/7 por WhatsApp." },
    { q: "¿Cuánto cuesta?", a: "Depende del tamaño de tu balneario. Calculalo en la página de presupuesto o escribinos por WhatsApp." },
  ];
  const ld = [{
    "@context": "https://schema.org", "@type": "Service", name: `Sistema de gestión para balnearios ${z.donde}`,
    provider: { "@type": "Organization", name: "Mi Balneario", url: SITE_URL },
    areaServed: { "@type": "City", name: z.nombre, containedInPlace: { "@type": "State", name: z.provincia } },
    url: `${SITE_URL}/sistema-para-balnearios/${z.slug}`,
  }, {
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  }];
  return (
    <div className="min-h-dvh bg-[#fbf7ee] text-[#1f2a30]">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <a href="/" className="flex items-center gap-2 font-bold"><img src="/logo.png" alt="" className="h-9 w-9 rounded-xl" />Mi Balneario</a>
        <a href="/presupuesto" className="rounded-full border-2 border-[#0b6a87] px-4 py-1.5 text-sm font-bold text-[#0b6a87] hover:bg-[#0b6a87] hover:text-white">Calculá tu precio</a>
      </header>
      <main className="mx-auto max-w-5xl px-4 pb-20">
        <section className="py-10">
          <p className="text-sm font-semibold uppercase tracking-widest text-[#0b6a87]">{z.nombre} · {z.provincia}</p>
          <h1 className="mt-2 max-w-3xl text-4xl font-extrabold leading-tight sm:text-5xl">Sistema para balnearios {z.donde}</h1>
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-[#4a565c]">
            Mi Balneario es el sistema de gestión para los balnearios de la costa, {z.detalle}. Reservas de carpas y sombrillas, señas, deudas y caja del día,
            todo en un mapa de tu balneario que podés usar desde la compu o el celular.
          </p>
          <div className="mt-7 flex flex-wrap items-start gap-3">
            <DemoButton className="rounded-full bg-[#d6332f] px-7 text-white shadow hover:brightness-110" countClassName="text-[#4a565c]" />
            <a href="/presupuesto" className="inline-flex items-center rounded-full border-2 border-[#0b6a87] px-7 py-3 font-bold text-[#0b6a87] hover:bg-[#0b6a87] hover:text-white">Calculá tu precio</a>
          </div>
          <p className="mt-3 text-sm text-[#5b666c]">La demo abre un balneario de prueba con datos inventados. No hace falta registrarse.</p>
        </section>
        <section aria-label="Funciones" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.t} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
              <h2 className="text-lg font-bold">{f.t}</h2>
              <p className="mt-1 text-[#4a565c]">{f.d}</p>
            </div>
          ))}
        </section>
        <section className="mt-14">
          <h2 className="text-3xl font-extrabold">Preguntas frecuentes</h2>
          <div className="mt-4 divide-y divide-[#e5dcc8] border-y border-[#e5dcc8]">
            {faqs.map((f) => (
              <details key={f.q} className="group py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-lg font-bold">{f.q}<span className="text-[#0b6a87] transition group-open:rotate-45" aria-hidden>+</span></summary>
                <p className="mt-2 text-[#4a565c]">{f.a}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="mt-14 rounded-3xl bg-[#0b6a87] p-8 text-white">
          <h2 className="text-2xl font-extrabold">¿Tenés un balneario {z.donde}?</h2>
          <p className="mt-2 text-white/85">Probá la demo o escribinos y te armamos todo antes de la temporada.</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <a href="/" className="rounded-full bg-white px-6 py-2.5 font-bold text-[#0b6a87]">Ver Mi Balneario</a>
            {SITE_WHATSAPP_URL && <a href={SITE_WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="rounded-full bg-[#25d366] px-6 py-2.5 font-bold text-[#06210f]">Escribinos por WhatsApp</a>}
          </div>
        </section>
        <nav aria-label="Otras zonas" className="mt-12 text-sm text-[#5b666c]">
          También en: {ZONAS.filter((x) => x.slug !== z.slug).map((x, i) => (
            <span key={x.slug}>{i > 0 && " · "}<a href={`/sistema-para-balnearios/${x.slug}`} className="underline hover:text-[#0b6a87]">{x.nombre}</a></span>
          ))}
        </nav>
      </main>
      {SITE_WHATSAPP_URL && (
        <a href={SITE_WHATSAPP_URL} target="_blank" rel="noopener noreferrer" aria-label="Escribinos por WhatsApp"
          className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[#25d366] text-2xl text-white shadow-lg transition hover:scale-105">
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-8 w-8" aria-hidden><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.9 11.9 0 0 0 4.6 4c1.7.7 2.3.8 3.2.7.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.2-.2-.5-.3z" /></svg>
        </a>
      )}
    </div>
  );
}
