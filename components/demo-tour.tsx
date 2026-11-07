"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { cx } from "@/components/ui";

/**
 * Recorridos guiados: difuminan la pantalla y dejan a la vista solo la parte que explican.
 * - "demo": el tutorial de la demo (modo invitado).
 * - "guia": la guía de bienvenida para el propietario de un balneario nuevo.
 */

export type Step = { path: string; sel: string | null; title: string; text: string };
export type TourId = "demo" | "guia" | "novedades";

const DEMO_STEPS: Step[] = [
  { path: "/", sel: null, title: "Bienvenido a la demo", text: "Es un balneario de prueba con clientes y reservas inventados. Te mostramos para qué sirve cada parte; después podés tocar todo lo que quieras." },
  { path: "/", sel: "panel-stats", title: "Panel del día", text: "Lo primero que ves al entrar: carpas libres y ocupadas hoy, quién llega, quién se va, lo cobrado y lo gastado. Cada recuadro te lleva a su pantalla." },
  { path: "/", sel: "semana", title: "Mañana y la semana", text: "Quién llega, quién se va o cambia de carpa mañana, y la ocupación de los próximos 7 días con el pronóstico. Desde acá le mandás el WhatsApp a quien se va debiendo." },
  { path: "/", sel: "nueva-reserva", title: "Nueva reserva", text: "El botón más usado. Elegís cliente, fechas y carpa, el sistema calcula el precio y registrás el cobro o la seña." },
  { path: "/", sel: "notas", title: "Notas del día", text: "Avisos para el personal, como «hoy viene el proveedor de hielo». Se ven en todas las computadoras y celulares y se tildan cuando están hechas." },
  { path: "/", sel: "caja-chip", title: "Estado de la caja", text: "Te muestra si la caja del día está abierta. Tocándolo vas a la caja." },
  { path: "/mapa", sel: "mapa", title: "Mapa del balneario", text: "La playa vista desde arriba. Rojo es ocupada (con el apellido), verde libre y amarillo llega mañana. Tocá una carpa para ver quién la tiene o reservarla. Con «Editar» las movés arrastrando." },
  { path: "/disponibilidad", sel: "disp-filtros", title: "Disponibilidad", text: "Todas las carpas y sombrillas, día por día. Elegí desde y hasta, filtrá por tipo o buscá por apellido. Tocá un día libre y arrancás una reserva desde ahí." },
  { path: "/reservas/nueva", sel: "nr-espacio", title: "Elegir la carpa", text: "Verde: libre todos los días. Ámbar: libre solo algunos. Si la que pide está ocupada unos días, te ofrece pasarlo a otra esos días o acortar la estadía. Vos decidís." },
  { path: "/reservas/nueva", sel: "nr-resumen", title: "Precio y presupuesto", text: "El total exacto con descuentos. Si el cliente solo pregunta, tocá «Presupuesto por WhatsApp» y se lo mandás sin reservar nada." },
  { path: "/cobros", sel: "cobros", title: "Cobros y deudas", text: "Quién debe y cuánto, primero los que terminan antes. Cobrás en efectivo, transferencia, tarjeta, Mercado Pago o dólares, y le mandás el recordatorio por WhatsApp." },
  { path: "/caja", sel: "caja", title: "Caja diaria", text: "Abrís con el efectivo inicial, registrás gastos y al cerrar contás la plata: el sistema te dice si sobra o falta. También imprimís el cierre de tarjetas." },
  { path: "/clientes", sel: "clientes", title: "Clientes", text: "Cada cliente con su historial de temporadas, carpas, pagos y deudas. Se puede descargar todo en Excel." },
  { path: "/tarifas", sel: "tarifas", title: "Tarifario", text: "Los precios por día de cada quincena, para carpas y sombrillas. Se copian de un mes a otro o de una temporada a la otra." },
  { path: "/renovacion", sel: "renovacion", title: "Renovación de temporada", text: "Los clientes del año pasado con su carpa de siempre, para ofrecérsela primero por WhatsApp. Te avisa si ya reservaron o si su lugar está tomado." },
  { path: "/reportes", sel: "reportes", title: "Reportes", text: "Ocupación, lo contratado y lo cobrado, deudas, gastos y cierres de caja, entre las fechas que elijas. Todo se descarga." },
  { path: "/historial", sel: "historial", title: "Historial", text: "Quién hizo cada cambio y cuándo. Nada se borra a escondidas, y muchos cambios se pueden deshacer." },
  { path: "/", sel: "demo", title: "¡Listo! Ahora probalo vos", text: "Hacé reservas, cobrá, abrí la caja, mové carpas. Todo se borra al salir de la demo. Podés volver a ver este tutorial con «Ver tutorial»." },
];

