import type { Metadata } from "next";
import { SITE_EMAIL } from "@/lib/site";
import { DemoButton, DemoEndedNotice, LoginLink, MobileMenu } from "@/components/landing";

export const metadata: Metadata = {
  title: "Tu Balneario · Sistema de gestión para balnearios",
  description:
    "Reservas por fecha, mapa de carpas y sombrillas, cobros, señas, deudas, caja diaria, clientes, tarifas, WhatsApp y copias de seguridad. Desde la computadora o el celular.",
};

const NAV = [
  { href: "#funciones", label: "Funciones" },
  { href: "#como", label: "Cómo empezar" },
  { href: "#planes", label: "Planes" },
  { href: "#preguntas", label: "Preguntas" },
  { href: "#contacto", label: "Contacto" },
];

type Feature = { title: string; text: string; icon: string };
const GROUPS: { title: string; lead: string; items: Feature[] }[] = [
  {
    title: "El día a día del balneario",
    lead: "Todo lo que pasa en la playa, en una sola pantalla.",
    items: [
      { title: "Mapa del balneario", icon: "M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
        text: "Tu playa vista desde arriba: mar, arena, carpas y sombrillas. Cada lugar muestra si está libre, ocupado (con el apellido del cliente), por llegar o en mantenimiento. Lo armás arrastrando con el mouse y le elegís el diseño a las carpas." },
      { title: "Reservas por fecha", icon: "M6 3h12v18l-6-4-6 4z",
        text: "La disponibilidad se calcula día por día. Si la carpa que pide el cliente está ocupada algunos días, el sistema te muestra alternativas reales y decidís vos. Nunca se cambia nada solo." },
      { title: "Disponibilidad y calendario", icon: "M8 3v3M16 3v3M4 8h16M5 5h14v15H5z",
        text: "Una grilla con todas las carpas y sombrillas y los días que elijas. Buscás por nombre o apellido y ves de un vistazo qué está libre." },
      { title: "Cambios de carpa", icon: "M7 7h11l-3-3M17 17H6l3 3",
        text: "Por un solo día o por el resto de la estadía, sin crear otra reserva y sin tocar pagos ni deudas. Cualquier cambio se puede deshacer desde el historial." },
      { title: "Llegó / no vino", icon: "M20 6L9 17l-5-5",
        text: "Marcás quién llegó. Si alguien de un solo día no vino, la carpa se libera en el momento. Si la estadía es larga, liberás el día y, si querés, se lo descontás." },
      { title: "Clima, viento y sol", icon: "M12 3v1M12 20v1M4.2 4.2l.7.7M19.1 19.1l.7.7M3 12h1M20 12h1M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z",
        text: "Temperatura, lluvia y viento actualizados, con brújula y el recorrido del sol sobre tu playa. Para ubicar a quien quiere sombra o reparo del viento." },
      { title: "Notas del día", icon: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5",
        text: "Avisos para el personal (\"hoy viene el proveedor de hielo\") que se ven en todas las computadoras y celulares." },
      { title: "Mantenimiento", icon: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z",
        text: "Bloqueás una carpa por arreglos y nadie la puede reservar esos días. Si choca con una reserva, el sistema te avisa." },
    ],
  },
  {
    title: "La plata, bajo control",
    lead: "Lo contratado y lo cobrado, siempre separados y exactos.",
    items: [
      { title: "Cobros, señas y deudas", icon: "M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3S9.5 10.5 12 11s4.5 1.3 4.5 3-2 3-4.5 3-4.5-1.3-4.5-3",
        text: "Pago completo, seña, pagos parciales o cobrar después. Efectivo, transferencia, débito, crédito, Mercado Pago y dólares con la cotización del Banco Nación. El saldo siempre es un número exacto." },
      { title: "Caja diaria", icon: "M3 7h18v12H3zM3 11h18M7 15h3",
        text: "Apertura, gastos, cierre y diferencia con lo contado. Solo el efectivo suma a la caja física. Al final del día, un ticket con los cobros con tarjeta para comparar con el posnet." },
      { title: "Tarifario, convenios y descuentos", icon: "M20 12l-8 8-9-9V3h8l9 9zM7.5 7.5h.01",
        text: "Precios por quincena, mes y temporada, descuento por efectivo, convenios y cortesías familiares. Cada reserva guarda el precio con el que se contrató." },
      { title: "Devoluciones y vouchers", icon: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
        text: "Devolvés en efectivo o con un voucher para el restaurante. Nada se borra: cada corrección queda registrada." },
      { title: "Informes y Excel", icon: "M4 20V10M10 20V4M16 20v-7M22 20H2",
        text: "Ocupación, ingresos contratados y cobrados, deudas, gastos, diferencias de caja y clientes frecuentes. Se exportan a Excel." },
    ],
  },
  {
    title: "Clientes y WhatsApp",
    lead: "Que nadie se olvide de pagar y que los de siempre vuelvan.",
    items: [
      { title: "Clientes con historial", icon: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
        text: "Cada cliente con sus temporadas, carpas, pagos y deudas. Lo das de alta desde la misma reserva, sin salir de la pantalla." },
      { title: "Recordatorios por WhatsApp", icon: "M21 12a9 9 0 0 1-13.3 7.9L3 21l1.1-4.7A9 9 0 1 1 21 12z",
        text: "El sistema te avisa quién termina con deuda y te deja el mensaje escrito. Lo retocás si querés y lo mandás desde tu WhatsApp, sin servicios pagos." },
      { title: "Presupuestos en un toque", icon: "M9 7h6M9 11h6M9 15h3M5 3h14v18H5z",
        text: "¿Solo pregunta el precio? Calculás el total exacto (y cuánto queda pagando en efectivo) y se lo mandás sin reservar nada." },
      { title: "Renovación de temporada", icon: "M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5",
        text: "La lista de los clientes del año pasado con su carpa de siempre, para ofrecérsela antes que a nadie. Te avisa si ya reservaron o si su lugar ya está tomado." },
    ],
  },
  {
    title: "Tus datos, seguros",
    lead: "Un sistema pensado para usarse todos los días de la temporada.",
    items: [
      { title: "Desde cualquier dispositivo", icon: "M4 5h16v11H4zM2 19h20M9 16v3M15 16v3",
        text: "Computadora, notebook o celular. Una reserva cargada en una aparece al instante en las demás. Se puede instalar como app en el celular." },
      { title: "Sin reservas duplicadas", icon: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z",
        text: "Si dos personas reservan la misma carpa al mismo tiempo, el sistema lo impide. Los pagos tampoco se duplican aunque se corte internet." },
      { title: "Historial de todo", icon: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
        text: "Quién hizo cada cambio y cuándo: reservas, pagos, tarifas, caja. Nada se borra a escondidas." },
      { title: "Copias de seguridad", icon: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6",
        text: "Copias automáticas todos los días en tu Google Drive, copias manuales y restauración con confirmación." },
      { title: "Varios usuarios", icon: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M21 19v-1a4 4 0 0 0-3-3.9",
        text: "Dueño, administradores y empleados, cada uno con su usuario. Ingreso con Google o con usuario y contraseña." },
    ],
  },
];

