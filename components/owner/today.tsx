"use client";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase/client";
import { useLoader } from "@/lib/data";
import { formatMoney } from "@/lib/format";
import { upcoming } from "@/components/owner/collections";
import type { Overview } from "@/components/owner/board";

/** «Para hoy» en el resumen: cobros vencidos, interesados para contactar y gastos fijos para cargar. */
export function OwnerToday() {
  const sb = getSupabase();
  const q = useLoader(async () => {
    const [ov, leads, rec] = await Promise.all([sb.rpc("admin_overview"), sb.rpc("admin_leads"), sb.rpc("admin_recurring")]);
    const o = ov.data as Overview | null;
    const hoy = o?.hoy ?? "";
    const dues = o ? upcoming(o.balnearios, hoy).filter((d) => !d.auto && d.fecha < hoy) : [];
    const all = (leads.data as { interesados?: { proximo_contacto: string | null; estado: string; origen: string | null }[] } | null)?.interesados ?? [];
    const l = all.filter((x) => (x.proximo_contacto && x.proximo_contacto <= hoy && !["cerrado", "perdido"].includes(x.estado)) || (x.origen === "web" && x.estado === "nuevo"));
    const r = ((rec.data as { vencido: boolean }[] | null) ?? []).filter((x) => x.vencido);
    return { dues, leads: l.length, rec: r.length };
  }, [], 300_000);
  const d = q.data;
  if (!d || (!d.dues.length && !d.leads && !d.rec)) return null;
  const item = "flex items-center justify-between gap-3 rounded-xl bg-white/70 px-3 py-2 text-sm font-medium hover:bg-white dark:bg-black/20 dark:hover:bg-black/30";
  return (
    <section className="rounded-2xl bg-gradient-to-br from-sky-100 to-amber-50 p-4 text-[#1f2a30] dark:from-sky-950/60 dark:to-amber-950/30 dark:text-sky-50">
      <h2 className="mb-2 text-base font-semibold">Para hoy</h2>
      <div className="grid gap-2 sm:grid-cols-3">
        {d.dues.length > 0 && <Link href="/dueno/cobros" className={item}><span>{d.dues.length} {d.dues.length === 1 ? "cobro vencido" : "cobros vencidos"}</span><span className="tabular">{formatMoney(d.dues.reduce((a, x) => a + x.importe, 0))} →</span></Link>}
        {d.leads > 0 && <Link href="/dueno/interesados" className={item}><span>{d.leads} {d.leads === 1 ? "interesado para contactar" : "interesados para contactar"}</span><span>→</span></Link>}
        {d.rec > 0 && <Link href="/dueno/gastos" className={item}><span>{d.rec} {d.rec === 1 ? "gasto fijo para cargar" : "gastos fijos para cargar"}</span><span>→</span></Link>}
      </div>
    </section>
  );
}