/** Guía de bienvenida: lo que hay que dejar listo antes de la primera reserva. */
export const GUIDE_STEPS: Step[] = [
  { path: "/", sel: null, title: "¡Bienvenido a Mi Balneario!", text: "En un par de minutos te mostramos qué dejar listo para empezar a trabajar. Podés saltearla y volver a verla cuando quieras desde Configuración." },
  { path: "/mapa", sel: "mapa", title: "1. Armá tu playa", text: "Tocá «Editar» y arrastrá las carpas y sombrillas hasta que el plano quede igual a tu balneario. Para mover varias juntas, arrastrá sobre la arena y encerralas en un recuadro (o Ctrl + clic); con Ctrl + C y Ctrl + V las copiás. Desde ahí también agregás, renombrás o desactivás espacios." },
  { path: "/tarifas", sel: "tarifas", title: "2. Cargá tus precios", text: "El precio por día de cada quincena, para carpas y sombrillas. Con eso el sistema calcula solo el total de cada reserva. Se copian de un mes a otro. En «Convenios y descuentos» elegís cómo se combinan los descuentos y un tope máximo." },
  { path: "/configuracion", sel: "config-balneario", title: "3. Tus datos y ubicación", text: "Nombre, logo y la ubicación de tu playa: con ella te mostramos el clima, el viento y el sol en el mapa." },
  { path: "/configuracion", sel: "config-extras", title: "4. Extras (opcional)", text: "Si cobrás reposeras, estacionamiento, heladera u otra cosa aparte, cargalos acá con su precio. Después los sumás a cada reserva con un toque." },
  { path: "/configuracion", sel: "config-usuarios", title: "5. Sumá a tu equipo", text: "Invitá a quienes trabajan con vos. Un operador reserva y cobra; un administrador además cambia precios y descuentos." },
  { path: "/configuracion", sel: "config-mensajes", title: "6. Tus mensajes de WhatsApp y mail", text: "Los recordatorios de deuda salen con este texto, que puede llevar el total, la seña y otros datos del cliente. En la pestaña «Correo» armás el mail, que sale desde tu cuenta." },
  { path: "/caja", sel: "caja", title: "7. La caja de cada día", text: "Cada mañana abrís la caja con el efectivo inicial y a la noche la cerrás contando la plata. El sistema te dice si sobra o falta. En Configuración podés poner un límite de efectivo: si se pasa, te avisa que hagas un depósito." },
  { path: "/", sel: "nueva-reserva", title: "8. Tu primera reserva", text: "Cuando tengas el plano y los precios, tocá acá: elegís cliente, fechas y carpa, y registrás el cobro o la seña." },
  { path: "/", sel: null, title: "¡Listo para arrancar!", text: "Si te trabás con algo, escribinos por WhatsApp. Para ver esta guía otra vez: Configuración → «Ver la guía de nuevo»." },
];

