"use client";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { formatMoney, parseMoney } from "@/lib/format";
import { Button, Card, Input } from "@/components/ui";

type Tier = { hasta: string; anual: string; entrada: string; cuota: string };

/** Escalas de precio por tamaño (carpas + sombrillas): las usa la página de presupuesto de la web. */
export function PriceTiersCard() {
  const sb = getSupabase();
  const [rows, setRows] = useState<Tier[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    sb.rpc("price_tiers").then(({ data, error }) => {
      if (error) return setMsg({ ok: false, text: "Falta correr la actualización 0057 en Supabase." });
      const t = (data as { hasta: number | null; anual: number; entrada: number; cuota: number }[]) ?? [];
      setRows(t.length ? t.map((x) => ({ hasta: x.hasta == null ? "" : String(x.hasta), anual: String(x.anual), entrada: String(x.entrada), cuota: String(x.cuota) })) : [{ hasta: "", anual: "", entrada: "", cuota: "" }]);
    });
  }, [sb]);
  if (!rows) return msg ? <p className="text-sm text-muted">{msg.text}</p> : null;
  const set = (i: number, k: keyof Tier, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  async function save() {
    const out = [];
    for (const r of rows!) {
      const a = parseMoney(r.anual), e = parseMoney(r.entrada), c = parseMoney(r.cuota);
      if (a == null || e == null || c == null) return setMsg({ ok: false, text: "Completá los tres precios de cada escala." });
      if (r.hasta && !(Number(r.hasta) > 0)) return setMsg({ ok: false, text: "«Hasta» tiene que ser un número de espacios." });
      out.push({ hasta: r.hasta ? Number(r.hasta) : "", anual: a, entrada: e, cuota: c });
    }
    setBusy(true);
    const { error } = await sb.rpc("admin_save_price_tiers", { p_tiers: out });
    setBusy(false);
    setMsg(error ? { ok: false, text: friendlyError(error) } : { ok: true, text: "Escalas guardadas. Ya se usan en la página de presupuesto." });
  }
  const sorted = [...rows].sort((a, b) => (Number(a.hasta) || Infinity) - (Number(b.hasta) || Infinity));
  return (
    <Card title="Precios por tamaño (presupuesto de la web)">
      <p className="mb-3 text-sm text-muted">
        En <a href="/presupuesto" target="_blank" className="text-accent hover:underline">mibalneario.com.ar/presupuesto</a> el interesado pone cuántas carpas y sombrillas tiene y ve el precio de su escala al instante.
        Se cuentan carpas + sombrillas. Dejá «Hasta» vacío en la última (sin límite). Si no cargás escalas, la página solo toma el pedido sin mostrar precio.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead><tr className="text-left text-xs text-muted"><th className="pb-1 pr-2">Hasta (espacios)</th><th className="pr-2">Anual</th><th className="pr-2">Entrada temporada</th><th className="pr-2">Cada cuota</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="py-1 pr-2"><Input aria-label="Hasta" inputMode="numeric" placeholder="sin límite" value={r.hasta} onChange={(e) => set(i, "hasta", e.target.value)} /></td>
                <td className="pr-2"><Input aria-label="Anual" inputMode="decimal" value={r.anual} onChange={(e) => set(i, "anual", e.target.value)} /></td>
                <td className="pr-2"><Input aria-label="Entrada" inputMode="decimal" value={r.entrada} onChange={(e) => set(i, "entrada", e.target.value)} /></td>
                <td className="pr-2"><Input aria-label="Cuota" inputMode="decimal" value={r.cuota} onChange={(e) => set(i, "cuota", e.target.value)} /></td>
                <td><button type="button" className="px-2 text-muted hover:text-danger" aria-label="Quitar escala" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setRows([...rows, { hasta: "", anual: "", entrada: "", cuota: "" }])} disabled={rows.length >= 10}>Agregar escala</Button>
        <Button loading={busy} onClick={save}>Guardar escalas</Button>
      </div>
      {sorted.length > 0 && sorted.every((r) => r.anual) && (
        <ul className="mt-3 text-xs text-muted">
          {sorted.map((r, i) => {
            const from = i === 0 ? 1 : Number(sorted[i - 1].hasta) + 1;
            return <li key={i}>{r.hasta ? `De ${from} a ${r.hasta}` : `Desde ${from}`} espacios: anual {formatMoney(parseMoney(r.anual))} · temporada {formatMoney((parseMoney(r.entrada) ?? 0) + 2 * (parseMoney(r.cuota) ?? 0))}</li>;
          })}
        </ul>
      )}
      {msg && <p className={msg.ok ? "mt-2 text-sm text-ok" : "mt-2 text-sm text-danger"}>{msg.text}</p>}
    </Card>
  );
}
