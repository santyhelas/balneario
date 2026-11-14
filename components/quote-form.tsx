"use client";
import { useEffect, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { formatMoney } from "@/lib/format";
import { SITE_WHATSAPP_URL } from "@/lib/site";

type Tier = { hasta: number | null; anual: number; entrada: number; cuota: number };
const field = "mt-1 w-full rounded-xl border border-[#d9cfb8] bg-white px-3 py-2.5 text-base text-[#1f2a30] outline-none focus:border-[#0b6a87] focus:ring-2 focus:ring-[#0b6a87]/20";

/** Calculadora de precio + pedido de presupuesto (público). */
export function QuoteForm() {
  const [tiers, setTiers] = useState<Tier[] | null>(null);
  const [t, setT] = useState("");
  const [u, setU] = useState("");
  const [v, setV] = useState({ nombre: "", balneario: "", telefono: "", correo: "", ciudad: "", mensaje: "", web: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => { getSupabase().rpc("price_tiers").then(({ data }) => setTiers((data as Tier[] | null) ?? []), () => setTiers([])); }, []);
  const total = (Number(t) || 0) + (Number(u) || 0);
  const tier = total > 0 && tiers?.length ? tiers.find((x) => x.hasta == null || x.hasta >= total) ?? null : null;
  const set = (k: keyof typeof v) => ({ value: v[k], onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }) });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (total <= 0) return setErr("Poné cuántas carpas y sombrillas tenés.");
    if (v.nombre.trim().length < 2) return setErr("Poné tu nombre.");
    if (v.telefono.trim().length < 6 && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.correo.trim())) return setErr("Dejanos un teléfono o un correo para responderte.");
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch("/api/presupuesto", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...v, carpas: t || "0", sombrillas: u || "0" }) });
      const j = await r.json().catch(() => ({ error: "Respuesta inválida." }));
      if (!r.ok) throw new Error(j.error ?? "No se pudo mandar.");
      setDone(true);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "No se pudo mandar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 grid gap-5 md:grid-cols-5">
      <section className="rounded-3xl bg-white/90 p-5 shadow-sm ring-1 ring-[#e5dcc8] md:col-span-3">
        <h2 className="text-lg font-bold">1. Tu balneario</h2>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="text-sm font-medium">Carpas<input className={field} inputMode="numeric" value={t} onChange={(e) => setT(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="Ej.: 80" /></label>
          <label className="text-sm font-medium">Sombrillas<input className={field} inputMode="numeric" value={u} onChange={(e) => setU(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="Ej.: 10" /></label>
        </div>
        {done ? (
          <div className="mt-6 rounded-2xl bg-emerald-50 p-4 text-emerald-900">
            <div className="font-bold">¡Listo! Te escribimos en breve.</div>
            <p className="mt-1 text-sm">Mientras tanto podés probar todo el sistema en la demo, sin registrarte.</p>
            <a href="/" className="mt-3 inline-block rounded-full bg-[#0b6a87] px-5 py-2 text-sm font-bold text-white">Ir a la demo</a>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-6">
            <h2 className="text-lg font-bold">2. ¿Te escribimos? <span className="text-sm font-normal text-[#5b666c]">(opcional)</span></h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium">Tu nombre<input className={field} {...set("nombre")} maxLength={100} autoComplete="name" /></label>
              <label className="text-sm font-medium">Balneario<input className={field} {...set("balneario")} maxLength={100} /></label>
              <label className="text-sm font-medium">WhatsApp<input className={field} {...set("telefono")} maxLength={40} inputMode="tel" autoComplete="tel" /></label>
              <label className="text-sm font-medium">Correo<input className={field} type="email" {...set("correo")} maxLength={120} autoComplete="email" /></label>
              <label className="text-sm font-medium sm:col-span-2">Ciudad o playa<input className={field} {...set("ciudad")} maxLength={80} /></label>
              <label className="text-sm font-medium sm:col-span-2">¿Algo más que quieras contarnos?<textarea className={field} rows={3} {...set("mensaje")} maxLength={1500} /></label>
              <input type="text" tabIndex={-1} autoComplete="off" aria-hidden className="hidden" {...set("web")} />
            </div>
            {err && <p className="mt-3 text-sm font-medium text-[#b23a2b]">{err}</p>}
            <button type="submit" disabled={busy} className="mt-4 h-12 w-full rounded-full bg-[#0b6a87] text-base font-bold text-white hover:brightness-110 disabled:opacity-60">{busy ? "Mandando…" : "Quiero que me escriban"}</button>
            <p className="mt-2 text-xs text-[#5b666c]">Usamos tus datos solo para responderte. <a href="/privacidad" className="underline">Privacidad</a>.</p>
          </form>
        )}
      </section>
      <aside className="md:col-span-2">
        <div className="sticky top-4 rounded-3xl bg-[#0b6a87] p-5 text-white shadow-lg">
          <div className="text-xs font-semibold uppercase tracking-widest text-cyan-200">Tu precio</div>
          {total <= 0 ? <p className="mt-2 text-white/85">Poné cuántas carpas y sombrillas tenés.</p>
            : tiers === null ? <p className="mt-2 text-white/85">Calculando…</p>
            : !tier ? <p className="mt-2 text-white/85">Para {total} espacios te armamos una propuesta a medida. Dejanos tus datos y te escribimos.</p> : (
              <div className="mt-2 flex flex-col gap-4">
                <div>
                  <div className="text-sm text-white/80">Plan temporada</div>
                  <div className="text-3xl font-extrabold">{formatMoney(Number(tier.entrada) + 2 * Number(tier.cuota))}</div>
                  <div className="text-sm text-white/80">entrada {formatMoney(tier.entrada)} + 2 cuotas de {formatMoney(tier.cuota)} (1/2 y 1/3)</div>
                </div>
                <div className="border-t border-white/20 pt-3">
                  <div className="text-sm text-white/80">Plan anual (un solo pago)</div>
                  <div className="text-2xl font-extrabold">{formatMoney(tier.anual)}</div>
                </div>
                <p className="text-xs text-white/70">Para {total} {total === 1 ? "espacio" : "espacios"}. Incluye el mapa armado, la carga de tarifas y ayuda por WhatsApp.</p>
              </div>
            )}
          {SITE_WHATSAPP_URL && <a href={SITE_WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="mt-4 block rounded-full bg-[#25d366] py-2.5 text-center text-sm font-bold text-[#06210f]">Preguntar por WhatsApp</a>}
        </div>
      </aside>
    </div>
  );
}