const STEPS = [
  { n: "1", title: "Probá la demo", text: "Entrás a un balneario de prueba con datos inventados y tocás todo lo que quieras. No hace falta registrarse." },
  { n: "2", title: "Creá tu balneario", text: "Te registrás con Google, ponés el nombre y cuántas carpas y sombrillas tenés. El sistema arma el mapa para que lo acomodes." },
  { n: "3", title: "Cargá tus tarifas y empezá", text: "Ponés los precios de la temporada y ya podés tomar reservas, cobrar y abrir la caja." },
];

/**
 * Planes: todavía sin definir. Cuando estén, completar nombre, precio y lo que incluye cada uno
 * (si "items" queda vacío se muestra "Próximamente").
 */
const PLANS: { name: string; price: string | null; note: string; items: string[]; highlight?: boolean }[] = [
  { name: "Plan 1", price: null, note: "Próximamente", items: [] },
  { name: "Plan 2", price: null, note: "Próximamente", items: [], highlight: true },
];

const FAQ = [
  { q: "¿Tengo que instalar algo?", a: "No. Funciona desde el navegador (Chrome, Edge, Safari) en la computadora o en el celular. Si querés, en el celular lo agregás a la pantalla de inicio y se abre como una app." },
  { q: "¿Qué pasa con lo que cargo en la demo?", a: "La demo es un balneario de prueba solo para vos. Cuando salís o cerrás la pestaña se borra todo. Para guardar de verdad, creá tu balneario." },
  { q: "¿Mis datos y los de mis clientes están seguros?", a: "Cada balneario ve solo sus datos. La información se guarda en una base de datos protegida, no en tu computadora, y podés tener copias diarias en tu propio Google Drive." },
  { q: "¿Lo pueden usar mis empleados?", a: "Sí. Cada uno con su usuario, desde su celular o la compu del balneario, y todos ven lo mismo al instante." },
  { q: "¿Y si se corta internet?", a: "El sistema necesita internet para guardar. Si se corta, te avisa y no muestra datos viejos como si fueran los de ahora, así nunca reservás algo que ya está ocupado." },
  { q: "¿Cuánto cuesta?", a: `Mirá la sección Planes más arriba o escribinos a ${SITE_EMAIL}.` },
];

