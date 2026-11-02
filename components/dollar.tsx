"use client";
import { useEffect, useState } from "react";
import { formatMoney, parseMoney } from "@/lib/format";
import { usdToArs, type Cotizacion } from "@/lib/dolar";
import { Alert, Button, Spinner, TextField } from "@/components/ui";

type RateState = { data: (Cotizacion & { consultado: string }) | null; error: string | null; loading: boolean };

/** Cotización del Banco Nación (se pide al servidor; se actualiza cada 5 minutos). */
export function useDollarRate(enabled: boolean): RateState & { reload: () => void } {
  const [st, setSt] = useState<RateState>({ data: null, error: null, loading: false });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setSt((s) => ({ ...s, loading: true, error: null }));
    fetch("/api/dolar", { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json();
        if (!alive) return;
        if (!r.ok) setSt({ data: null, error: body.error ?? "No se pudo obtener la cotización.", loading: false });
        else setSt({ data: body, error: null, loading: false });
      })
      .catch(() => alive && setSt({ data: null, error: "Sin conexión para consultar la cotización.", loading: false }));
    const t = setInterval(() => setTick((x) => x + 1), 5 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [enabled, tick]);
  return { ...st, reload: () => setTick((x) => x + 1) };
}

export type DollarValue = { usd: number | null; rate: number | null; ars: number | null };

/**
 * Cobro en dólares: muestra la cotización del Banco Nación (compra por defecto),
 * permite corregirla a mano y calcula cuántos pesos se descuentan del saldo.
 */
export function DollarFields({ due, onChange }: { due: number; onChange: (v: DollarValue) => void }) {
  const q = useDollarRate(true);
  const [which, setWhich] = useState<"compra" | "venta">("compra");
  const [manualRate, setManualRate] = useState("");
  const [usdText, setUsdText] = useState("");

  const bankRate = q.data ? q.data[which] : null;
  const rate = manualRate.trim() ? parseMoney(manualRate) : bankRate;
  const usd = parseMoney(usdText);
  const ars = usd && rate ? usdToArs(usd, rate) : null;
  // Un centavo de dólar de diferencia se acepta (la base descuenta exactamente el saldo).
  const over = ars !== null && rate !== null && rate !== undefined && ars - due >= Math.max(1, rate * 0.01);

  useEffect(() => { onChange({ usd: usd ?? null, rate: rate ?? null, ars }); }, [usd, rate, ars]); // eslint-disable-line react-hooks/exhaustive-deps

  function coverAll() {
    if (!rate) return;
    setUsdText(String(Math.ceil((due / rate) * 100) / 100).replace(".", ","));
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
      <div className="text-sm">
        {q.loading && !q.data ? (
          <span className="flex items-center gap-2 text-muted"><Spinner small /> Consultando la cotización del Banco Nación…</span>
        ) : q.data ? (
          <>
            <div className="font-medium">Dólar Banco Nación{q.data.fecha ? ` (${q.data.fecha.split("-").reverse().join("/")})` : ""}</div>
            <div className="mt-1 flex flex-wrap gap-2">
              {(["compra", "venta"] as const).map((k) => (
                <button key={k} type="button" onClick={() => { setWhich(k); setManualRate(""); }}
                  className={`rounded-lg border px-2 py-1 text-xs ${which === k && !manualRate ? "border-accent bg-accent-soft font-semibold" : "border-line"}`}>
                  {k === "compra" ? "Compra" : "Venta"} {formatMoney(q.data[k])}
                </button>
              ))}
            </div>
            <div className="mt-1 text-xs text-muted">Fuente: {q.data.fuente}. Se actualiza sola cada 5 minutos.</div>
          </>
        ) : (
          <Alert tone="warn">{q.error} Cargá la cotización a mano.</Alert>
        )}
      </div>
      <TextField label={q.data ? "Cotización usada (opcional, para corregirla a mano)" : "Cotización (pesos por dólar)"} inputMode="decimal"
        placeholder={bankRate ? String(bankRate).replace(".", ",") : "Ej: 1405"} value={manualRate} onChange={(e) => setManualRate(e.target.value)} />
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <TextField label="Dólares recibidos (US$)" inputMode="decimal" value={usdText} onChange={(e) => setUsdText(e.target.value)} />
        </div>
        <Button type="button" variant="secondary" onClick={coverAll} disabled={!rate}>Todo el saldo</Button>
      </div>
      {ars !== null && rate && (
        <Alert tone={over ? "danger" : "info"}>
          US$ {usd} × {formatMoney(rate)} = <strong>{formatMoney(ars)}</strong>
          {over ? ` · supera el saldo (${formatMoney(due)}). Bajá el monto y da el vuelto en pesos.` : ` · saldo que queda: ${formatMoney(Math.max(due - Math.min(ars, due), 0))}`}
        </Alert>
      )}
    </div>
  );
}
