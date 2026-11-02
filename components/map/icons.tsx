// Íconos vistos desde arriba: carpa de playa y sombrilla de playa, con diseño configurable.

export type SpaceState = "disponible" | "ocupada" | "cortesia" | "reservada_futura" | "mantenimiento" | "desactivada";

export const STATE_COLOR: Record<SpaceState, string> = {
  disponible: "var(--st-disponible)",
  ocupada: "var(--st-ocupada)",
  cortesia: "var(--st-cortesia)",
  reservada_futura: "var(--st-futura)",
  mantenimiento: "var(--st-mantenimiento)",
  desactivada: "var(--st-desactivada)",
};

export const STATE_LABEL: Record<SpaceState, string> = {
  disponible: "Disponible",
  ocupada: "Ocupada",
  cortesia: "Cortesía familiar",
  reservada_futura: "Libre, con reserva futura",
  mantenimiento: "En mantenimiento",
  desactivada: "Desactivada",
};

export const TENT_W = 86;
export const TENT_H = 70;
export const UMBRELLA_R = 38;

/* ------------------------------------------------------------------ */
/* Diseño configurable de carpas y sombrillas                          */
/* ------------------------------------------------------------------ */

export type TentPattern = "liso" | "rayas" | "rayas_finas" | "cuadros" | "lunares" | "franja";
/** Un color "#rrggbb" o una palabra clave. "estado" = el color del estado del día. */
export type StyleColor = string;

export type TentStyle = {
  pattern: TentPattern;
  /** Color de fondo de la lona. */
  fill: StyleColor;
  /** Color del dibujo (rayas, cuadros, lunares, franja): "#rrggbb" o "estado". */
  accent: StyleColor;
  /** Borde: "#rrggbb", "estado" o "ninguno". */
  border: StyleColor;
  borderWidth: 1 | 2 | 3;
  /** Fondo del número: "#rrggbb", "estado" o "ninguno". */
  numberBg: StyleColor;
  /** Color del número: "#rrggbb" o "estado". */
  numberText: StyleColor;
  /** Punto chico con el color del estado. */
  stateDot: boolean;
};

export const PATTERN_LABEL: Record<TentPattern, string> = {
  liso: "Liso",
  rayas: "Rayas",
  rayas_finas: "Rayas finas",
  cuadros: "Cuadros",
  lunares: "Lunares",
  franja: "Franja en el borde",
};

/** El diseño de siempre: a rayas del color del estado. */
export const DEFAULT_TENT_STYLE: TentStyle = {
  pattern: "rayas",
  fill: "#fbfaf6",
  accent: "estado",
  border: "estado",
  borderWidth: 2,
  numberBg: "#ffffff",
  numberText: "#1f2937",
  stateDot: false,
};

export const TENT_PRESETS: { name: string; style: TentStyle }[] = [
  { name: "Clásico: rayas según el estado", style: DEFAULT_TENT_STYLE },
  { name: "Blancas con número negro", style: { pattern: "liso", fill: "#ffffff", accent: "estado", border: "estado", borderWidth: 3, numberBg: "ninguno", numberText: "#111111", stateDot: false } },
  { name: "Lisas del color del estado", style: { pattern: "liso", fill: "#ffffff", accent: "estado", border: "#ffffff", borderWidth: 1, numberBg: "estado", numberText: "#ffffff", stateDot: false } },
  { name: "Rayas azules, número de color", style: { pattern: "rayas", fill: "#ffffff", accent: "#1d5fa8", border: "#1d5fa8", borderWidth: 1, numberBg: "estado", numberText: "#ffffff", stateDot: false } },
  { name: "Cuadros rojos", style: { pattern: "cuadros", fill: "#ffffff", accent: "#c0392b", border: "estado", borderWidth: 3, numberBg: "#ffffff", numberText: "#111111", stateDot: false } },
];

const HEX = /^#[0-9a-fA-F]{6}$/;
const PATTERNS = Object.keys(PATTERN_LABEL) as TentPattern[];

/** Toma lo guardado en la base (o nada) y devuelve un diseño completo y válido. */
export function normalizeTentStyle(raw: unknown): TentStyle {
  const d = DEFAULT_TENT_STYLE;
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const col = (v: unknown, allowed: string[], def: string) =>
    typeof v === "string" && (HEX.test(v) || allowed.includes(v)) ? v : def;
  return {
    pattern: PATTERNS.includes(r.pattern as TentPattern) ? (r.pattern as TentPattern) : d.pattern,
    fill: col(r.fill, ["estado"], d.fill),
    accent: col(r.accent, ["estado"], d.accent),
    border: col(r.border, ["estado", "ninguno"], d.border),
    borderWidth: r.borderWidth === 1 || r.borderWidth === 2 || r.borderWidth === 3 ? r.borderWidth : d.borderWidth,
    numberBg: col(r.numberBg, ["estado", "ninguno"], d.numberBg),
    numberText: col(r.numberText, ["estado"], d.numberText),
    stateDot: r.stateDot === true,
  };
}

