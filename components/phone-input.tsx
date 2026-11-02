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
        <div className="flex gap-2">
          <Input inputMode="numeric" aria-label="Código de área" placeholder={ar ? "Área (ej: 11)" : "Área"} value={value.area}
            onChange={(e) => set("area", e.target.value)} className="w-32" maxLength={6} />
          <Input type="tel" inputMode="tel" aria-label="Número" placeholder={ar ? "Número (sin el 15)" : "Número"} value={value.number}
            onChange={(e) => set("number", e.target.value)} className="flex-1" maxLength={20} />
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