/** Lo nuevo de esta versión: se muestra solo en la demo, con el botón «Novedades». */
export const NEWS_STEPS: Step[] = [
  { path: "/", sel: null, title: "Novedades de Mi Balneario", text: "Sumamos varias cosas pedidas por balnearios. En un minuto te mostramos dónde está cada una. Podés saltearlo y verlo cuando quieras con el botón «Novedades»." },
  { path: "/mapa", sel: "mapa-editar", title: "Plano: varias cosas a la vez", text: "Tocá «Editar plano». Ahora podés elegir varias carpas, sombrillas o elementos y moverlas juntas, copiarlas y pegarlas." },
  { path: "/mapa", sel: "mapa", title: "Cómo se eligen y se copian", text: "Arrastrá sobre la arena para encerrar varias en un recuadro, o usá Ctrl + clic para sumar o sacar una. Después arrastrá cualquiera y se mueven todas. Ctrl + C y Ctrl + V las copia: las carpas nuevas toman el número siguiente libre. Con el botón derecho recorrés el plano, y con «Agrandar» o «Achicar» le das lugar a un balneario más grande." },
  { path: "/convenios", sel: "convenios-modo", title: "Cómo se combinan los descuentos", text: "Vos decidís si los descuentos se aplican uno sobre otro (en cascada), se suman, o se usa solo el mayor. También podés poner un tope máximo de descuento. Los convenios ahora se pueden deshabilitar o eliminar sin tocar las reservas viejas." },
  { path: "/configuracion", sel: "config-extras", title: "Extras", text: "Reposeras, gazebo, estacionamiento o lo que cobres aparte: cargalos con su precio y sumalos a cada reserva desde su ficha. Entran en el total y en la deuda." },
  { path: "/configuracion", sel: "config-reglas", title: "Límite de efectivo y tope de descuento", text: "Poné cuánta plata como máximo querés tener en la caja. Si se pasa, el sistema te avisa que hagas un depósito." },
  { path: "/caja", sel: "caja", title: "Depósitos de caja", text: "Cuando el efectivo pasa el límite aparece el aviso con «Registrar depósito»: la plata sale de la caja y queda anotada. Si te equivocás, el depósito se anula." },
  { path: "/configuracion", sel: "config-mensajes", title: "Mensajes con más datos, y por mail", text: "Los mensajes ahora pueden llevar el total, la seña, los días, el teléfono y más datos del cliente. En la pestaña «Correo» armás el asunto y el texto del mail; sale desde la cuenta con la que entrás al sistema." },
  { path: "/cobros", sel: "cobros", title: "Recordatorio por mail", text: "A los que deben y tienen mail cargado les podés mandar el recordatorio por correo con «Enviar mail», además de WhatsApp. Se abre tu correo con el mensaje ya escrito." },
  { path: "/clientes", sel: "clientes", title: "Contactar clientes", text: "Cada cliente tiene botones para WhatsApp, llamar o mandarle un correo, si tiene el mail cargado." },
  { path: "/gastos", sel: "gastos-excel", title: "Gastos en Excel", text: "Los gastos se ven como una planilla con el total abajo, y con «Descargar Excel» bajás el detalle y el total por categoría." },
  { path: "/reportes", sel: "temporadas", title: "Comparar temporadas", text: "Al final de Reportes elegís dos temporadas y ves mes por mes ocupación, lo contratado, lo cobrado, los gastos y las reservas. Al imprimir, los reportes salen en blanco y negro, sin recuadros y con tu logo, nombre, fecha y hora arriba." },
  { path: "/", sel: "nueva-reserva", title: "Números de reserva propios", text: "Las reservas de tu balneario se numeran desde el 1, sin saltos. Las que ya tenías se renumeraron en el orden en que se cargaron." },
  { path: "/", sel: null, title: "¡Eso es todo!", text: "Si algo no te queda claro o se te ocurre una mejora, escribinos. Para verlas otra vez, tocá «Novedades» en la barra de arriba." },
];

const STEPS_BY_ID: Record<TourId, Step[]> = { demo: DEMO_STEPS, guia: GUIDE_STEPS, novedades: NEWS_STEPS };
const KEYS: Record<TourId, { step: string; done: string }> = {
  demo: { step: "bal_tour_paso", done: "bal_tour_visto" },
  guia: { step: "bal_guia_paso", done: "bal_guia_visto" },
  novedades: { step: "bal_novedades_paso", done: "bal_novedades_visto" },
};

