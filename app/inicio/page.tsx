import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";

/** Retraso de una animación (para que las cosas entren de a una). */
const dl = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/figtree";
import { SITE_EMAIL, SITE_INSTAGRAM, SITE_INSTAGRAM_URL, SITE_URL, SITE_WHATSAPP_URL } from "@/lib/site";
import { Analytics } from "@vercel/analytics/next";
import { CopyEmailButton, DemoButton, DemoEndedNotice, LandingThemeToggle, LoginLink, MobileMenu, ScrollReveal, TB_THEME_SCRIPT } from "@/components/landing";
import { DayTimeline, HeroBeach, PhotoStrip, Slider, type DayStep } from "@/components/landing-interactive";
import "./landing.css";


const DESCRIPTION =
  "Sistema de gestión de balnearios: alquiler y reservas de carpas y sombrillas por fecha, mapa de la playa, cobros, señas, deudas, caja diaria, clientes y WhatsApp. Desde la computadora o el celular.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Mi Balneario · Sistema de gestión de balnearios y alquiler de carpas",
  description: DESCRIPTION,
  keywords: ["gestión de balnearios", "sistema para balnearios", "alquiler de carpas", "reservas de carpas", "sombrillas", "software balneario", "Argentina"],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website", locale: "es_AR", url: "/", siteName: "Mi Balneario",
    title: "Mi Balneario · Sistema de gestión de balnearios",
    description: DESCRIPTION,
    images: [{ url: "/icon-512.png", width: 512, height: 512, alt: "Mi Balneario" }],
  },
  twitter: { card: "summary", title: "Mi Balneario · Sistema de gestión de balnearios", description: DESCRIPTION, images: ["/icon-512.png"] },
  // Código de verificación de Google Search Console (se carga en Vercel; ver README).
  verification: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION ? { google: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION } : undefined,
};

/** Datos estructurados para Google: qué es la página. */
const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Mi Balneario",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  inLanguage: "es-AR",
  description: DESCRIPTION,
  url: SITE_URL,
  email: SITE_EMAIL,
  sameAs: [SITE_INSTAGRAM_URL],
};

const NAV = [
  { href: "#un-dia", label: "Cómo se usa" },
  { href: "#funciones", label: "Funciones" },
  { href: "#planes", label: "Presupuesto" },
  { href: "#preguntas", label: "Preguntas" },
];

/**
 * Fotos reales: poné los archivos en public/landing/ y agregalos acá ({ src: "/landing/playa.jpg", caption: "…" }).
 * Mientras esté vacía, la tira de fotos no se muestra.
 */
const PHOTOS: { src: string; caption: string }[] = [];


const FAQ = [
  { q: "¿Tengo que instalar algo?", a: "No. Funciona desde el navegador (Chrome, Edge, Safari) en la computadora o en el celular. En el celular lo podés agregar a la pantalla de inicio y se abre como una app." },
  { q: "¿Qué pasa con lo que cargo en la demo?", a: "La demo es un balneario de prueba solo para vos. Cuando salís o cerrás la pestaña se borra todo." },
  { q: "¿Mis datos y los de mis clientes están seguros?", a: "Cada balneario ve solo sus datos. Todo se guarda en una base de datos protegida, no en tu computadora, y podés tener una copia diaria en tu propio Google Drive." },
  { q: "¿Lo pueden usar mis empleados?", a: "Sí. Cada uno con su usuario, desde su celular o la compu del balneario, y todos ven lo mismo al instante." },
  { q: "¿Y si se corta internet?", a: "Para guardar hace falta internet. Si se corta, el sistema te avisa y no te muestra datos viejos como si fueran los de ahora, así no reservás algo que ya está ocupado." },
  { q: "¿Cuánto cuesta?", a: "Depende del tamaño de tu balneario. Pedinos un presupuesto sin compromiso por WhatsApp o por mail y te respondemos." },
];

/** Ícono de Instagram (dibujo simple de cámara). */
function InstagramIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} className={className} aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1" fill="currentColor" />
    </svg>
  );
}

function WhatsAppIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.9 11.9 0 0 0 4.6 4c1.7.7 2.3.8 3.2.7.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.2-.2-.5-.3z" />
    </svg>
  );
}

function Icon({ d, className = "h-5 w-5" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={d} />
    </svg>
  );
}

/* ---------------- Pantallas de ejemplo del sistema (datos inventados) ---------------- */

function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-3xl bg-white text-[var(--tinta)] shadow-2xl ring-1 ring-black/10">
      <div className="flex items-center gap-2 border-b border-black/5 bg-[#f7f3ea] px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#e7b9b2]" /><span className="h-2.5 w-2.5 rounded-full bg-[#ecd9a5]" /><span className="h-2.5 w-2.5 rounded-full bg-[#b7d7c0]" />
        <span className="ml-2 text-xs font-semibold text-[var(--gris)]">{title}</span>
      </div>
      <div className="p-5 text-sm">{children}</div>
    </div>
  );
}
const Row = ({ l, r, strong, tone }: { l: string; r: string; strong?: boolean; tone?: string }) => (
  <div className={`flex justify-between gap-4 py-1 ${strong ? "border-t border-black/10 pt-2 text-base font-bold" : ""}`}>
    <span className={strong ? "" : "text-[var(--gris)]"}>{l}</span><span className="tabular-nums" style={tone ? { color: tone } : undefined}>{r}</span>
  </div>
);
const Bubble = ({ children }: { children: ReactNode }) => (
  <div className="ml-auto max-w-[92%] whitespace-pre-line rounded-2xl rounded-tr-sm bg-[#d9fdd3] px-4 py-3 text-[13px] leading-relaxed text-[#111b21] shadow-sm">{children}</div>
);

const STEPS: DayStep[] = [
  {
    time: "08:30", title: "Abrís la caja", text: "Contás el efectivo con el que arrancás. El sistema no lo toma como ingreso y no te lo vuelve a pedir en el día.",
    screen: (
      <Screen title="Caja diaria">
        <Row l="Apertura" r="$ 50.000" />
        <Row l="Entradas en efectivo" r="$ 0" />
        <Row l="Salidas en efectivo" r="$ 0" />
        <Row l="Efectivo esperado" r="$ 50.000" strong />
        <div className="mt-4 rounded-xl bg-[var(--foam)] px-3 py-2 text-xs text-[var(--atl)]">Hoy entran 4 clientes y terminan 3 estadías.</div>
      </Screen>
    ),
  },
  {
    time: "10:15", title: "Llega alguien sin reserva", text: "Elegís las fechas y te muestra qué carpas están libres todos esos días. Lo das de alta ahí mismo y cobrás.",
    screen: (
      <Screen title="Nueva reserva">
        <div className="mb-3 font-semibold">Martina Acosta, del 10/01 al 24/01 (15 días)</div>
        <div className="mb-3 grid grid-cols-6 gap-1.5">
          {["12", "14", "15", "19", "22", "27", "30", "31", "33", "35", "38", "41"].map((c, k) => (
            <span key={c} className={`rounded-md border py-1 text-center text-xs font-bold ${k === 3 ? "border-[var(--atl)] bg-[var(--atl)] text-white" : k % 5 === 4 ? "border-[#e3c98f] bg-[#fdf3dc] text-[#9a6b00]" : "border-[#bfe3cb] bg-[#e7f6ec] text-[#1f7a43]"}`}>{c}</span>
          ))}
        </div>
        <Row l="2 quincenas de enero" r="$ 420.000" />
        <Row l="Pago en efectivo (10%)" r="− $ 42.000" tone="#1f7a43" />
        <Row l="Total" r="$ 378.000" strong />
      </Screen>
    ),
  },
  {
    time: "13:00", title: "Te preguntan el precio", text: "Calculás el total exacto y se lo mandás por WhatsApp, sin reservar nada ni bloquear la carpa.",
    screen: (
      <Screen title="WhatsApp">
        <Bubble>{"Hola Lucía! Te pasamos el presupuesto de Balneario La Ola:\nCarpa 19, del 01/02 al 07/02 (7 días)\n*Total: $ 196.000*\nPagando en efectivo: $ 176.400\n¿Te la reservamos?"}</Bubble>
      </Screen>
    ),
  },
  {
    time: "18:00", title: "Alguien se va y debe plata", text: "El panel te avisa quién termina hoy con saldo. El mensaje ya está escrito: lo retocás si querés y lo mandás.",
    screen: (
      <Screen title="Cobros y señas">
        <div className="mb-3 flex items-center justify-between rounded-xl bg-[#fde8e6] px-3 py-2">
          <div><div className="font-bold">Carpa 7, Gómez</div><div className="text-xs text-[#b42318]">Termina hoy</div></div>
          <span className="font-bold tabular-nums text-[#b42318]">Debe $ 70.000</span>
        </div>
        <Row l="Total" r="$ 150.000" />
        <Row l="Seña (efectivo)" r="$ 50.000" />
        <Row l="Segundo pago (transferencia)" r="$ 30.000" />
        <Row l="Saldo" r="$ 70.000" strong tone="#b42318" />
      </Screen>
    ),
  },
  {
    time: "20:00", title: "Cerrás el día", text: "Contás la plata y ves la diferencia con lo esperado. Imprimís el ticket con los cobros con tarjeta para comparar con el posnet.",
    screen: (
      <Screen title="Cierre de caja">
        <Row l="Apertura" r="$ 50.000" />
        <Row l="+ Cobros en efectivo" r="$ 200.000" />
        <Row l="− Gastos en efectivo" r="$ 30.000" />
        <Row l="Efectivo esperado" r="$ 220.000" strong />
        <Row l="Contado" r="$ 220.000" />
        <div className="mt-3 rounded-xl bg-[#e7f6ec] px-3 py-2 text-center font-bold text-[#1f7a43]">Sin diferencia</div>
      </Screen>
    ),
  },
];