/** ¿Con este diseño se distingue el estado de cada carpa? Si no, se agrega el punto de estado. */
export function styleShowsState(st: TentStyle): boolean {
  return (
    st.fill === "estado" ||
    (st.pattern !== "liso" && st.accent === "estado") ||
    st.border === "estado" ||
    st.numberBg === "estado" ||
    st.numberText === "estado" ||
    st.stateDot
  );
}

const pick = (c: StyleColor, state: string) => (c === "estado" ? state : c);
const BORDER_W = { 1: 2, 2: 3.5, 3: 6 } as const;

/** Rellenos del dibujo dentro de un rectángulo w×h centrado en 0,0 (para la carpa). */
function TentPatternShapes({ pattern, color, w, h }: { pattern: TentPattern; color: string; w: number; h: number }) {
  const x0 = -w / 2;
  const y0 = -h / 2;
  switch (pattern) {
    case "liso":
      return null;
    case "rayas":
    case "rayas_finas": {
      const n = pattern === "rayas" ? 5 : 11;
      const sw = w / n;
      return <>{Array.from({ length: n }, (_, i) => (i % 2 === 0 ? <rect key={i} x={x0 + i * sw} y={y0} width={sw} height={h} fill={color} /> : null))}</>;
    }
    case "cuadros": {
      const cols = 6;
      const rows = 5;
      const cw = w / cols;
      const ch = h / rows;
      const out = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if ((r + c) % 2 === 0) out.push(<rect key={`${r}-${c}`} x={x0 + c * cw} y={y0 + r * ch} width={cw} height={ch} fill={color} />);
      return <>{out}</>;
    }
    case "lunares": {
      const out = [];
      for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) out.push(<circle key={`${r}-${c}`} cx={x0 + 9 + c * 17 + (r % 2) * 8} cy={y0 + 9 + r * 17} r={4.5} fill={color} />);
      return <>{out}</>;
    }
    case "franja":
      return <rect x={x0 + 4} y={y0 + 4} width={w - 8} height={h - 8} rx={5} fill="none" stroke={color} strokeWidth={9} />;
  }
}

/** Carpa de playa vista desde arriba: lona rectangular con faldón frontal. */
export function TentIcon({ color, selected, dashed, design }: { color: string; selected: boolean; dashed: boolean; design?: TentStyle | null }) {
  const st = design ?? DEFAULT_TENT_STYLE;
  const w = TENT_W;
  const h = TENT_H;
  const fill = pick(st.fill, color);
  const accent = pick(st.accent, color);
  const border = st.border === "ninguno" ? null : pick(st.border, color);
  const flap = `M ${-w / 2 + 6} ${-h / 2} L ${-w / 2 + 14} ${-h / 2 - 9} L ${w / 2 - 14} ${-h / 2 - 9} L ${w / 2 - 6} ${-h / 2} Z`;
  return (
    <g>
      {selected && <rect x={-w / 2 - 7} y={-h / 2 - 7} width={w + 14} height={h + 14} rx={12} fill="none" stroke="var(--accent)" strokeWidth={4} />}
      {/* sombra */}
      <rect x={-w / 2 + 3} y={-h / 2 + 4} width={w} height={h} rx={7} fill="rgba(0,0,0,0.12)" />
      {/* #tent-clip se define una sola vez en el <defs> del mapa */}
      <g clipPath="url(#tent-clip)">
        <rect x={-w / 2} y={-h / 2} width={w} height={h} fill={fill} />
        <g opacity={st.accent === "estado" ? 0.88 : 1}>
          <TentPatternShapes pattern={st.pattern} color={accent} w={w} h={h} />
        </g>
        {/* cumbrera */}
        <line x1={-w / 2} y1={0} x2={w / 2} y2={0} stroke="rgba(0,0,0,0.2)" strokeWidth={1.5} />
      </g>
      {/* faldón hacia el mar */}
      <path d={flap} fill={st.pattern === "liso" ? fill : accent} />
      <path d={flap} fill="#000" opacity={0.12} />
      {border && (
        <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={7} fill="none" stroke={border}
          strokeWidth={dashed ? 2.5 : BORDER_W[st.borderWidth]} strokeDasharray={dashed ? "6 5" : undefined} />
      )}
      {(st.stateDot || !styleShowsState(st)) && <StateDot x={w / 2 - 10} y={-h / 2 + 10} color={color} />}
    </g>
  );
}

