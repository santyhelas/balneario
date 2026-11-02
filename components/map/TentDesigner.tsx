"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Modal } from "@/components/ui";
import {
  DEFAULT_TENT_STYLE,
  PATTERN_LABEL,
  STATE_COLOR,
  STATE_LABEL,
  SpaceNumber,
  TENT_H,
  TENT_PRESETS,
  TENT_W,
  TentIcon,
  UmbrellaIcon,
  type SpaceState,
  type TentPattern,
  type TentStyle,
} from "./icons";

const SWATCHES = ["#ffffff", "#111111", "#1d5fa8", "#0e9f8e", "#2e7d32", "#f2c94c", "#f08c1a", "#c0392b", "#d6457a", "#7b4fc9"];
const PREVIEW_STATES: SpaceState[] = ["disponible", "ocupada", "reservada_futura", "mantenimiento"];

/**
 * Editor del diseño de carpas y sombrillas: dibujo, colores de lona, borde y número.
 * Muestra una vista previa con los distintos estados antes de guardar.
 */
export function TentDesigner({
  open,
  value,
  onClose,
  onSave,
}: {
  open: boolean;
  value: TentStyle;
  onClose: () => void;
  onSave: (s: TentStyle | null) => Promise<boolean>;
}) {
  const [st, setSt] = useState<TentStyle>(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setSt(value); }, [open, value]);
  const set = <K extends keyof TentStyle>(k: K, v: TentStyle[K]) => setSt((p) => ({ ...p, [k]: v }));
  const isDefault = JSON.stringify(st) === JSON.stringify(DEFAULT_TENT_STYLE);

  async function save() {
    setBusy(true);
    const ok = await onSave(isDefault ? null : st);
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      wide
      title="Diseño de carpas y sombrillas"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button onClick={save} loading={busy}>Guardar diseño</Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-4">
          <Section title="Diseños listos">
            <div className="flex flex-wrap gap-2">
              {TENT_PRESETS.map((p) => (
                <button key={p.name} type="button" onClick={() => setSt(p.style)}
                  className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm ${JSON.stringify(p.style) === JSON.stringify(st) ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2"}`}>
                  <MiniTent style={p.style} />
                  {p.name}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Dibujo de la lona">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(PATTERN_LABEL) as TentPattern[]).map((p) => (
                <button key={p} type="button" onClick={() => set("pattern", p)}
                  className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm ${st.pattern === p ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2"}`}>
                  <MiniTent style={{ ...st, pattern: p }} />
                  {PATTERN_LABEL[p]}
                </button>
              ))}
            </div>
          </Section>

          <ColorRow label="Color de la lona" value={st.fill} onChange={(v) => set("fill", v)} options={[["estado", "Según el estado"]]} />
          {st.pattern !== "liso" && (
            <ColorRow label={`Color de ${st.pattern === "lunares" ? "los lunares" : st.pattern === "cuadros" ? "los cuadros" : st.pattern === "franja" ? "la franja" : "las rayas"}`}
              value={st.accent} onChange={(v) => set("accent", v)} options={[["estado", "Según el estado"]]} />
          )}
          <ColorRow label="Borde" value={st.border} onChange={(v) => set("border", v)} options={[["estado", "Según el estado"], ["ninguno", "Sin borde"]]}>
            {st.border !== "ninguno" && (
              <div className="flex gap-1">
                {([1, 2, 3] as const).map((w) => (
                  <Chip key={w} active={st.borderWidth === w} onClick={() => set("borderWidth", w)}>{w === 1 ? "Fino" : w === 2 ? "Medio" : "Grueso"}</Chip>
                ))}
              </div>
            )}
          </ColorRow>
          <ColorRow label="Fondo del número" value={st.numberBg} onChange={(v) => set("numberBg", v)} options={[["estado", "Según el estado"], ["ninguno", "Sin fondo"]]} />
          <ColorRow label="Color del número" value={st.numberText} onChange={(v) => set("numberText", v)} options={[["estado", "Según el estado"]]} />

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={st.stateDot} onChange={(e) => set("stateDot", e.target.checked)} className="h-4 w-4" />
            Mostrar un punto de color con el estado en la esquina
          </label>
          <Alert tone="info">Con cualquier diseño, cada carpa y sombrilla lleva un marco grueso del color del estado: verde libre, rojo ocupada, naranja reservada para otra fecha. Si elegís el borde "Según el estado", el marco es el mismo borde.</Alert>
        </div>

        <div className="lg:sticky lg:top-0 lg:self-start">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Vista previa</span>
            {!isDefault && <button type="button" className="text-xs text-accent underline" onClick={() => setSt(DEFAULT_TENT_STYLE)}>Volver al clásico</button>}
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-xl p-3" style={{ background: "#f3e4c2" }}>
            {PREVIEW_STATES.map((state, i) => (
              <div key={state} className="flex flex-col items-center">
                <svg viewBox="-60 -55 120 110" className="h-20 w-full">
                  <defs><clipPath id="tent-clip"><rect x={-TENT_W / 2} y={-TENT_H / 2} width={TENT_W} height={TENT_H} rx={8} /></clipPath></defs>
                  <TentIcon color={STATE_COLOR[state]} selected={false} dashed={false} design={st} />
                  <SpaceNumber code={String(12 + i)} color={STATE_COLOR[state]} design={st} />
                </svg>
                <svg viewBox="-50 -50 100 100" className="h-14 w-full">
                  <UmbrellaIcon color={STATE_COLOR[state]} selected={false} dashed={false} design={st} />
                  <SpaceNumber code={String(80 + i)} color={STATE_COLOR[state]} design={st} />
                </svg>
                <span className="mt-1 text-center text-[11px] font-medium text-slate-800">{STATE_LABEL[state]}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium">{title}</div>
      {children}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-lg border px-2 py-1 text-xs ${active ? "border-accent bg-accent-soft font-medium" : "border-line hover:bg-surface-2"}`}>
      {children}
    </button>
  );
}

function ColorRow({ label, value, onChange, options, children }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][]; children?: ReactNode }) {
  const isHex = value.startsWith("#");
  return (
    <Section title={label}>
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map(([v, l]) => <Chip key={v} active={value === v} onClick={() => onChange(v)}>{l}</Chip>)}
        {SWATCHES.map((c) => (
          <button key={c} type="button" onClick={() => onChange(c)} aria-label={`Color ${c}`} title={c}
            className={`h-7 w-7 rounded-full border-2 ${value.toLowerCase() === c ? "border-accent ring-2 ring-accent/40" : "border-line"}`} style={{ background: c }} />
        ))}
        <label className={`flex items-center gap-1 rounded-lg border px-1.5 py-0.5 text-xs ${isHex && !SWATCHES.includes(value.toLowerCase()) ? "border-accent bg-accent-soft" : "border-line"}`}>
          Otro
          <input type="color" aria-label={`${label}: elegir otro color`} value={isHex ? value : "#ffffff"} onChange={(e) => onChange(e.target.value)}
            className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0" />
        </label>
        {children}
      </div>
    </Section>
  );
}

/** Carpita chica para los botones (usa el color de "ocupada" como ejemplo de estado). */
function MiniTent({ style }: { style: TentStyle }) {
  return (
    <svg viewBox="-56 -52 112 100" className="h-6 w-7 shrink-0">
      <defs><clipPath id="tent-clip"><rect x={-TENT_W / 2} y={-TENT_H / 2} width={TENT_W} height={TENT_H} rx={8} /></clipPath></defs>
      <TentIcon color={STATE_COLOR.ocupada} selected={false} dashed={false} design={style} />
    </svg>
  );
}

export { DEFAULT_TENT_STYLE };
