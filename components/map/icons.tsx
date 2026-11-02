// Íconos vistos desde arriba: carpa de playa (lona a rayas) y sombrilla de playa (gajos).

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

/** Carpa de playa vista desde arriba: lona rectangular a rayas con faldón frontal. */
export function TentIcon({ color, selected, dashed, fill }: { color: string; selected: boolean; dashed: boolean; fill?: string | null }) {
  const w = TENT_W;
  const h = TENT_H;
  const stripes = 5;
  const sw = w / stripes;
  return (
    <g>
      {selected && <rect x={-w / 2 - 7} y={-h / 2 - 7} width={w + 14} height={h + 14} rx={12} fill="none" stroke="var(--accent)" strokeWidth={4} />}
      {/* sombra */}
      <rect x={-w / 2 + 3} y={-h / 2 + 4} width={w} height={h} rx={7} fill="rgba(0,0,0,0.12)" />
      {/* #tent-clip se define una sola vez en el <defs> del mapa */}
      <g clipPath="url(#tent-clip)">
        <rect x={-w / 2} y={-h / 2} width={w} height={h} fill={fill ?? "#fbfaf6"} />
        {Array.from({ length: stripes }, (_, i) =>
          i % 2 === 0 ? (
            fill
              ? <rect key={i} x={-w / 2 + i * sw} y={-h / 2} width={sw} height={h} fill="#000" opacity={0.06} />
              : <rect key={i} x={-w / 2 + i * sw} y={-h / 2} width={sw} height={h} fill={color} opacity={0.88} />
          ) : null,
        )}
        {/* cumbrera */}
        <line x1={-w / 2} y1={0} x2={w / 2} y2={0} stroke="rgba(0,0,0,0.25)" strokeWidth={1.5} />
      </g>
      {/* faldón hacia el mar */}
      <path d={`M ${-w / 2 + 6} ${-h / 2} L ${-w / 2 + 14} ${-h / 2 - 9} L ${w / 2 - 14} ${-h / 2 - 9} L ${w / 2 - 6} ${-h / 2} Z`} fill={fill ?? color} opacity={fill ? 1 : 0.6} />
      {fill && <path d={`M ${-w / 2 + 6} ${-h / 2} L ${-w / 2 + 14} ${-h / 2 - 9} L ${w / 2 - 14} ${-h / 2 - 9} L ${w / 2 - 6} ${-h / 2} Z`} fill="#000" opacity={0.12} />}
      <rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        rx={7}
        fill="none"
        stroke={color}
        strokeWidth={fill ? 5 : dashed ? 2.5 : 3}
        strokeDasharray={dashed ? "6 5" : undefined}
      />
    </g>
  );
}

/** Sombrilla de playa vista desde arriba: círculo en gajos alternados con mástil central. */
export function UmbrellaIcon({ color, selected, dashed, fill }: { color: string; selected: boolean; dashed: boolean; fill?: string | null }) {
  const r = UMBRELLA_R;
  const n = 8;
  const wedges = Array.from({ length: n }, (_, i) => {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    return `M0 0 L ${r * Math.cos(a0)} ${r * Math.sin(a0)} A ${r} ${r} 0 0 1 ${r * Math.cos(a1)} ${r * Math.sin(a1)} Z`;
  });
  return (
    <g>
      {selected && <circle r={r + 8} fill="none" stroke="var(--accent)" strokeWidth={4} />}
      <circle cx={3} cy={4} r={r} fill="rgba(0,0,0,0.12)" />
      {wedges.map((d, i) => (
        fill
          ? <g key={i}><path d={d} fill={fill} />{i % 2 === 0 && <path d={d} fill="#000" opacity={0.07} />}</g>
          : <path key={i} d={d} fill={i % 2 === 0 ? color : "#fbfaf6"} opacity={i % 2 === 0 ? 0.9 : 1} />
      ))}
      <circle r={r} fill="none" stroke={color} strokeWidth={fill ? 5 : dashed ? 2.5 : 3} strokeDasharray={dashed ? "6 5" : undefined} />
      <circle r={4} fill="#fbfaf6" stroke="rgba(0,0,0,0.35)" strokeWidth={1.2} />
    </g>
  );
}
