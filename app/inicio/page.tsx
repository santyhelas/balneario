import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Bricolage_Grotesque, Figtree } from "next/font/google";
import { SITE_EMAIL, SITE_INSTAGRAM, SITE_INSTAGRAM_URL } from "@/lib/site";
import { DemoButton, DemoEndedNotice, LoginLink, MobileMenu } from "@/components/landing";
import { DayTimeline, HeroBeach, PhotoStrip, Slider, type DayStep } from "@/components/landing-interactive";
import "./landing.css";

const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--tb-display", weight: ["500", "700", "800"] });
const body = Figtree({ subsets: ["latin"], variable: "--tb-body", weight: ["400", "500", "600", "700"] });

export const metadata: Metadata = {
  title: "Tu Balneario · Sistema de gestión para balnearios",
  description:
    "Reservas por fecha, mapa de carpas y sombrillas, cobros, señas, deudas, caja diaria, clientes, tarifas, WhatsApp y copias de seguridad. Desde la computadora o el celular.",
};

const NAV = [
  { href: "#un-dia", label: "Cómo se usa" },
  { href: "#funciones", label: "Funciones" },
  { href: "#planes", label: "Planes" },
  { href: "#preguntas", label: "Preguntas" },
];

/**
 * Fotos reales: poné los archivos en public/landing/ y agregalos acá ({ src: "/landing/playa.jpg", caption: "…" }).
 * Mientras esté vacía se muestran las postales dibujadas.
 */
const PHOTOS: { src: string; caption: string }[] = [];

/**
 * Planes: todavía sin definir. Cuando estén, completar nombre, precio y lo que incluye cada uno
 * (si "items" queda vacío se muestra "Próximamente").
 */
const PLANS: { name: string; price: string | null; note: string; items: string[]; highlight?: boolean }[] = [
  { name: "Plan 1", price: null, note: "Próximamente", items: [] },
  { name: "Plan 2", price: null, note: "Próximamente", items: [], highlight: true },
];

const FAQ = [
  { q: "¿Tengo que instalar algo?", a: "No. Funciona desde el navegador (Chrome, Edge, Safari) en la computadora o en el celular. En el celular lo podés agregar a la pantalla de inicio y se abre como una app." },
  { q: "¿Qué pasa con lo que cargo en la demo?", a: "La demo es un balneario de prueba solo para vos. Cuando salís o cerrás la pestaña se borra todo." },
  { q: "¿Mis datos y los de mis clientes están seguros?", a: "Cada balneario ve solo sus datos. Todo se guarda en una base de datos protegida, no en tu computadora, y podés tener una copia diaria en tu propio Google Drive." },
  { q: "¿Lo pueden usar mis empleados?", a: "Sí. Cada uno con su usuario, desde su celular o la compu del balneario, y todos ven lo mismo al instante." },
  { q: "¿Y si se corta internet?", a: "Para guardar hace falta internet. Si se corta, el sistema te avisa y no te muestra datos viejos como si fueran los de ahora, así no reservás algo que ya está ocupado." },
  { q: "¿Cuánto cuesta?", a: `Mirá la sección Planes o escribinos a ${SITE_EMAIL}.` },
];

/** Ícono de Instagram (dibujo simple de cámara). */
function InstagramIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} className={className} aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1" fill="currentColor" />
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

function GroupSlide({ g }: { g: (typeof GROUPS)[number] }) {
  return (
    <article className="h-full overflow-hidden rounded-[28px] bg-white ring-1 ring-[var(--sand-2)]">
      <div className="relative px-6 pb-8 pt-7 text-white" style={{ background: g.color }}>
        <svg viewBox="0 0 400 40" preserveAspectRatio="none" className="absolute inset-x-0 -bottom-px h-6 w-full" aria-hidden>
          <path d="M0 40 V20 Q50 0 100 20 T200 20 T300 20 T400 20 V40 Z" fill="#fff" />
        </svg>
        <h3 className="text-3xl font-extrabold">{g.title}</h3>
        <p className="mt-1 text-white/85">{g.lead}</p>
      </div>
      <ul className="grid gap-5 px-6 pb-7 pt-3 sm:grid-cols-2">
        {g.items.map((f) => (
          <li key={f.title}>
            <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-2xl" style={{ background: `color-mix(in srgb, ${g.color} 13%, white)`, color: g.color }}><Icon d={f.icon} /></span>
            <h4 className="font-bold">{f.title}</h4>
            <p className="mt-0.5 text-sm leading-relaxed text-[var(--gris)]">{f.text}</p>
          </li>
        ))}
      </ul>
    </article>
  );
}

/* ---------------- Postales dibujadas (hasta tener fotos reales) ---------------- */

