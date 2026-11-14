"use client";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase/client";
import { useLoader } from "@/lib/data";
import { cx } from "@/components/ui";

type Check = { id: string; nombre: string; estado: "ok" | "aviso" | "error"; detalle: string };
type Bal = { pausado: boolean; ultima_copia: string | null; copias: number; ultimo_movimiento: string | null; drive: { ultimo_ok: string | null; error: string | null; error_fecha: string | null } | null };
const DOT = { ok: "bg-emerald-500", aviso: "bg-amber-500", error: "bg-rose-500" } as const;
const hours = (ts: string | null) => (ts ? (Date.now() - new Date(ts).getTime()) / 3_600_000 : Infinity);

/** Estado del sistema en una línea, para el resumen. El detalle está en /dueno/estado. */
export function OwnerStatusStrip() {
  const q = useLoader(async () => {
    const [svc, h] = await Promise.all([
      fetch("/api/admin/estado", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<{ checks: Check[] } | null>,
      getSupabase().rpc("admin_health").then((r) => (r.data as { balnearios: Bal[] } | null)),
    ]);
    const checks = svc?.checks ?? [];
    const bal = (h?.balnearios ?? []).filter((b) => !b.pausado);
    const sinCopia = bal.filter((b) => b.copias === 0 ? !!b.ultimo_movimiento : !!b.ultimo_movimiento && new Date(b.ultimo_movimiento) > new Date(b.ultima_copia!) && hours(b.ultima_copia) > 72).length;
    const driveMal = bal.filter((b) => b.drive && b.drive.error && (!b.drive.ultimo_ok || (b.drive.error_fecha ?? "") > b.drive.ultimo_ok)).length;
    return { checks, total: bal.length, sinCopia, driveMal, ok: !!svc };
  }, [], 600_000);
  const d = q.data;
  if (!d) return null;
  const issues = d.checks.filter((c) => c.estado !== "ok");
  const worst = issues.some((c) => c.estado === "error") || d.driveMal > 0 ? "error" : issues.length || d.sinCopia || !d.ok ? "aviso" : "ok";
  const parts = [
    ...issues.map((c) => c.nombre),
    ...(d.sinCopia ? [`${d.sinCopia} sin copia reciente`] : []),
    ...(d.driveMal ? [`${d.driveMal} con error en Drive`] : []),
    ...(!d.ok ? ["no se pudo revisar los servicios"] : []),
  ];
  return (
    <Link href="/dueno/estado" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-surface px-3 py-2 text-xs hover:bg-surface-2">
      <span className="flex items-center gap-1.5 font-semibold">
        <span className={cx("h-2 w-2 rounded-full", DOT[worst])} />
        {worst === "ok" ? "Sistema: anda todo bien" : "Sistema: revisar"}
      </span>
      {parts.length > 0 && <span className="text-muted">{parts.join(" · ")}</span>}
      <span className="flex items-center gap-1 text-muted" title="Servicios">
        {d.checks.map((c) => <span key={c.id} title={`${c.nombre}: ${c.detalle}`} className={cx("h-1.5 w-1.5 rounded-full", DOT[c.estado])} />)}
      </span>
      <span className="text-muted">Copias: {d.total - d.sinCopia} de {d.total} al día</span>
      <span className="ml-auto text-accent">Ver detalle →</span>
    </Link>
  );
}