/* ---------------- Funciones, en diapositivas ---------------- */

type Feature = { title: string; text: string; icon: string };
const GROUPS: { key: string; title: string; lead: string; color: string; items: Feature[] }[] = [
  {
    key: "playa", title: "La playa", lead: "Lo que pasa en la arena, día por día.", color: "#0b4f6c",
    items: [
      { title: "Mapa del balneario", icon: "M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z", text: "Mar, arena, carpas y sombrillas. Lo armás arrastrando con el mouse y elegís el diseño de las carpas." },
      { title: "Reservas por fecha", icon: "M6 3h12v18l-6-4-6 4z", text: "Si la carpa está ocupada algunos días, te muestra alternativas reales y decidís vos." },
      { title: "Cambios de carpa", icon: "M7 7h11l-3-3M17 17H6l3 3", text: "Por un día o por el resto de la estadía, sin otra reserva y sin tocar los pagos." },
      { title: "Llegó o no vino", icon: "M20 6L9 17l-5-5", text: "Si alguien de un día no vino, la carpa se libera en el momento." },
    ],
  },
  {
    key: "plata", title: "La plata", lead: "Lo contratado y lo cobrado, siempre separados.", color: "#c22c28",
    items: [
      { title: "Señas, pagos y deudas", icon: "M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3S9.5 10.5 12 11s4.5 1.3 4.5 3-2 3-4.5 3-4.5-1.3-4.5-3", text: "Efectivo, transferencia, tarjeta, Mercado Pago y dólares al valor del Banco Nación." },
      { title: "Caja diaria", icon: "M3 7h18v12H3zM3 11h18M7 15h3", text: "Apertura, gastos, cierre y diferencias. Solo el efectivo cuenta como plata en la caja." },
      { title: "Tarifario y convenios", icon: "M20 12l-8 8-9-9V3h8l9 9z", text: "Precios por quincena y temporada, descuento por efectivo, convenios y cortesías." },
      { title: "Informes y Excel", icon: "M4 20V10M10 20V4M16 20v-7M22 20H2", text: "Ocupación, ingresos, deudas, gastos y clientes frecuentes, para descargar." },
    ],
  },
  {
    key: "clientes", title: "Los clientes", lead: "Que paguen a tiempo y que vuelvan.", color: "#1f7a4f",
    items: [
      { title: "Historial de cada cliente", icon: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", text: "Temporadas, carpas, pagos y deudas. Lo das de alta desde la misma reserva." },
      { title: "WhatsApp listo para mandar", icon: "M21 12a9 9 0 0 1-13.3 7.9L3 21l1.1-4.7A9 9 0 1 1 21 12z", text: "Recordatorios de deuda, comprobantes y presupuestos con tus propios mensajes." },
      { title: "Renovación de temporada", icon: "M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5", text: "Los clientes del año pasado con su carpa de siempre, para ofrecérsela primero." },
      { title: "Clima, viento y sol", icon: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z", text: "Para ubicar a quien busca sombra o reparo del viento." },
    ],
  },
  {
    key: "datos", title: "Tus datos", lead: "Pensado para usarse todos los días de la temporada.", color: "#5b43b0",
    items: [
      { title: "En la compu y en el celular", icon: "M4 5h16v11H4zM2 19h20", text: "Lo que cargás en una aparece al instante en las demás." },
      { title: "Sin reservas duplicadas", icon: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z", text: "Si dos personas reservan la misma carpa a la vez, el sistema lo impide." },
      { title: "Historial de todo", icon: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5", text: "Quién hizo cada cambio y cuándo. Nada se borra a escondidas." },
      { title: "Copias en tu Google Drive", icon: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6", text: "Una copia automática por día, más las que hagas a mano." },
    ],
  },
];

function GroupSlide({ g, n, total }: { g: (typeof GROUPS)[number]; n: number; total: number }) {
  return (
    <article className="grid min-h-[480px] overflow-hidden bg-white ring-1 ring-inset ring-[var(--sand-2)] lg:grid-cols-[0.8fr_1.2fr]">
      <div className="relative flex flex-col justify-between overflow-hidden p-8 text-white sm:p-10" style={{ background: g.color }}>
        <svg viewBox="0 0 200 200" className="pointer-events-none absolute -bottom-16 -right-16 h-64 w-64 opacity-15" aria-hidden>
          <path d="M0 120 Q25 100 50 120 T100 120 T150 120 T200 120 M0 150 Q25 130 50 150 T100 150 T150 150 T200 150 M0 180 Q25 160 50 180 T100 180 T150 180 T200 180" fill="none" stroke="#fff" strokeWidth="8" />
        </svg>
        <div>
          <span className="text-sm font-semibold text-white/70">Parte {n} de {total}</span>
          <h3 className="mt-2 text-5xl font-extrabold leading-none sm:text-6xl">{g.title}</h3>
          <p className="mt-4 max-w-xs text-xl leading-snug text-white/90">{g.lead}</p>
        </div>
        <span className="relative mt-10 flex h-20 w-20 items-center justify-center rounded-3xl bg-white/15"><Icon d={g.items[0].icon} className="h-10 w-10" /></span>
      </div>
      <ul className="grid content-center gap-x-8 gap-y-8 p-8 sm:grid-cols-2 sm:p-10">
        {g.items.map((f) => (
          <li key={f.title} className="tb-lift -m-3 rounded-2xl p-3">
            <span className="tb-bob mb-3 flex h-12 w-12 items-center justify-center rounded-2xl" style={{ background: `color-mix(in srgb, ${g.color} 13%, white)`, color: g.color }}><Icon d={f.icon} className="h-6 w-6" /></span>
            <h4 className="text-lg font-bold">{f.title}</h4>
            <p className="mt-1 leading-relaxed text-[var(--gris)]">{f.text}</p>
          </li>
        ))}
      </ul>
    </article>
  );
}

/* ---------------- Fotos reales (cuando se carguen en PHOTOS) ---------------- */

const POSTCARDS: { key: string; caption: string; node: ReactNode }[] = PHOTOS.map((p) => ({
  key: p.src, caption: p.caption,
  // eslint-disable-next-line @next/next/no-img-element
  node: <img src={p.src} alt={p.caption} className="h-full w-full object-cover" />,
}));

export default function InicioPage() {
  return (
    <div id="arriba" className="tb min-h-dvh">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />
      {/* Tema de la página (claro u oscuro): se aplica antes de pintar para que no parpadee. */}
      <script dangerouslySetInnerHTML={{ __html: TB_THEME_SCRIPT }} />
      <header className="tb-header sticky top-0 z-40 bg-[#fbf7ee]/90 backdrop-blur">
        <div className="relative mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <a href="#arriba" className="flex items-center" aria-label="Mi Balneario">
            {/* Logo de día y de noche (se cambia con el botón luna/sol) */}
            <img src="/brand/mi-balneario-logo.svg" alt="Mi Balneario" className="tb-logo-dia h-10 w-auto sm:h-12" />
            <img src="/brand/mi-balneario-logo-blanco.svg" alt="Mi Balneario" className="tb-logo-noche h-10 w-auto sm:h-12" />
          </a>
          <nav className="hidden items-center gap-7 text-[15px] font-semibold md:flex">
            {NAV.map((l) => <a key={l.href} href={l.href} className="text-[var(--gris)] hover:text-[var(--atl)]">{l.label}</a>)}
          </nav>
          <div className="flex items-center gap-2">
            <LandingThemeToggle />
            <LoginLink className="rounded-full bg-[var(--atl)] px-5 py-2.5 text-sm font-bold text-white hover:bg-[var(--atl-2)]" />
            <MobileMenu links={NAV} />
          </div>
        </div>
      </header>
      <DemoEndedNotice />

      <main>
        {/* Portada: el plano del balneario, que se puede tocar */}
        <section className="relative overflow-hidden">
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-14 pt-8 lg:grid-cols-[0.9fr_1.1fr] lg:pt-14">
            <div>
              <h1 className="tb-in text-[2.5rem] font-extrabold leading-[1.03] sm:text-6xl">
                Tu balneario entero, en un mapa que sabe quién está en cada carpa.
              </h1>
              <p className="tb-in mt-5 max-w-lg text-lg leading-relaxed text-[var(--gris)]" style={dl(150)}>
                Mi Balneario es un sistema de gestión de balnearios para el alquiler de carpas y sombrillas.
                Elegí un día y mirá qué está libre; tocá una carpa y ves quién la tiene, hasta cuándo y si pagó.
                Reservas, cobros, deudas y caja, desde la compu o el celular.
              </p>
              <div className="tb-in mt-8 flex flex-wrap items-start gap-3" style={dl(300)}>
                <DemoButton className="tb-shine tb-press rounded-full bg-[var(--lona)] px-7 text-white shadow-[0_10px_25px_-10px_rgba(214,51,47,0.8)] hover:brightness-110" />
                <a href="#planes" className="tb-press inline-flex items-center justify-center rounded-full border-2 border-[var(--atl)] px-7 py-3 text-base font-bold text-[var(--atl)] hover:bg-[var(--atl)] hover:text-white">
                  Pedí tu presupuesto
                </a>
              </div>
              <p className="tb-in mt-3 text-sm text-[var(--gris)]" style={dl(420)}>La demo abre un balneario de prueba con datos inventados. No hace falta registrarse.</p>
            </div>
            <div className="tb-in" style={dl(250)}><div className="tb-float"><HeroBeach /></div></div>
          </div>
        </section>

        {/* Fotos del balneario (solo cuando haya fotos reales cargadas en PHOTOS) */}
        {PHOTOS.length > 0 && (
          <section className="pb-16" aria-label="Fotos">
            <PhotoStrip items={POSTCARDS} />
          </section>
        )}

        {/* Un día en el balneario */}
        <section id="un-dia" className="scroll-mt-16 bg-[var(--atl)] text-white">
          <div className="mx-auto max-w-6xl px-4 py-20">
            <h2 data-reveal className="max-w-2xl text-4xl font-extrabold leading-tight sm:text-5xl">Un día de enero, de la apertura al cierre.</h2>
            <p data-reveal style={dl(120)} className="mt-3 max-w-xl text-white/75">Así se usa Mi Balneario en una jornada normal de temporada.</p>
            <div data-reveal style={dl(220)} className="mt-12">
              <DayTimeline steps={STEPS} />
            </div>
          </div>
        </section>

        {/* Funciones */}
        <section id="funciones" className="scroll-mt-16 overflow-hidden">
          <div className="mx-auto max-w-6xl px-4 py-20">
            <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
              <h2 data-reveal className="max-w-xl text-4xl font-extrabold leading-tight sm:text-5xl">Todo lo que hace, en cuatro partes.</h2>
              <p data-reveal="right" style={dl(150)} className="max-w-sm text-[var(--gris)]">Pasá de a una con las flechas, las pestañas o deslizando. Todas se pueden probar en la demo.</p>
            </div>
            <div data-reveal style={dl(200)}><Slider label="Funciones del sistema" slides={GROUPS.map((g, k) => ({ key: g.key, title: g.title, node: <GroupSlide g={g} n={k + 1} total={GROUPS.length} /> }))} /></div>
          </div>
        </section>

        {/* Cómo empezar: es un paso a paso real */}
        <section className="bg-[var(--sand)]">
          <div className="mx-auto max-w-6xl px-4 py-20">
            <h2 data-reveal className="text-4xl font-extrabold sm:text-5xl">Empezar lleva una tarde.</h2>
            <ol className="mt-10 grid gap-8 md:grid-cols-3">
              {[
                ["Probá la demo", "Tocá todo en un balneario de prueba. No hace falta registrarse."],
                ["Te habilitamos tu balneario", "Pedí tu presupuesto y te damos acceso. Ponés el nombre y cuántas carpas y sombrillas tenés: el mapa se arma solo y lo acomodás arrastrando."],
                ["Cargá tus precios", "Ponés las tarifas de la temporada y ya podés reservar, cobrar y abrir la caja."],
              ].map(([t, x], k) => (
                <li key={t} data-reveal style={dl(k * 160)} className="relative pl-14">
                  <span className="display absolute left-0 top-0 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--atl)] text-lg font-extrabold text-white">{k + 1}</span>
                  <h3 className="text-xl font-bold">{t}</h3>
                  <p className="mt-1 text-[var(--gris)]">{x}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Presupuesto (el ancla #planes se mantiene porque la usan los avisos del sistema) */}
        <section id="planes" className="scroll-mt-16">
          <div className="mx-auto max-w-4xl px-4 py-20">
            <div data-reveal="zoom" className="overflow-hidden rounded-[32px] bg-[var(--atl)] px-6 py-12 text-center text-white shadow-xl sm:px-12">
              <h2 className="text-4xl font-extrabold sm:text-5xl">Pedí tu presupuesto</h2>
              <p className="mx-auto mt-3 max-w-lg text-lg text-white/85">
                Contanos cuántas carpas y sombrillas tenés y te armamos una propuesta para tu balneario.
                Te ayudamos a cargar el mapa y las tarifas.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                {SITE_WHATSAPP_URL && (
                  <a href={SITE_WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
                    className="tb-press inline-flex h-14 w-full items-center justify-center gap-2 rounded-full bg-[#25d366] px-6 text-base font-bold text-[#06210f] hover:brightness-105 sm:w-72">
                    <WhatsAppIcon className="h-5 w-5" />Escribinos por WhatsApp
                  </a>
                )}
                <CopyEmailButton email={SITE_EMAIL}
                  className="tb-press inline-flex h-14 w-full items-center justify-center gap-2 rounded-full bg-white px-6 text-base font-bold text-[var(--atl)] hover:bg-[var(--foam)] sm:w-72">
                  <Icon d="M4 6h16v12H4zM4 7l8 6 8-6" />Escribinos por mail
                </CopyEmailButton>
              </div>
              <p className="mt-6 text-sm text-white/70">Mientras tanto, probá todo en la demo, sin registrarte.</p>
            </div>
          </div>
        </section>

        {/* Preguntas */}
        <section id="preguntas" className="scroll-mt-16 bg-white">
          <div className="mx-auto max-w-3xl px-4 py-20">
            <h2 data-reveal className="text-4xl font-extrabold sm:text-5xl">Preguntas frecuentes</h2>
            <div className="mt-8 divide-y divide-[var(--sand-2)] border-y border-[var(--sand-2)]">
              {FAQ.map((f, k) => (
                <details key={f.q} data-reveal style={dl(k * 70)} className="group py-5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-lg font-bold">
                    {f.q}
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--foam)] text-[var(--atl)] transition group-open:rotate-45" aria-hidden>+</span>
                  </summary>
                  <p className="mt-2 max-w-2xl leading-relaxed text-[var(--gris)]">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Cierre */}
        <section className="relative overflow-hidden bg-[var(--atl-2)] text-white">
          <svg viewBox="0 0 1200 60" preserveAspectRatio="none" className="absolute inset-x-0 top-0 h-10 w-full" aria-hidden>
            <path className="tb-fill-white" d="M0 0 H1200 V30 Q1100 60 1000 30 T800 30 T600 30 T400 30 T200 30 T0 30 Z" fill="#fff" />
          </svg>
          {/* Gaviotas que cruzan */}
          <div className="pointer-events-none absolute inset-x-0 top-14 h-24 overflow-hidden" aria-hidden>
            {[{ top: 10, dur: 19, delay: 0, size: 30 }, { top: 46, dur: 26, delay: -9, size: 22 }, { top: 26, dur: 32, delay: -20, size: 18 }].map((b, i) => (
              <span key={i} className="tb-bird" style={{ top: b.top, animationDuration: `${b.dur}s`, animationDelay: `${b.delay}s` }}>
                <svg viewBox="0 0 40 16" width={b.size} height={b.size * 0.4}><path d="M2 12 Q11 1 20 10 Q29 1 38 12" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity=".85" /></svg>
              </span>
            ))}
          </div>
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 pb-16 pt-24 md:flex-row md:items-end md:justify-between">
            <div data-reveal="left">
              <h2 className="max-w-xl text-4xl font-extrabold leading-tight sm:text-5xl">¿Lo querés para tu balneario?</h2>
              <p className="mt-3 max-w-md text-white/80">Escribinos y te ayudamos a cargar tus carpas y tus tarifas.</p>
              <CopyEmailButton email={SITE_EMAIL} className="mt-5 inline-flex items-center gap-2 text-lg font-bold underline decoration-[var(--sol)] decoration-2 underline-offset-4">
                <Icon d="M4 6h16v12H4zM4 7l8 6 8-6" />{SITE_EMAIL}
              </CopyEmailButton>
              <a href={SITE_INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" className="mt-3 flex w-fit items-center gap-2 text-lg font-bold underline decoration-[var(--sol)] decoration-2 underline-offset-4">
                <InstagramIcon />@{SITE_INSTAGRAM}
              </a>
            </div>
            <span data-reveal="right" style={dl(200)}><DemoButton className="tb-shine tb-press rounded-full bg-[var(--sol)] px-8 text-[#13252e] hover:brightness-105" /></span>
          </div>
        </section>
      </main>

      <footer className="bg-[var(--tinta)] text-white/70">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm">
          <span className="flex items-center gap-2"><img src="/logo.png" alt="" className="h-6 w-6" /> Mi Balneario, hecho en Argentina</span>
          <span className="flex flex-wrap gap-x-5 gap-y-2">
            <LoginLink className="hover:text-white" />
            <a href="/terminos" className="hover:text-white">Términos</a>
            <a href="/privacidad" className="hover:text-white">Privacidad</a>
            <CopyEmailButton email={SITE_EMAIL} className="hover:text-white">Contacto</CopyEmailButton>
            <a href={SITE_INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:text-white"><InstagramIcon className="h-4 w-4" />Instagram</a>
          </span>
        </div>
      </footer>

      {/* Botón flotante de WhatsApp (aparece cuando está cargado el número) */}
      {SITE_WHATSAPP_URL && (
        <a href={SITE_WHATSAPP_URL} target="_blank" rel="noopener noreferrer" aria-label="Escribinos por WhatsApp"
          className="tb-ping fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[#25d366] text-white shadow-[0_10px_30px_-8px_rgba(0,0,0,.45)] transition hover:scale-105">
          <WhatsAppIcon className="h-8 w-8" />
        </a>
      )}
      <ScrollReveal />
      <Analytics />
    </div>
  );
}
