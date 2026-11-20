import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GUIAS, GUIAS_AUTOR, fechaAR, guiaBySlug, type Bloque } from "@/lib/guias";
import { SITE_URL } from "@/lib/site";
import { PublicPage } from "@/components/public-page";
import { DemoButton } from "@/components/landing";

export const dynamicParams = false;
export function generateStaticParams() {
  return GUIAS.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const g = guiaBySlug((await params).slug);
  if (!g) return {};
  const url = `/guias/${g.slug}`;
  return {
    metadataBase: new URL(SITE_URL),
    title: `${g.titulo} · Mi Balneario`,
    description: g.resumen,
    alternates: { canonical: url },
    openGraph: { type: "article", locale: "es_AR", url, siteName: "Mi Balneario", title: g.titulo, description: g.resumen, images: [{ url: "/og.png", width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title: g.titulo, description: g.resumen, images: ["/og.png"] },
  };
}

function Bloques({ bloques }: { bloques: Bloque[] }) {
  return (
    <>
      {bloques.map((b, i) => {
        if (b.t === "p") return <p key={i} className="mt-4 leading-relaxed text-[#2c383e]">{b.texto}</p>;
        if (b.t === "lista") {
          const List = b.ordenada ? "ol" : "ul";
          return (
            <List key={i} className={`mt-4 space-y-2 pl-6 leading-relaxed text-[#2c383e] ${b.ordenada ? "list-decimal" : "list-disc"}`}>
              {b.items.map((it, j) => <li key={j}>{it}</li>)}
            </List>
          );
        }
        return (
          <figure key={i} className="mt-5">
            <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-black/10">
              <table className="w-full min-w-[480px] text-left text-sm">
                <thead className="bg-[#eef6f9] text-[#0b4f6c]">
                  <tr>{b.cabecera.map((c, j) => <th key={j} scope="col" className="px-4 py-3 font-bold">{c}</th>)}</tr>
                </thead>
                <tbody>
                  {b.filas.map((f, j) => (
                    <tr key={j} className="border-t border-black/5">
                      {f.map((c, k) => k === 0 ? <th key={k} scope="row" className="px-4 py-3 font-semibold">{c}</th> : <td key={k} className="px-4 py-3">{c}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {b.nota && <figcaption className="mt-2 text-sm text-[#5b666c]">{b.nota}</figcaption>}
          </figure>
        );
      })}
    </>
  );
}

export default async function GuiaPage({ params }: { params: Promise<{ slug: string }> }) {
  const g = guiaBySlug((await params).slug);
  if (!g) notFound();
  const url = `${SITE_URL}/guias/${g.slug}`;
  const ld = [{
    "@context": "https://schema.org", "@type": "Article",
    headline: g.titulo, description: g.resumen, inLanguage: "es-AR",
    datePublished: g.actualizado, dateModified: g.actualizado,
    author: { "@type": "Person", name: GUIAS_AUTOR, url: `${SITE_URL}/quienes-somos` },
    publisher: { "@type": "Organization", name: "Mi Balneario", url: SITE_URL, logo: { "@type": "ImageObject", url: `${SITE_URL}/icon-512.png` } },
    mainEntityOfPage: url, image: `${SITE_URL}/og.png`,
  }, {
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: g.preguntas.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  }, {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Inicio", item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: "Guías", item: `${SITE_URL}/guias` },
      { "@type": "ListItem", position: 3, name: g.titulo, item: url },
    ],
  }];
  const otras = GUIAS.filter((x) => x.slug !== g.slug);
  return (
    <PublicPage>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <article>
        <nav aria-label="Ubicación" className="pt-6 text-sm text-[#5b666c]"><a href="/guias" className="hover:text-[#0b6a87]">← Guías para balnearios</a></nav>
        <h1 className="mt-4 text-3xl font-extrabold leading-tight sm:text-4xl">{g.titulo}</h1>
        <p className="mt-3 text-sm text-[#5b666c]">
          Por <a href="/quienes-somos" className="font-semibold text-[#0b6a87] hover:underline">{GUIAS_AUTOR}</a> · Actualizada el <time dateTime={g.actualizado}>{fechaAR(g.actualizado)}</time>
        </p>
        <p className="mt-6 rounded-2xl bg-white p-5 text-lg leading-relaxed ring-1 ring-black/5">{g.resumen}</p>
        {g.secciones.map((s) => (
          <section key={s.titulo} className="mt-10">
            <h2 className="text-2xl font-bold">{s.titulo}</h2>
            <Bloques bloques={s.bloques} />
          </section>
        ))}
        <section className="mt-12">
          <h2 className="text-2xl font-bold">Preguntas frecuentes</h2>
          <dl className="mt-4 space-y-5">
            {g.preguntas.map((f) => (
              <div key={f.q}>
                <dt className="font-semibold">{f.q}</dt>
                <dd className="mt-1 leading-relaxed text-[#2c383e]">{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>
      </article>
      <aside className="mt-12 rounded-3xl bg-[#0b4f6c] p-6 text-white sm:p-8">
        <p className="text-xl font-bold">¿Querés ver cómo queda esto en un sistema?</p>
        <p className="mt-2 text-white/85">Mi Balneario tiene una demo con un balneario de prueba y datos inventados. No hace falta registrarse.</p>
        <div className="mt-5"><DemoButton className="rounded-full bg-[#d6332f] px-7 text-white shadow hover:brightness-110" countClassName="text-white/80" /></div>
      </aside>
      <nav aria-label="Otras guías" className="mt-12">
        <h2 className="text-lg font-bold">Otras guías</h2>
        <ul className="mt-3 space-y-2">
          {otras.map((o) => <li key={o.slug}><a href={`/guias/${o.slug}`} className="text-[#0b6a87] hover:underline">{o.titulo}</a></li>)}
        </ul>
      </nav>
    </PublicPage>
  );
}