const EVT = "tutorial-cambio";

const ss = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch { /* sin almacenamiento */ } },
};

/** Vuelve a empezar un recorrido desde el primer paso. */
export function startTour(id: TourId = "demo") {
  ss.set(KEYS[id].step, "0");
  window.dispatchEvent(new Event(EVT));
}

/** ¿Está el recorrido en curso (o todavía sin ver)? Para no tapar con otras ventanas. */
export function useTourActive(enabled: boolean, id: TourId = "demo", unseen = true): boolean {
  const k = KEYS[id];
  const calc = () => ss.get(k.step) !== null || (unseen && ss.get(k.done) === null);
  // Se calcula desde el primer momento, para que nada se abra encima antes de que empiece.
  const [active, setActive] = useState(() => enabled && calc());
  useEffect(() => {
    if (!enabled) { setActive(false); return; }
    const read = () => setActive(calc());
    read();
    window.addEventListener(EVT, read);
    return () => window.removeEventListener(EVT, read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, id, unseen]);
  return active;
}

type Rect = { top: number; left: number; width: number; height: number };

/** El primer elemento visible con esa marca (en la compu y en el celular hay botones distintos). */
function findVisible(tag: string): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${tag}"]`))) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

export function DemoTour({ enabled }: { enabled: boolean }) {
  return <Tour id="demo" enabled={enabled} finalLabel="Empezar a probar" />;
}

/**
 * @param unseen  si todavía no se vio (arranca solo la primera vez)
 * @param onFinish al terminar o saltear (por ejemplo, para recordarlo en la cuenta)
 */
export function Tour({ id, enabled, unseen = true, onFinish, finalLabel = "Terminar" }: {
  id: TourId; enabled: boolean; unseen?: boolean; onFinish?: () => void; finalLabel?: string;
}) {
  const STEPS = STEPS_BY_ID[id];
  const KEY_STEP = KEYS[id].step;
  const KEY_DONE = KEYS[id].done;
  const router = useRouter();
  const pathname = usePathname();
  const [step, setStep] = useState<number | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [searching, setSearching] = useState(false);
  const target = useRef<HTMLElement | null>(null);
  const card = useRef<HTMLDivElement>(null);

  // Arranca solo la primera vez que se entra a la demo; sigue donde estaba si se recarga.
  useEffect(() => {
    if (!enabled) return;
    const read = () => {
      const saved = ss.get(KEY_STEP);
      if (saved !== null) setStep(Math.min(Number(saved) || 0, STEPS.length - 1));
      else if (unseen && ss.get(KEY_DONE) === null) { ss.set(KEY_STEP, "0"); setStep(0); }
      else setStep(null);
    };
    const t = setTimeout(read, 600);
    window.addEventListener(EVT, read);
    return () => { clearTimeout(t); window.removeEventListener(EVT, read); };
  }, [enabled, unseen, KEY_STEP, KEY_DONE, STEPS.length]);

  const finish = useCallback(() => {
    ss.del(KEY_STEP);
    ss.set(KEY_DONE, "1");
    setStep(null);
    setRect(null);
    window.dispatchEvent(new Event(EVT));
    onFinish?.();
  }, [KEY_STEP, KEY_DONE, onFinish]);

  const go = useCallback((n: number) => {
    if (n < 0) return;
    if (n >= STEPS.length) return finish();
    ss.set(KEY_STEP, String(n));
    setStep(n);
  }, [finish, STEPS.length, KEY_STEP]);

  // Lleva a la pantalla del paso y busca la parte a mostrar.
  useEffect(() => {
    if (step === null) return;
    const s = STEPS[step];
    if (pathname !== s.path) { router.push(s.path); return; }
    target.current = null;
    setRect(null);
    if (!s.sel) { setSearching(false); return; }
    setSearching(true);
    let tries = 0;
    const id = setInterval(() => {
      const el = findVisible(s.sel!);
      tries += 1;
      if (el || tries > 40) {
        clearInterval(id);
        setSearching(false);
        if (el) {
          target.current = el;
          el.scrollIntoView({ block: "center", behavior: "auto" });
          const r = el.getBoundingClientRect();
          setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        }
      }
    }, 150);
    return () => clearInterval(id);
  }, [step, pathname, router, STEPS]);

  // Sigue a la parte resaltada si la pantalla se mueve o cambia de tamaño.
  useEffect(() => {
    if (step === null) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = target.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      });
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [step]);

  // Teclado: flechas para pasar, Escape para salir.
  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      if (e.key === "ArrowRight") go(step + 1);
      if (e.key === "ArrowLeft") go(step - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, go, finish]);

  // Ubica la tarjeta de explicación cerca de la parte resaltada, sin taparla.
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!rect || !card.current) { setCardPos(null); return; }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (vw < 640) { setCardPos(null); return; } // celular: abajo de todo
    const cw = card.current.offsetWidth;
    const ch = card.current.offsetHeight;
    const gap = 16;
    let top = rect.top + rect.height + gap;
    if (top + ch > vh - 12) top = rect.top - ch - gap;
    if (top < 12) top = Math.max(12, Math.min(vh - ch - 12, rect.top + rect.height / 2 - ch / 2));
    let left = rect.left + rect.width / 2 - cw / 2;
    left = Math.max(12, Math.min(vw - cw - 12, left));
    setCardPos({ top, left });
  }, [rect]);

  if (!enabled || step === null) return null;
  const s = STEPS[step];
  const pad = 8;
  const hole = rect ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 } : null;
  const shade = "fixed bg-slate-900/55 backdrop-blur-[3px] transition-all duration-300";

  return (
    <div className="print:hidden" role="dialog" aria-modal="true" aria-labelledby="tour-titulo">
      {/* Pantalla difuminada, con un hueco donde está la parte que se explica */}
      {hole ? (
        <>
          <div className={cx(shade, "z-[90]")} style={{ top: 0, left: 0, right: 0, height: Math.max(0, hole.top) }} />
          <div className={cx(shade, "z-[90]")} style={{ top: hole.top + hole.height, left: 0, right: 0, bottom: 0 }} />
          <div className={cx(shade, "z-[90]")} style={{ top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height }} />
          <div className={cx(shade, "z-[90]")} style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} />
          <div className="pointer-events-none fixed z-[91] rounded-2xl ring-4 ring-white/90 transition-all duration-300" style={hole} />
        </>
      ) : (
        <div className={cx(shade, "inset-0 z-[90]")} />
      )}

      {/* Explicación */}
      <div ref={card}
        className={cx("fixed z-[92] w-auto rounded-2xl border border-line bg-surface p-5 text-fg shadow-2xl sm:w-[380px]",
          cardPos ? "" : rect ? "inset-x-3 bottom-3 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2" : "inset-x-3 top-1/2 -translate-y-1/2 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2")}
        style={cardPos ?? undefined}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-xs font-semibold text-muted">Paso {step + 1} de {STEPS.length}</span>
          <button onClick={finish} className="text-xs font-medium text-muted hover:text-fg">{id === "demo" ? "Saltar tutorial" : "Saltear guía"}</button>
        </div>
        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
        </div>
        <h2 id="tour-titulo" className="text-lg font-bold">{s.title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">{searching ? "Cargando…" : s.text}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <button onClick={() => go(step - 1)} disabled={step === 0}
            className="rounded-lg border border-line px-3 py-2 text-sm font-semibold hover:bg-surface-2 disabled:opacity-40">Anterior</button>
          <button onClick={() => go(step + 1)} autoFocus
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:opacity-90">
            {step === STEPS.length - 1 ? finalLabel : "Siguiente"}
          </button>
        </div>
      </div>
    </div>
  );
}