/** Sombrilla de playa vista desde arriba: círculo con mástil central. */
export function UmbrellaIcon({ color, selected, dashed, design }: { color: string; selected: boolean; dashed: boolean; design?: TentStyle | null }) {
  const st = design ?? DEFAULT_TENT_STYLE;
  const r = UMBRELLA_R;
  const fill = pick(st.fill, color);
  const accent = pick(st.accent, color);
  const border = st.border === "ninguno" ? null : pick(st.border, color);
  const n = st.pattern === "rayas_finas" ? 16 : 8;
  const wedge = (i: number, rad: number) => {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    return `M0 0 L ${rad * Math.cos(a0)} ${rad * Math.sin(a0)} A ${rad} ${rad} 0 0 1 ${rad * Math.cos(a1)} ${rad * Math.sin(a1)} Z`;
  };
  const op = st.accent === "estado" ? 0.9 : 1;
  return (
    <g>
      {selected && <circle r={r + 8} fill="none" stroke="var(--accent)" strokeWidth={4} />}
      <circle cx={3} cy={4} r={r} fill="rgba(0,0,0,0.12)" />
      <circle r={r} fill={fill} />
      <g opacity={op}>
        {(st.pattern === "rayas" || st.pattern === "rayas_finas") &&
          Array.from({ length: n }, (_, i) => (i % 2 === 0 ? <path key={i} d={wedge(i, r)} fill={accent} /> : null))}
        {st.pattern === "cuadros" &&
          Array.from({ length: n }, (_, i) => (
            <g key={i}>
              {i % 2 === 0 && <path d={wedge(i, r)} fill={accent} />}
              <path d={wedge(i, r * 0.55)} fill={i % 2 === 0 ? fill : accent} />
            </g>
          ))}
        {st.pattern === "lunares" &&
          [0, 1, 2, 3, 4, 5].map((k) => {
            const a = (k / 6) * Math.PI * 2;
            return <circle key={k} cx={Math.cos(a) * r * 0.62} cy={Math.sin(a) * r * 0.62} r={5} fill={accent} />;
          })}
        {st.pattern === "franja" && <circle r={r - 5} fill="none" stroke={accent} strokeWidth={9} />}
      </g>
      {/* gajos marcados, como una sombrilla de verdad */}
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return <line key={i} x1={0} y1={0} x2={Math.cos(a) * r} y2={Math.sin(a) * r} stroke="rgba(0,0,0,0.12)" strokeWidth={1} />;
      })}
      {border && <circle r={r} fill="none" stroke={border} strokeWidth={dashed ? 2.5 : BORDER_W[st.borderWidth]} strokeDasharray={dashed ? "6 5" : undefined} />}
      <circle r={4} fill="#fbfaf6" stroke="rgba(0,0,0,0.35)" strokeWidth={1.2} />
      {(st.stateDot || !styleShowsState(st)) && <StateDot x={r * 0.7} y={-r * 0.7} color={color} />}
    </g>
  );
}

function StateDot({ x, y, color }: { x: number; y: number; color: string }) {
  return <circle cx={x} cy={y} r={8} fill={color} stroke="#ffffff" strokeWidth={2.5} />;
}

/** Número del espacio, encima del dibujo (no gira con la carpa). */
export function SpaceNumber({ code, color, design }: { code: string; color: string; design?: TentStyle | null }) {
  const st = design ?? DEFAULT_TENT_STYLE;
  const bg = st.numberBg === "ninguno" ? null : pick(st.numberBg, color);
  const fg = pick(st.numberText, color);
  return (
    <g pointerEvents="none">
      {bg && <rect x={-26} y={-16} width={52} height={32} rx={8} fill={bg} opacity={0.95} stroke={st.numberBg === "estado" ? "#ffffff" : color} strokeWidth={2} />}
      <text y={1.5} textAnchor="middle" dominantBaseline="middle" fontSize={bg ? 22 : 26} fontWeight={800} fill={fg}
        stroke={bg ? undefined : "#ffffff"} strokeWidth={bg ? undefined : 4} paintOrder="stroke">{code}</text>
    </g>
  );
}