type Kind = "amanecer" | "carpas" | "sombrillas" | "mediodia" | "atardecer";
function Postcard({ kind }: { kind: Kind }) {
  const sky = { amanecer: ["#ffd8a8", "#ffefd6"], carpas: ["#8fd0e6", "#dff3f8"], sombrillas: ["#7cc3df", "#d7eff6"], mediodia: ["#5fb4d8", "#cbe9f4"], atardecer: ["#f59e6b", "#fcd9a8"] }[kind];
  const sea = kind === "atardecer" ? "#3c6f8f" : kind === "amanecer" ? "#5f9fbd" : "#1e7fa8";
  return (
    <svg viewBox="0 0 320 240" className="h-full w-full" aria-hidden>
      <defs>
        <linearGradient id={`s-${kind}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={sky[0]} /><stop offset="1" stopColor={sky[1]} /></linearGradient>
      </defs>
      <rect width="320" height="240" fill={`url(#s-${kind})`} />
      {(kind === "amanecer" || kind === "atardecer") && <circle cx={kind === "amanecer" ? 90 : 230} cy="108" r="30" fill={kind === "amanecer" ? "#ffb347" : "#f4663f"} opacity="0.95" />}
      {(kind === "mediodia" || kind === "carpas") && <circle cx="262" cy="42" r="18" fill="#ffd34d" />}
      <rect y="112" width="320" height="46" fill={sea} />
      <path d="M0 158 Q40 148 80 158 T160 158 T240 158 T320 158 V240 H0 Z" fill="#f1dfb6" />
      <path d="M0 158 Q40 148 80 158 T160 158 T240 158 T320 158" fill="none" stroke="#fff" strokeWidth="3" opacity="0.85" />
      {kind === "carpas" && [0, 1, 2, 3, 4].map((k) => (
        <g key={k} transform={`translate(${18 + k * 60} 178)`}>
          <rect width="48" height="40" fill="#fff" />
          {[0, 1, 2].map((s) => <rect key={s} x={s * 16} width="8" height="40" fill={k % 2 ? "#1e7fa8" : "#d6332f"} />)}
          <path d="M-4 0 L24 -14 L52 0 Z" fill={k % 2 ? "#1e7fa8" : "#d6332f"} />
        </g>
      ))}
      {kind === "sombrillas" && [0, 1, 2, 3].map((k) => (
        <g key={k} transform={`translate(${45 + k * 75} ${176 + (k % 2) * 16})`}>
          <line x1="0" y1="0" x2="0" y2="34" stroke="#7a5b2e" strokeWidth="3" />
          <path d="M-30 2 Q0 -26 30 2 Z" fill={["#f2b233", "#d6332f", "#0b4f6c", "#2f9e5b"][k]} />
          <ellipse cx="0" cy="40" rx="22" ry="5" fill="#000" opacity="0.08" />
        </g>
      ))}
      {kind === "mediodia" && (
        <g>
          {[0, 1, 2, 3, 4, 5].map((k) => <rect key={k} x={20 + k * 50} y={180 + (k % 2) * 14} width="34" height="22" rx="4" fill={k === 2 ? "#2f9e5b" : "#d6332f"} />)}
          <rect x="0" y="222" width="320" height="10" fill="#e9dcc0" />
        </g>
      )}
      {kind === "amanecer" && (
        <g>
          {[0, 1, 2].map((k) => <rect key={k} x={170 + k * 46} y="186" width="36" height="28" rx="3" fill="#fff" stroke="#d6332f" strokeWidth="2" />)}
        </g>
      )}
      {kind === "atardecer" && (
        <g fill="#5b3a2a" opacity="0.75">
          <rect x="40" y="186" width="40" height="30" /><rect x="96" y="186" width="40" height="30" /><rect x="152" y="186" width="40" height="30" />
          <path d="M36 186 L60 172 L84 186 Z M92 186 L116 172 L140 186 Z M148 186 L172 172 L196 186 Z" />
        </g>
      )}
    </svg>
  );
}

const POSTCARDS: { key: string; caption: string; node: ReactNode }[] = PHOTOS.length
  // eslint-disable-next-line @next/next/no-img-element
  ? PHOTOS.map((p) => ({ key: p.src, caption: p.caption, node: <img src={p.src} alt={p.caption} className="h-full w-full object-cover" /> }))
  : [
      { key: "amanecer", caption: "Temprano, se arma la playa", node: <Postcard kind="amanecer" /> },
      { key: "carpas", caption: "Las carpas de siempre", node: <Postcard kind="carpas" /> },
      { key: "sombrillas", caption: "Sombrillas en primera fila", node: <Postcard kind="sombrillas" /> },
      { key: "mediodia", caption: "Enero a pleno", node: <Postcard kind="mediodia" /> },
      { key: "atardecer", caption: "Al atardecer, cierre de caja", node: <Postcard kind="atardecer" /> },
    ];

export default function InicioPage() {
  return (
    <div className={`tb ${display.variable} ${body.variable} min-h-dvh`}>
      <header className="sticky top-0 z-40 bg-[#fbf7ee]/90 backdrop-blur">
        <div className="relative mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <a href="#arriba" className="flex items-center gap-2.5">
            <img src="/logo.png" alt="" className="h-10 w-10" />
            <span className="display text-xl font-extrabold">Tu Balneario</span>
          </a>
          <nav className="hidden items-center gap-7 text-[15px] font-semibold md:flex">
            {NAV.map((l) => <a key={l.href} href={l.href} className="text-[var(--gris)] hover:text-[var(--atl)]">{l.label}</a>)}
          </nav>
          <div className="flex items-center gap-2">
            <LoginLink className="rounded-full bg-[var(--atl)] px-5 py-2.5 text-sm font-bold text-white hover:bg-[var(--atl-2)]" />
            <MobileMenu links={NAV} />
          </div>
        </div>
      </header>
      <DemoEndedNotice />

      <main id="arriba">
        {/* Portada: el plano del balneario, que se puede tocar */}
        <section className="relative overflow-hidden">
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-14 pt-8 lg:grid-cols-[0.9fr_1.1fr] lg:pt-14">
            <div>
              <h1 className="text-[2.5rem] font-extrabold leading-[1.03] sm:text-6xl">
                Tu balneario entero, en un mapa que sabe quién está en cada carpa.
              </h1>
              <p className="mt-5 max-w-lg text-lg leading-relaxed text-[var(--gris)]">
                Elegí un día y mirá qué está libre. Tocá una carpa y ves quién la tiene, hasta cuándo y si pagó.
                Reservas, cobros, deudas y caja, desde la compu o el celular.
              </p>
              <div className="mt-8 flex flex-wrap items-start gap-3">
                <DemoButton className="rounded-full bg-[var(--lona)] px-7 text-white shadow-[0_10px_25px_-10px_rgba(214,51,47,0.8)] hover:brightness-110" />
                <a href="#planes" className="inline-flex items-center justify-center rounded-full border-2 border-[var(--atl)] px-7 py-3 text-base font-bold text-[var(--atl)] hover:bg-[var(--atl)] hover:text-white">
                  Crear mi balneario
                </a>
              </div>
              <p className="mt-3 text-sm text-[var(--gris)]">La demo abre un balneario de prueba con datos inventados. No hace falta registrarse.</p>
            </div>
            <HeroBeach />
          </div>
        </section>

        {/* Postales que pasan solas */}
        <section className="pb-16" aria-label="La temporada">
          <PhotoStrip items={POSTCARDS} />
        </section>

        {/* Un día en el balneario */}
        <section id="un-dia" className="scroll-mt-16 bg-[var(--atl)] text-white">
          <div className="mx-auto max-w-6xl px-4 py-20">
            <h2 className="max-w-2xl text-4xl font-extrabold leading-tight sm:text-5xl">Un día de enero, de la apertura al cierre.</h2>
            <p className="mt-3 max-w-xl text-white/75">Así se usa Tu Balneario en una jornada normal de temporada.</p>
            <div className="mt-12">
              <DayTimeline steps={STEPS} />
            </div>
          </div>
        </section>

        {/* Funciones */}
        <section id="funciones" className="scroll-mt-16 overflow-hidden">
          <div className="mx-auto max-w-6xl px-4 py-20">
            <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
              <h2 className="max-w-xl text-4xl font-extrabold leading-tight sm:text-5xl">Todo lo que hace, en cuatro partes.</h2>
              <p className="max-w-sm text-[var(--gris)]">Deslizá para ver cada una. También podés probarlas todas en la demo.</p>
            </div>
            <Slider label="Funciones del sistema" slides={GROUPS.map((g) => ({ key: g.key, node: <GroupSlide g={g} /> }))} />
          </div>
        </section>

        {/* Cómo empezar: es un paso a paso real */}
        <section className="bg-[var(--sand)]">
          <div className="mx-auto max-w-6xl px-4 py-20">
            <h2 className="text-4xl font-extrabold sm:text-5xl">Empezar lleva una tarde.</h2>
            <ol className="mt-10 grid gap-8 md:grid-cols-3">
              {[
                ["Probá la demo", "Tocá todo en un balneario de prueba. No hace falta registrarse."],
                ["Creá tu balneario", "Ponés el nombre y cuántas carpas y sombrillas tenés. El mapa se arma solo y lo acomodás arrastrando."],
                ["Cargá tus precios", "Ponés las tarifas de la temporada y ya podés reservar, cobrar y abrir la caja."],
              ].map(([t, x], k) => (
                <li key={t} className="relative pl-14">
                  <span className="display absolute left-0 top-0 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--atl)] text-lg font-extrabold text-white">{k + 1}</span>
                  <h3 className="text-xl font-bold">{t}</h3>
                  <p className="mt-1 text-[var(--gris)]">{x}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Planes */}
        <section id="planes" className="scroll-mt-16">
          <div className="mx-auto max-w-4xl px-4 py-20">
            <h2 className="text-center text-4xl font-extrabold sm:text-5xl">Planes</h2>
            <p className="mx-auto mt-3 max-w-md text-center text-[var(--gris)]">Elegí el plan para crear tu balneario. Mientras tanto, probá todo en la demo.</p>
            <div className="mt-10 grid gap-6 md:grid-cols-2">
              {PLANS.map((p) => (
                <article key={p.name} className={`flex flex-col rounded-[28px] p-7 ${p.highlight ? "bg-[var(--atl)] text-white shadow-xl" : "bg-white ring-1 ring-[var(--sand-2)]"}`}>
                  <h3 className="text-2xl font-extrabold">{p.name}</h3>
                  <div className="display mt-3 text-4xl font-extrabold">{p.price ?? "—"}</div>
                  <p className={`mt-1 font-semibold ${p.highlight ? "text-[var(--sol)]" : "text-[var(--atl-2)]"}`}>{p.note}</p>
                  {p.items.length > 0 ? (
                    <ul className="mt-5 flex flex-col gap-2 text-sm">
                      {p.items.map((it) => <li key={it} className="flex gap-2"><Icon d="M20 6L9 17l-5-5" className="h-4 w-4 shrink-0" />{it}</li>)}
                    </ul>
                  ) : (
                    <p className={`mt-5 flex-1 rounded-2xl border-2 border-dashed p-4 text-center text-sm ${p.highlight ? "border-white/30 text-white/80" : "border-[var(--sand-2)] text-[var(--gris)]"}`}>
                      Pronto vas a ver acá qué incluye este plan y su precio.
                    </p>
                  )}
                  <a href={`mailto:${SITE_EMAIL}?subject=${encodeURIComponent(`Consulta por el ${p.name} de Tu Balneario`)}`}
                    className={`mt-6 inline-flex items-center justify-center rounded-full px-5 py-3 font-bold ${p.highlight ? "bg-white text-[var(--atl)] hover:bg-[var(--foam)]" : "bg-[var(--atl)] text-white hover:bg-[var(--atl-2)]"}`}>
                    Consultar
                  </a>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Preguntas */}
        <section id="preguntas" className="scroll-mt-16 bg-white">
          <div className="mx-auto max-w-3xl px-4 py-20">
            <h2 className="text-4xl font-extrabold sm:text-5xl">Preguntas frecuentes</h2>
            <div className="mt-8 divide-y divide-[var(--sand-2)] border-y border-[var(--sand-2)]">
              {FAQ.map((f) => (
                <details key={f.q} className="group py-5">
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
            <path d="M0 0 H1200 V30 Q1100 60 1000 30 T800 30 T600 30 T400 30 T200 30 T0 30 Z" fill="#fff" />
          </svg>
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 pb-16 pt-24 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="max-w-xl text-4xl font-extrabold leading-tight sm:text-5xl">¿Lo querés para tu balneario?</h2>
              <p className="mt-3 max-w-md text-white/80">Escribinos y te ayudamos a cargar tus carpas y tus tarifas.</p>
              <a href={`mailto:${SITE_EMAIL}`} className="mt-5 inline-flex items-center gap-2 text-lg font-bold underline decoration-[var(--sol)] decoration-2 underline-offset-4">
                <Icon d="M4 6h16v12H4zM4 7l8 6 8-6" />{SITE_EMAIL}
              </a>
              <a href={SITE_INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" className="mt-3 flex w-fit items-center gap-2 text-lg font-bold underline decoration-[var(--sol)] decoration-2 underline-offset-4">
                <InstagramIcon />@{SITE_INSTAGRAM}
              </a>
            </div>
            <DemoButton className="rounded-full bg-[var(--sol)] px-8 text-[var(--tinta)] hover:brightness-105" />
          </div>
        </section>
      </main>

      <footer className="bg-[var(--tinta)] text-white/70">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm">
          <span className="flex items-center gap-2"><img src="/logo.png" alt="" className="h-6 w-6" /> Tu Balneario, hecho en Argentina</span>
          <span className="flex gap-5">
            <LoginLink className="hover:text-white" />
            <a href={`mailto:${SITE_EMAIL}`} className="hover:text-white">Contacto</a>
            <a href={SITE_INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:text-white"><InstagramIcon className="h-4 w-4" />Instagram</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
