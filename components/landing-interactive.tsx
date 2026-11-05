"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

const useReducedMotion = () => {
  const [r, setR] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setR(m.matches);
    const on = () => setR(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return r;
};

/* ------------------------------------------------------------------ */
/* Portada: el balneario visto desde arriba, que se puede consultar por día */
/* ------------------------------------------------------------------ */

type Res = { tent: number; name: string; from: number; to: number; paid: boolean; courtesy?: boolean };
// Datos de ejemplo (inventados) para mostrar cómo se ve el mapa.
const RES: Res[] = [
  { tent: 1, name: "Pérez", from: -3, to: 4, paid: true }, { tent: 2, name: "Gómez", from: 0, to: 14, paid: false },
  { tent: 4, name: "Sosa", from: -6, to: 0, paid: true }, { tent: 5, name: "Ruiz", from: 1, to: 15, paid: true },
  { tent: 6, name: "Díaz", from: -2, to: 9, paid: true }, { tent: 8, name: "Vega", from: 7, to: 21, paid: false },
  { tent: 9, name: "Ortiz", from: -10, to: 3, paid: true }, { tent: 10, name: "Luna", from: 0, to: 0, paid: true },
  { tent: 12, name: "Romero", from: -1, to: 13, paid: false }, { tent: 13, name: "Molina", from: -4, to: 10, paid: true, courtesy: true },
  { tent: 15, name: "Castro", from: 0, to: 6, paid: true }, { tent: 16, name: "Ríos", from: 8, to: 12, paid: true },
  { tent: 17, name: "Herrera", from: -5, to: 8, paid: true }, { tent: 18, name: "Medina", from: 1, to: 7, paid: false },
  { tent: 20, name: "Acosta", from: -2, to: 2, paid: true }, { tent: 21, name: "Benítez", from: 0, to: 29, paid: true },
  { tent: 23, name: "Navarro", from: 6, to: 20, paid: true }, { tent: 24, name: "Ferreyra", from: -8, to: 7, paid: false },
  { tent: 3, name: "Juárez", from: 2, to: 9, paid: true }, { tent: 7, name: "Cabrera", from: 3, to: 8, paid: true },
];
const MAINT = new Set([11]);
type St = "libre" | "ocupada" | "manana" | "mant" | "cortesia";
const COLOR: Record<St, string> = { libre: "var(--verde)", ocupada: "var(--lona)", manana: "var(--sol)", mant: "var(--mant)", cortesia: "var(--violeta)" };
const LABEL: Record<St, string> = { libre: "Libre", ocupada: "Ocupada", manana: "Llega mañana", mant: "Mantenimiento", cortesia: "Cortesía" };
const DAYS = [{ d: 0, label: "Hoy" }, { d: 1, label: "Mañana" }, { d: 7, label: "En una semana" }];

function stateOf(tent: number, d: number): { st: St; r?: Res } {
  if (MAINT.has(tent) && d <= 1) return { st: "mant" };
  const r = RES.find((x) => x.tent === tent && x.from <= d && x.to >= d);
  if (r) return { st: r.courtesy ? "cortesia" : "ocupada", r };
  const next = RES.find((x) => x.tent === tent && x.from === d + 1);
  if (next) return { st: "manana", r: next };
  return { st: "libre" };
}
const fmt = (offset: number) => {
  const t = new Date(Date.UTC(2027, 0, 10 + offset));
  return `${String(t.getUTCDate()).padStart(2, "0")}/${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
};

export function HeroBeach() {
  const reduced = useReducedMotion();
  const [day, setDay] = useState(0);
  const [shown, setShown] = useState(0); // cuántas carpas ya "se alquilaron" en la animación de entrada
  const [sel, setSel] = useState<number | null>(17);
  useEffect(() => {
    if (reduced) { setShown(24); return; }
    let i = 0;
    const t = setInterval(() => { i += 1; setShown(i); if (i >= 24) clearInterval(t); }, 70);
    return () => clearInterval(t);
  }, [reduced]);

  const d = DAYS[day].d;
  const tents = Array.from({ length: 24 }, (_, i) => i + 1);
  const pos = (n: number) => {
    const row = Math.floor((n - 1) / 8);
    const col = (n - 1) % 8;
    return { x: 22 + col * 58, y: row < 2 ? 112 + row * 58 : 252 };
  };
  const counts = tents.reduce((a, n) => { const s = stateOf(n, d).st; a[s] = (a[s] ?? 0) + 1; return a; }, {} as Record<St, number>);
  const selInfo = sel ? stateOf(sel, d) : null;

  return (
    <div className="rounded-[28px] bg-white p-3 shadow-[0_30px_60px_-30px_rgba(11,79,108,0.55)] ring-1 ring-[var(--sand-2)] sm:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1">
        <div role="tablist" aria-label="Día que querés ver" className="flex rounded-full bg-[var(--foam)] p-1 text-sm">
          {DAYS.map((x, i) => (
            <button key={x.label} role="tab" aria-selected={day === i} onClick={() => setDay(i)}
              className={`rounded-full px-3 py-1.5 font-semibold transition ${day === i ? "bg-[var(--atl)] text-white shadow" : "text-[var(--atl)] hover:bg-white"}`}>
              {x.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-[var(--gris)]">{counts.libre ?? 0} libres · {(counts.ocupada ?? 0) + (counts.cortesia ?? 0)} ocupadas</span>
      </div>

      <svg viewBox="0 0 490 310" className="block h-auto w-full select-none" role="img" aria-label="Plano de ejemplo de un balneario con carpas libres y ocupadas">
        <defs>
          <pattern id="tb-arena" width="12" height="12" patternUnits="userSpaceOnUse">
            <rect width="12" height="12" fill="var(--sand)" />
            <circle cx="3" cy="4" r="0.9" fill="var(--sand-2)" />
            <circle cx="9" cy="9" r="0.7" fill="var(--sand-2)" />
          </pattern>
          <pattern id="tb-rayas" width="8" height="8" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" fill="#fff" />
            <rect width="4" height="8" fill="rgba(47,158,91,0.16)" />
          </pattern>
          <clipPath id="tb-clip"><rect width="490" height="310" rx="20" /></clipPath>
        </defs>
        <g clipPath="url(#tb-clip)">
          <rect width="490" height="310" fill="url(#tb-arena)" />
          <rect width="490" height="70" fill="var(--atl-2)" />
          <g className="tb-wave-slow">
            <path d="M0 58 q35 -12 70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 V0 H0 Z" fill="var(--atl)" opacity="0.55" />
          </g>
          <g className="tb-wave">
            <path d="M0 72 q35 -14 70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 V60 H0 Z" fill="var(--atl-3)" opacity="0.7" />
            <path d="M0 74 q35 -14 70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0 t70 0" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity="0.9" />
          </g>
          <rect x="0" y="226" width="490" height="18" fill="#efe2c4" />
          <text x="245" y="239" textAnchor="middle" fontSize="9" fill="#a08a5a" fontWeight="600">pasarela</text>
          {/* Sol y viento */}
          <g transform="translate(458 28)">
            <circle r="11" fill="var(--sol)" opacity="0.95" />
            {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <line key={a} x1="0" y1="-15" x2="0" y2="-19" stroke="var(--sol)" strokeWidth="2" strokeLinecap="round" transform={`rotate(${a})`} />)}
          </g>
          {tents.map((n) => {
            const { x, y } = pos(n);
            const { st, r } = n <= shown ? stateOf(n, d) : { st: "libre" as St, r: undefined };
            const full = st !== "libre";
            const isSel = sel === n;
            return (
              <g key={`${n}-${day}-${n <= shown}`} className={n <= shown && full ? "tb-pop" : undefined} style={{ cursor: "pointer" }}
                onClick={() => setSel(n)} role="button" tabIndex={0} aria-label={`Carpa ${n}: ${LABEL[st]}${r ? `, ${r.name}` : ""}`}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSel(n); } }}>
                {isSel && <rect x={x - 5} y={y - 5} width="54" height="50" rx="11" fill="none" stroke="var(--atl)" strokeWidth="2.5" strokeDasharray="5 3" />}
                <rect x={x} y={y} width="44" height="40" rx="7" fill={full ? COLOR[st] : "#fff"} stroke={COLOR[st]} strokeWidth="3" />
                {!full && <rect x={x + 3} y={y + 3} width="38" height="34" rx="4" fill="url(#tb-rayas)" />}
                <text x={x + 22} y={y + (r && st !== "mant" ? 17 : 25)} textAnchor="middle" fontSize="13" fontWeight="800" fill={full ? "#fff" : "var(--tinta)"}>{n}</text>
                {r && st !== "mant" && <text x={x + 22} y={y + 31} textAnchor="middle" fontSize="8" fontWeight="600" fill="#fff">{r.name}</text>}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="mt-3 flex flex-col gap-3 px-1">
        <div className="min-h-[52px] rounded-2xl bg-[var(--foam)] px-4 py-2.5 text-sm" aria-live="polite">
          {sel && selInfo ? (
            <>
              <div className="font-bold">Carpa {sel} · <span style={{ color: COLOR[selInfo.st] === "var(--sol)" ? "#9a6b00" : COLOR[selInfo.st] }}>{LABEL[selInfo.st]}</span></div>
              <div className="text-[var(--gris)]">
                {selInfo.r
                  ? `${selInfo.r.name}${selInfo.r.courtesy ? " (cortesía familiar)" : ""} · del ${fmt(selInfo.r.from)} al ${fmt(selInfo.r.to)} · ${selInfo.r.courtesy ? "sin cargo" : selInfo.r.paid ? "pagado" : "debe saldo"}`
                  : selInfo.st === "mant" ? "Bloqueada por arreglos: no se puede reservar." : "Disponible para reservar ese día."}
              </div>
            </>
          ) : "Tocá una carpa."}
        </div>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--gris)]">
          {(["libre", "ocupada", "manana", "mant", "cortesia"] as St[]).map((s) => (
            <li key={s} className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[4px]" style={{ background: COLOR[s] }} />{LABEL[s]}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Carrusel que se desliza (con flechas, puntos y deslizando con el dedo) */
/* ------------------------------------------------------------------ */

export function Slider({ slides, label, auto = 7000 }: { slides: { key: string; node: ReactNode }[]; label: string; auto?: number }) {
  const track = useRef<HTMLDivElement>(null);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = useReducedMotion();

  const go = (n: number) => {
    const el = track.current;
    if (!el) return;
    const k = (n + slides.length) % slides.length;
    const child = el.children[k] as HTMLElement | undefined;
    if (child) el.scrollTo({ left: child.offsetLeft - el.offsetLeft, behavior: reduced ? "auto" : "smooth" });
  };
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const on = () => {
      const w = (el.children[0] as HTMLElement | undefined)?.offsetWidth ?? 1;
      setI(Math.round(el.scrollLeft / (w + 16)));
    };
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, []);
  useEffect(() => {
    if (paused || reduced || !auto) return;
    const t = setTimeout(() => go(i + 1), auto);
    return () => clearTimeout(t);
  }); // se reprograma en cada render

  return (
    <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}
      onTouchStart={() => setPaused(true)} aria-roledescription="carrusel" aria-label={label}>
      <div ref={track} className="tb-track -mx-4 flex gap-4 overflow-x-auto px-4 pb-2">
        {slides.map((s, k) => (
          <div key={s.key} className="w-[86%] shrink-0 sm:w-[62%] lg:w-[46%]" role="group" aria-roledescription="diapositiva" aria-label={`${k + 1} de ${slides.length}`}>
            {s.node}
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {slides.map((s, k) => (
            <button key={s.key} onClick={() => go(k)} aria-label={`Ir a la ${k + 1}`}
              className={`h-2.5 rounded-full transition-all ${k === i ? "w-7 bg-[var(--atl)]" : "w-2.5 bg-[var(--sand-2)] hover:bg-[var(--atl-3)]"}`} />
          ))}
        </div>
        <div className="flex gap-2">
          <ArrowBtn dir={-1} onClick={() => go(i - 1)} />
          <ArrowBtn dir={1} onClick={() => go(i + 1)} />
        </div>
      </div>
    </div>
  );
}

function ArrowBtn({ dir, onClick }: { dir: 1 | -1; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-label={dir === 1 ? "Siguiente" : "Anterior"}
      className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-[var(--atl)] text-[var(--atl)] transition hover:bg-[var(--atl)] hover:text-white">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={dir === 1 ? "M9 5l7 7-7 7" : "M15 5l-7 7 7 7"} />
      </svg>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Un día en el balneario: se recorre deslizando la hora */
/* ------------------------------------------------------------------ */

export type DayStep = { time: string; title: string; text: string; screen: ReactNode };

export function DayTimeline({ steps }: { steps: DayStep[] }) {
  const [i, setI] = useState(0);
  const s = steps[i];
  return (
    <div className="grid items-center gap-8 lg:grid-cols-[1fr_1.1fr]">
      <div>
        <label htmlFor="tb-hora" className="text-sm font-semibold text-[var(--atl-3)]">Deslizá la hora</label>
        <input id="tb-hora" type="range" min={0} max={steps.length - 1} step={1} value={i} onChange={(e) => setI(Number(e.target.value))}
          className="mt-2 w-full accent-[var(--sol)]" aria-valuetext={`${s.time}: ${s.title}`} />
        <div className="mt-1 flex justify-between text-xs font-semibold text-white/60">
          {steps.map((x, k) => (
            <button key={x.time} onClick={() => setI(k)} className={k === i ? "text-[var(--sol)]" : "hover:text-white"}>{x.time}</button>
          ))}
        </div>
        <div className="mt-8" aria-live="polite">
          <div className="display text-6xl font-extrabold text-[var(--sol)]">{s.time}</div>
          <h3 className="mt-2 text-2xl font-bold text-white">{s.title}</h3>
          <p className="mt-2 max-w-md text-white/80">{s.text}</p>
        </div>
      </div>
      <div key={s.time} className="tb-pop">{s.screen}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tira de postales que pasa sola (fotos reales o dibujos de playa) */
/* ------------------------------------------------------------------ */

export function PhotoStrip({ items }: { items: { key: string; caption: string; node: ReactNode }[] }) {
  const loop = [...items, ...items];
  return (
    <div className="overflow-hidden" aria-label="Postales de la temporada">
      <ul className="tb-marquee flex gap-5 py-2">
        {loop.map((p, k) => (
          <li key={`${p.key}-${k}`} aria-hidden={k >= items.length} className="w-64 shrink-0 rotate-[-1.5deg] rounded-2xl bg-white p-2.5 pb-3 shadow-lg ring-1 ring-black/5 odd:rotate-[1.5deg] sm:w-72">
            <div className="aspect-[4/3] overflow-hidden rounded-xl">{p.node}</div>
            <p className="mt-2 px-1 text-sm font-semibold">{p.caption}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