function Icon({ d, className = "h-5 w-5" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={d} />
    </svg>
  );
}

/** Dibujo del plano: mar, arena y carpas con sus estados (como en el sistema). */
function BeachPreview() {
  const S = { libre: "var(--st-disponible)", ocupada: "var(--st-ocupada)", futura: "var(--st-futura)", mant: "var(--st-mantenimiento)", cortesia: "var(--st-cortesia)" };
  const rows: (keyof typeof S)[][] = [
    ["ocupada", "ocupada", "libre", "ocupada", "futura", "ocupada", "libre"],
    ["libre", "ocupada", "ocupada", "libre", "ocupada", "cortesia", "ocupada"],
    ["ocupada", "libre", "mant", "ocupada", "libre", "ocupada", "futura"],
  ];
  const names = ["Pérez", "Gómez", "", "Sosa", "", "Díaz", ""];
  return (
    <svg viewBox="0 0 400 300" className="h-auto w-full" role="img" aria-label="Ejemplo del mapa del balneario con carpas libres, ocupadas y reservadas">
      <defs>
        <pattern id="arena" width="10" height="10" patternUnits="userSpaceOnUse">
          <rect width="10" height="10" fill="var(--sand)" />
          <circle cx="2" cy="3" r="0.8" fill="var(--sand-dot)" />
          <circle cx="7" cy="8" r="0.6" fill="var(--sand-dot)" />
        </pattern>
      </defs>
      <rect width="400" height="300" rx="18" fill="url(#arena)" />
      <path d="M0 18 Q0 0 18 0 H382 Q400 0 400 18 V62 Q350 76 300 64 T200 64 T100 64 T0 66 Z" fill="var(--sea)" />
      <path d="M0 66 Q50 54 100 64 T200 64 T300 64 T400 62" fill="none" stroke="var(--foam)" strokeWidth="4" strokeLinecap="round" opacity="0.9" />
      <path d="M30 30 q10 -6 20 0 M120 22 q10 -6 20 0 M250 34 q10 -6 20 0 M340 20 q10 -6 20 0" stroke="var(--foam)" strokeWidth="2" fill="none" opacity="0.6" />
      <rect x="0" y="182" width="400" height="16" fill="var(--path)" />
      {rows.map((row, ri) => row.map((st, ci) => {
        const x = 26 + ci * 52;
        const y = ri < 2 ? 88 + ri * 48 : 210;
        const n = ri * 7 + ci + 1;
        const full = st === "ocupada" || st === "cortesia" || st === "futura";
        return (
          <g key={`${ri}-${ci}`}>
            <rect x={x} y={y} width="40" height="36" rx="6" fill={full ? S[st] : "#ffffff"} stroke={S[st]} strokeWidth="3" />
            {!full && <path d={`M${x + 4} ${y + 30} L${x + 36} ${y + 6}`} stroke={S[st]} strokeWidth="2" opacity="0.35" />}
            <text x={x + 20} y={y + (ri === 0 && names[ci] && st === "ocupada" ? 16 : 23)} textAnchor="middle" fontSize="12" fontWeight="700" fill={full ? "#fff" : "#1c2830"}>{n}</text>
            {ri === 0 && names[ci] && st === "ocupada" && <text x={x + 20} y={y + 29} textAnchor="middle" fontSize="7.5" fontWeight="600" fill="#fff">{names[ci]}</text>}
          </g>
        );
      }))}
      <g>
        <circle cx="355" cy="262" r="15" fill="#fff" opacity="0.9" />
        <circle cx="355" cy="262" r="6" fill="var(--st-futura)" />
        <path d="M355 243v-4M355 285v-4M336 262h-4M378 262h-4" stroke="var(--st-futura)" strokeWidth="2" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function Legend() {
  const items = [
    ["var(--st-disponible)", "Libre"], ["var(--st-ocupada)", "Ocupada"], ["var(--st-futura)", "Llega mañana"],
    ["var(--st-mantenimiento)", "Mantenimiento"], ["var(--st-cortesia)", "Cortesía"],
  ];
  return (
    <ul className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted">
      {items.map(([c, l]) => <li key={l} className="flex items-center gap-1.5"><span className="h-3 w-3 rounded" style={{ background: c }} />{l}</li>)}
    </ul>
  );
}

export default function InicioPage() {
  return (
    <div className="min-h-dvh bg-bg text-fg">
      {/* Encabezado */}
      <header className="sticky top-0 z-40 border-b border-line bg-surface/90 backdrop-blur">
        <div className="relative mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <a href="#arriba" className="flex items-center gap-2 font-extrabold tracking-tight">
            <img src="/logo.png" alt="" className="h-9 w-9" />
            <span className="text-lg">Tu Balneario</span>
          </a>
          <nav className="hidden items-center gap-6 text-sm font-medium md:flex">
            {NAV.map((l) => <a key={l.href} href={l.href} className="text-muted hover:text-fg">{l.label}</a>)}
          </nav>
          <div className="flex items-center gap-2">
            <LoginLink className="rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold hover:bg-surface-2" />
            <MobileMenu links={NAV} />
          </div>
        </div>
      </header>
      <DemoEndedNotice />

      <main id="arriba">
        {/* Portada */}
        <section className="relative overflow-hidden">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-[var(--accent-soft)] to-transparent" aria-hidden />
          <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-12 md:grid-cols-2 md:pt-20">
            <div>
              <p className="mb-3 inline-block rounded-full border border-line bg-surface px-3 py-1 text-xs font-semibold text-accent">Sistema de gestión para balnearios</p>
              <h1 className="text-4xl font-extrabold leading-tight tracking-tight md:text-5xl">
                Tu balneario,<br />ordenado y en un solo lugar.
              </h1>
              <p className="mt-4 max-w-xl text-lg text-muted">
                Reservas, mapa de carpas y sombrillas, cobros, deudas y caja diaria. Desde la computadora o el celular,
                con todo sincronizado al instante.
              </p>
              <div className="mt-7 flex flex-wrap items-start gap-3">
                <DemoButton className="bg-accent text-accent-fg shadow-sm hover:opacity-90" />
                <a href="#planes" className="inline-flex items-center justify-center rounded-xl border border-line bg-surface px-5 py-3 text-base font-semibold hover:bg-surface-2">
                  Crear mi balneario
                </a>
              </div>
              <p className="mt-3 text-sm text-muted">La demo es un balneario de prueba con datos inventados. No hace falta registrarse.</p>
            </div>
            <div className="rounded-3xl border border-line bg-surface p-4 shadow-xl">
              <BeachPreview />
              <Legend />
            </div>
          </div>
        </section>

        {/* Resumen */}
        <section className="border-y border-line bg-surface">
          <ul className="mx-auto grid max-w-6xl grid-cols-2 gap-6 px-4 py-8 text-center md:grid-cols-4">
            {[
              ["Reservas por día", "sin superposiciones"],
              ["Saldo exacto", "de cada cliente"],
              ["Caja diaria", "con cierre y diferencias"],
              ["Todo sincronizado", "en compu y celular"],
            ].map(([a, b]) => (
              <li key={a}><div className="text-lg font-bold">{a}</div><div className="text-sm text-muted">{b}</div></li>
            ))}
          </ul>
        </section>

        {/* Funciones */}
        <section id="funciones" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16">
          <h2 className="text-center text-3xl font-extrabold tracking-tight">Todo lo que hace Tu Balneario</h2>
          <p className="mx-auto mt-2 max-w-2xl text-center text-muted">Pensado para el trabajo de todos los días de la temporada, en la computadora o en el celular.</p>
          {GROUPS.map((g) => (
            <div key={g.title} className="mt-12">
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2">
                <h3 className="text-xl font-bold">{g.title}</h3>
                <p className="text-sm text-muted">{g.lead}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {g.items.map((f) => (
                  <article key={f.title} className="rounded-2xl border border-line bg-surface p-5">
                    <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent"><Icon d={f.icon} /></span>
                    <h4 className="font-bold">{f.title}</h4>
                    <p className="mt-1 text-sm leading-relaxed text-muted">{f.text}</p>
                  </article>
                ))}
              </div>
            </div>
          ))}
        </section>

        {/* Demo */}
        <section className="bg-[var(--sea-deep)] text-white">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-14 md:flex-row md:items-center md:justify-between">
            <div className="max-w-2xl">
              <h2 className="text-3xl font-extrabold tracking-tight">Probalo ahora, sin registrarte</h2>
              <p className="mt-2 text-white/85">
                La demo abre un balneario de prueba con carpas, clientes y reservas inventadas. Hacé reservas, cobrá, abrí la caja,
                mové carpas en el mapa. Cuando salís, se borra todo.
              </p>
            </div>
            <DemoButton className="bg-white text-[var(--sea-deep)] shadow hover:bg-white/90" />
          </div>
        </section>

        {/* Cómo empezar */}
        <section id="como" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16">
          <h2 className="text-center text-3xl font-extrabold tracking-tight">Cómo empezar</h2>
          <ol className="mt-10 grid gap-4 md:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="rounded-2xl border border-line bg-surface p-6">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-bold text-accent-fg">{s.n}</span>
                <h3 className="mt-3 font-bold">{s.title}</h3>
                <p className="mt-1 text-sm text-muted">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Planes */}
        <section id="planes" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-4xl scroll-mt-20 px-4 py-16">
            <h2 className="text-center text-3xl font-extrabold tracking-tight">Planes</h2>
            <p className="mx-auto mt-2 max-w-xl text-center text-muted">Elegí el plan para crear tu balneario. Mientras tanto, podés probar todo en la demo.</p>
            <div className="mt-10 grid gap-5 md:grid-cols-2">
              {PLANS.map((p) => (
                <article key={p.name} className={`flex flex-col rounded-2xl border bg-bg p-6 ${p.highlight ? "border-accent shadow-lg" : "border-line"}`}>
                  <h3 className="text-xl font-bold">{p.name}</h3>
                  <div className="mt-2 text-3xl font-extrabold tracking-tight">{p.price ?? <span className="text-muted">—</span>}</div>
                  <p className="mt-1 text-sm font-medium text-accent">{p.note}</p>
                  {p.items.length > 0 ? (
                    <ul className="mt-4 flex flex-col gap-2 text-sm">
                      {p.items.map((it) => <li key={it} className="flex gap-2"><Icon d="M20 6L9 17l-5-5" className="h-4 w-4 shrink-0 text-ok" />{it}</li>)}
                    </ul>
                  ) : (
                    <p className="mt-4 flex-1 rounded-xl border border-dashed border-line p-4 text-center text-sm text-muted">Pronto vas a ver acá qué incluye este plan y su precio.</p>
                  )}
                  <a href={`mailto:${SITE_EMAIL}?subject=${encodeURIComponent(`Consulta por el ${p.name} de Tu Balneario`)}`}
                    className={`mt-6 inline-flex items-center justify-center rounded-xl px-5 py-3 font-semibold ${p.highlight ? "bg-accent text-accent-fg hover:opacity-90" : "border border-line bg-surface hover:bg-surface-2"}`}>
                    Consultar
                  </a>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Preguntas */}
        <section id="preguntas" className="border-t border-line">
          <div className="mx-auto max-w-3xl scroll-mt-20 px-4 py-16">
            <h2 className="text-center text-3xl font-extrabold tracking-tight">Preguntas frecuentes</h2>
            <div className="mt-8 divide-y divide-line rounded-2xl border border-line bg-surface">
              {FAQ.map((f) => (
                <details key={f.q} className="group px-5 py-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-semibold">
                    {f.q}
                    <span className="text-muted transition group-open:rotate-45" aria-hidden>+</span>
                  </summary>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Contacto */}
        <section id="contacto" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 text-center">
          <h2 className="text-3xl font-extrabold tracking-tight">¿Querés usarlo en tu balneario?</h2>
          <p className="mx-auto mt-2 max-w-xl text-muted">Escribinos y te ayudamos a cargar tu balneario, tus carpas y tus tarifas.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <a href={`mailto:${SITE_EMAIL}`} className="inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 font-semibold text-accent-fg hover:opacity-90">
              <Icon d="M4 6h16v12H4zM4 7l8 6 8-6" />{SITE_EMAIL}
            </a>
            <DemoButton className="border border-line bg-surface hover:bg-surface-2" />
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-muted">
          <span className="flex items-center gap-2"><img src="/logo.png" alt="" className="h-6 w-6" /> Tu Balneario · Hecho en Argentina</span>
          <span className="flex gap-4">
            <LoginLink className="hover:text-fg" />
            <a href={`mailto:${SITE_EMAIL}`} className="hover:text-fg">Contacto</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
