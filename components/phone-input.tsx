"use client";
import { COUNTRIES, formatPhone, phoneProblem, type PhoneParts } from "@/lib/phone";
import { Field, Input, Select } from "@/components/ui";

/**
 * Teléfono en partes: país (Argentina por defecto), celular (agrega el 9),
 * código de área y número. Muestra cómo queda guardado y si falta algo.
 */
export function PhoneInput({ value, onChange }: { value: PhoneParts; onChange: (p: PhoneParts) => void }) {
  const set = <K extends keyof PhoneParts>(k: K, v: PhoneParts[K]) => onChange({ ...value, [k]: v });
  const problem = phoneProblem(value);
  const preview = formatPhone(value);
  const ar = value.dial === "54";
  return (
    <Field label="Teléfono">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={value.dial} onChange={(e) => set("dial", e.target.value)} aria-label="País" className="w-auto">
            {COUNTRIES.map((c) => <option key={c.code} value={c.dial}>{c.name} (+{c.dial})</option>)}
          </Select>
          {ar && (
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={value.mobile} onChange={(e) => set("mobile", e.target.checked)} className="h-4 w-4" />
              Celular (+54 9)
            </label>
          )}
        </div>
        {/* Cada campo va en su propia caja de ancho fijo: así el número tiene lugar para todos los dígitos. */}
        <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
          <div>
            <div className="mb-0.5 text-xs text-muted">Cód. de área</div>
            <Input inputMode="numeric" aria-label="Código de área" placeholder={ar ? "Ej: 11" : "Área"} value={value.area}
              onChange={(e) => set("area", e.target.value)} maxLength={6} />
          </div>
          <div>
            <div className="mb-0.5 text-xs text-muted">Número{ar ? " (sin el 15)" : ""}</div>
            <Input type="tel" inputMode="tel" aria-label="Número" placeholder={ar ? "Ej: 4555-4165" : "Número"} value={value.number}
              onChange={(e) => set("number", e.target.value)} maxLength={20} />
          </div>
        </div>
        {problem ? (
          <p className="text-xs text-warn">{problem}</p>
        ) : preview ? (
          <p className="text-xs text-muted">Se guarda como <strong className="text-fg">{preview}</strong></p>
        ) : null}
      </div>
    </Field>
  );
}
