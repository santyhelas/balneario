"use client";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { formatDateTime } from "@/lib/format";
import { SyncNotice } from "@/components/shell";
import { Alert, Button, Card, Spinner, cx } from "@/components/ui";

type Check = { id: string; nombre: string; estado: "ok" | "aviso" | "error"; detalle: string };
type Health = {
  ahora: string;
  base: { tamanio: number };
  balnearios: { id: string; nombre: string; pausado: boolean; ultima_copia: string | null; ultima_copia_auto: string | null; copias: number;
    drive: { correo: string | null; ultimo_ok: string | null; error: string | null; error_fecha: string | null } | null; ultimo_movimiento: string | null }[];
};
const DOT = { ok: "bg-emerald-500", aviso: "bg-amber-500", error: "bg-rose-500" } as const;
const hoursAgo = (ts: string | null) => (ts ? (Date.now() - new Date(ts).getTime()) / 3_600_000 : Infinity);
const ago = (ts: string | null) => {
  if (!ts) return "nunca";
  const h = hoursAgo(ts);
  return h < 1 ? "hace un rato" : h < 24 ? `hace ${Math.floor(h)} h` : `hace ${Math.floor(h / 24)} días`;
};

/** Estado del sistema: servicios, correo y copias de seguridad de cada balneario. */
export default function OwnerHealth() {
  const sb = getSupabase();
  const svc = useLoader(async () => {
    const r = await fetch("/api/admin/estado", { cache: "no-store" });
    const j = await r.json().catch(() => ({ error: "Respuesta inválida del servidor." }));
    if (!r.ok) throw new Error(j.error ?? "No se pudo revisar.");
    return j as { revisado: string; checks: Check[] };
  }, [], 300_000);
  const h = useLoader(async () => unwrap(await sb.rpc("admin_health")) as Health, [], 300_000);
  const checks = svc.data?.checks ?? [];
  const bad = checks.filter((c) => c.estado === "error").length;
  const warn = checks.filter((c) => c.estado === "aviso").length;
  // Una copia automática por día: si pasaron más de 3 días con movimientos nuevos, algo anda mal (o nadie entró).
  const rows = (h.data?.balnearios ?? []).map((b) => {
    const moved = b.ultimo_movimiento && (!b.ultima_copia || new Date(b.ultimo_movimiento) > new Date(b.ultima_copia));
    const copia: Check["estado"] = b.copias === 0 ? (b.ultimo_movimiento ? "error" : "aviso") : moved && hoursAgo(b.ultima_copia) > 72 ? "aviso" : "ok";
    const drive: Check["estado"] | null = !b.drive ? null : b.drive.error && (!b.drive.ultimo_ok || (b.drive.error_fecha ?? "") > b.drive.ultimo_ok) ? "error" : hoursAgo(b.drive.ultimo_ok) > 72 ? "aviso" : "ok";
    return { ...b, copia, driveEstado: drive };
  });

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Estado del sistema</h1>
          <p className="text-sm text-muted">Si todo anda: servicios, correo y copias de seguridad de cada balneario.</p>
        </div>
        <Button variant="secondary" onClick={() => { svc.reload(); h.reload(); }}>Revisar de nuevo</Button>
      </div>
      <SyncNotice error={h.error} stale={h.stale} updatedAt={h.updatedAt} onRetry={h.reload} />
      {h.error && /admin_health|schema cache|function/i.test(h.error) && !h.data && <Alert tone="warn" className="mb-3">Falta correr la actualización 0056 en Supabase.</Alert>}
      {svc.data && (
        <div className={cx("mb-4 rounded-2xl p-5 text-center", bad ? "bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-100" : warn ? "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100" : "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100")}>
          <div className="text-xl font-bold">{bad ? `${bad} ${bad === 1 ? "cosa no anda" : "cosas no andan"}` : warn ? `Anda todo, con ${warn} ${warn === 1 ? "detalle" : "detalles"} para mirar` : "Anda todo bien"}</div>
          <div className="text-xs opacity-75">Revisado {formatDateTime(svc.data.revisado)}</div>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Servicios">
          {svc.error ? <p className="text-sm text-danger">{svc.error}</p> : !svc.data ? <Spinner small /> : (
            <ul className="divide-y divide-line">
              {checks.map((c) => (
                <li key={c.id} className="flex items-start gap-3 py-2.5">
                  <span className={cx("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", DOT[c.estado])} aria-label={c.estado} />
                  <div><div className="font-medium">{c.nombre}</div><div className="text-xs text-muted">{c.detalle}</div></div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Copias de seguridad por balneario">
          {!h.data ? (h.loading && <Spinner small />) : rows.length === 0 ? <p className="text-sm text-muted">No hay balnearios.</p> : (
            <ul className="divide-y divide-line">
              {rows.map((b) => (
                <li key={b.id} className="flex items-start gap-3 py-2.5">
                  <span className={cx("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", DOT[b.driveEstado === "error" ? "error" : b.copia])} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{b.nombre}{b.pausado ? " (en pausa)" : ""}</div>
                    <div className="text-xs text-muted">
                      Última copia: {ago(b.ultima_copia)} · {b.copias} guardadas · último cambio: {ago(b.ultimo_movimiento)}
                    </div>
                    <div className={cx("text-xs", b.driveEstado === "error" ? "text-danger" : "text-muted")}>
                      {b.drive ? `Drive (${b.drive.correo ?? "conectado"}): ${b.driveEstado === "error" ? `error — ${b.drive.error}` : `última subida ${ago(b.drive.ultimo_ok)}`}` : "Sin Google Drive conectado"}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {h.data && <p className="mt-3 text-xs text-muted">Tamaño de la base: {(h.data.base.tamanio / 1_048_576).toFixed(0)} MB (el plan gratis de Supabase permite 500 MB).</p>}
        </Card>
      </div>
    </>
  );
}
