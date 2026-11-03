"use client";
import { useEffect, useState } from "react";
import { COUNTRIES, formatPhone, phoneFromText, phoneProblem, phoneToText, type PhoneParts } from "@/lib/phone";
import { Field, Input, Select } from "@/components/ui";

/**
 * Teléfono: país (Argentina por defecto), celular (agrega el 9) y un solo campo con
 * código de área y número juntos. Muestra cómo queda guardado y si falta algo.
 */
export function PhoneInput({ value, onChange }: { value: PhoneParts; onChange: (p: PhoneParts) => void }) {
  const set = <K extends keyof PhoneParts>(k: K, v: PhoneParts[K]) => onChange({ ...value, [k]: v });
  // Un solo campo con el código de área y el número juntos; el sistema separa el área solo.
  const [text, setText] = useState(() => phoneToText(value));
  const shown = phoneToText(value);
  useEffect(() => {
    // Si el teléfono cambia desde afuera (abrir otro cliente), se actualiza el campo.
    if (phoneToText(phoneFromText(value.dial, value.mobile, text)) !== shown) setText(shown);
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const problem = phoneProblem(value);
  const preview = formatPhone(value);
  const ar = value.dial === "54";
  return (
    <Field label="Teléfono">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={value.dial} onChange={(e) => onChange(phoneFromText(e.target.value, value.mobile, text))} aria-label="País" className="w-auto">
            {COUNTRIES.map((c) => <option key={c.code} value={c.dial}>{c.name} (+{c.dial})</option>)}
          </Select>
          {ar && (
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={value.mobile} onChange={(e) => set("mobile", e.target.checked)} className="h-4 w-4" />
              Celular (+54 9)
            </label>
          )}
        </div>
        <Input type="tel" inputMode="tel" aria-label="Número con código de área" value={text}
          placeholder={ar ? "Código de área y número, ej: 2255 45-1234" : "Número completo"}
          onChange={(e) => { setText(e.target.value); onChange(phoneFromText(value.dial, value.mobile, e.target.value)); }} maxLength={25} />
        {problem ? (
          <p className="text-xs text-warn">{problem}</p>
        ) : preview ? (
          <p className="text-xs text-muted">Se guarda como <strong className="text-fg">{preview}</strong></p>
        ) : null}
      </div>
    </Field>
  );
}
