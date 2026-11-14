"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { SyncNotice } from "@/components/shell";
import { Badge, Card, EmptyState, Spinner } from "@/components/ui";
import { KPI_ICON, Kpi } from "@/components/owner/board";

type View = {
  hoy: string;
  balneario: { id: string; nombre: string; subtitulo: string | null; telefono: string | null; direccion: string | null; ancho: number; alto: number; mar: string | null; pausado: boolean; creado: string };
  espacios: { codigo: string; tipo: "carpa" | "sombrilla"; x: number; y: number; activo: boolean; ocupado: boolean }[];
  elementos: { tipo: string; nombre: string | null; x: number; y: number; ancho: number; alto: number; color: string | null }[];
  reservas: { numero: number; cliente: string; desde: string; hasta: string; estado: string; total: number; debe: number; espacios: string | null }[];
  caja: { fecha: string; abierta: boolean; apertura: number; esperado: number | null; contado: number | null; diferencia: number | null } | null;
  usuarios: { usuario: string | null; correo: string | null; rol: string }[];
  conteos: { clientes: number; reservas: number; deuda: number };
  accesos: { fecha: string; motivo: string | null }[];
};

/** Vista de soporte en solo lectura del balneario de un cliente. Cada ingreso queda registrado y el cliente lo ve. */
export default function SupportView() {
  const { id } = useParams<{ id: string }>();
  const sb = getSupabase();
  const q = useLoader(async () => unwrap(await sb.rpc("admin_support_view", { p_workspace_id: id, p_reason: null })) as View, [id], 120_000);
  const v = q.data;
  return (
    <>
      <Link href="/dueno/soporte" className="text-sm text-accent hover:underline">← Soporte</Link>
      <div className="my-3 flex flex-wrap items-center gap-2 rounded-2xl border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-950 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5 shrink-0" aria-hidden><path d={KPI_ICON.ojo} /></svg>
        <span><strong>Solo lectura.</strong> Estás viendo los datos del cliente; no se puede cambiar nada desde acá. El balneario ve que entraste.</span>
      </div>
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {!v ? (q.loading && <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando…</div>) : (
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{v.balneario.nombre} {v.balneario.pausado && <Badge tone="danger">En pausa</Badge>}</h1>
            <p className="text-sm text-muted">{[v.balneario.subtitulo, v.balneario.direccion, v.balneario.telefono].filter(Boolean).join(" · ") || "Sin datos de contacto"} · alta {formatDate(v.balneario.creado.slice(0, 10))}</p>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi icon={KPI_ICON.carpa} tone="sand" label="Ocupados hoy" value={`${v.espacios.filter((s) => s.ocupado).length} de ${v.espacios.filter((s) => s.activo).length}`} />
            <Kpi icon={KPI_ICON.calendario} label="Reservas" value={String(v.conteos.reservas)} />
            <Kpi icon={KPI_ICON.personas} label="Clientes" value={String(v.conteos.clientes)} />
            <Kpi icon={KPI_ICON.plata} tone={v.conteos.deuda > 0 ? "red" : "green"} label="Deuda de sus clientes" value={formatMoney(v.conteos.deuda)} />
          </div>
          <Card title={`Mapa de hoy (${formatDate(v.hoy)})`}>
            <MiniMap v={v} />
            <div className="mt-2 flex gap-4 text-xs text-muted">
              <span><span className="mr-1 inline-block h-3 w-3 rounded-sm bg-[#e0614a] align-middle" />Ocupado</span>
              <span><span className="mr-1 inline-block h-3 w-3 rounded-sm bg-[#3a9d6e] align-middle" />Libre</span>
              <span><span className="mr-1 inline-block h-3 w-3 rounded-sm bg-[#9aa3a8] align-middle" />Desactivado</span>
            </div>
          </Card>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Últimas reservas" className="lg:col-span-2">
              {v.reservas.length === 0 ? <EmptyState>Sin reservas.</EmptyState> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-xs text-muted"><th className="py-1 pr-2">N°</th><th className="pr-2">Cliente</th><th className="pr-2">Espacio</th><th className="pr-2">Fechas</th><th className="pr-2 text-right">Total</th><th className="text-right">Debe</th></tr></thead>
                    <tbody className="divide-y divide-line">
                      {v.reservas.map((r) => (
                        <tr key={r.numero} className={r.estado !== "confirmada" ? "text-muted line-through" : ""}>
                          <td className="py-1.5 pr-2 tabular">{r.numero}</td><td className="pr-2">{r.cliente}</td><td className="pr-2">{r.espacios ?? "—"}</td>
                          <td className="whitespace-nowrap pr-2 tabular">{formatDate(r.desde)} – {formatDate(r.hasta)}</td>
                          <td className="pr-2 text-right tabular">{formatMoney(r.total)}</td>
                          <td className={r.debe > 0 ? "text-right tabular font-semibold text-danger" : "text-right tabular"}>{formatMoney(r.debe)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <div className="flex flex-col gap-4">
              <Card title="Caja">
                {!v.caja ? <p className="text-sm text-muted">Nunca abrió la caja.</p> : (
                  <dl className="text-sm">
                    <div className="flex justify-between py-0.5"><dt className="text-muted">Última</dt><dd>{formatDate(v.caja.fecha)} · {v.caja.abierta ? <Badge tone="ok">Abierta</Badge> : <Badge tone="muted">Cerrada</Badge>}</dd></div>
                    <div className="flex justify-between py-0.5"><dt className="text-muted">Apertura</dt><dd className="tabular">{formatMoney(v.caja.apertura)}</dd></div>
                    {v.caja.contado != null && <div className="flex justify-between py-0.5"><dt className="text-muted">Contado</dt><dd className="tabular">{formatMoney(v.caja.contado)}</dd></div>}
                    {v.caja.diferencia != null && <div className="flex justify-between py-0.5"><dt className="text-muted">Diferencia</dt><dd className="tabular">{formatMoney(v.caja.diferencia)}</dd></div>}
                  </dl>
                )}
              </Card>
              <Card title="Usuarios">
                <ul className="divide-y divide-line text-sm">
                  {v.usuarios.map((u, i) => <li key={i} className="py-1.5"><strong>{u.usuario ?? u.correo ?? "—"}</strong> <span className="text-xs text-muted">· {u.rol}{u.usuario && u.correo && !u.correo.endsWith(".local") ? ` · ${u.correo}` : ""}</span></li>)}
                </ul>
              </Card>
              <Card title="Ingresos de soporte">
                <ul className="text-xs text-muted">{v.accesos.map((a, i) => <li key={i} className="py-0.5">{formatDateTime(a.fecha)}{a.motivo ? ` · ${a.motivo}` : ""}</li>)}</ul>
              </Card>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function MiniMap({ v }: { v: View }) {
  const W = v.balneario.ancho || 1000, H = v.balneario.alto || 700;
  const tents = v.espacios.filter((s) => s.x != null && s.y != null);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto max-h-[70vh] w-full rounded-xl bg-[#f3e3bd]" role="img" aria-label="Mapa del balneario en solo lectura">
      {v.balneario.mar === "top" && <rect x={0} y={0} width={W} height={70} fill="#5fa8d3" />}
      {v.balneario.mar === "bottom" && <rect x={0} y={H - 70} width={W} height={70} fill="#5fa8d3" />}
      {v.balneario.mar === "left" && <rect x={0} y={0} width={70} height={H} fill="#5fa8d3" />}
      {v.balneario.mar === "right" && <rect x={W - 70} y={0} width={70} height={H} fill="#5fa8d3" />}
      {v.elementos.map((f, i) => (
        <g key={i}>
          <rect x={f.x} y={f.y} width={f.ancho} height={f.alto} rx={6} fill={f.color ?? (f.tipo === "mar" ? "#5fa8d3" : "#d8c49a")} opacity={0.85} />
          {f.nombre && f.ancho > 60 && <text x={f.x + f.ancho / 2} y={f.y + f.alto / 2} textAnchor="middle" dominantBaseline="middle" fontSize={14} fill="#2b2b2b">{f.nombre}</text>}
        </g>
      ))}
      {tents.map((s) => (
        <g key={s.codigo} transform={`translate(${s.x},${s.y})`}>
          {s.tipo === "sombrilla"
            ? <circle r={16} fill={!s.activo ? "#9aa3a8" : s.ocupado ? "#e0614a" : "#3a9d6e"} stroke="#fff" strokeWidth={2} />
            : <rect x={-18} y={-18} width={36} height={36} rx={6} fill={!s.activo ? "#9aa3a8" : s.ocupado ? "#e0614a" : "#3a9d6e"} stroke="#fff" strokeWidth={2} />}
          <text textAnchor="middle" dominantBaseline="central" fontSize={13} fontWeight={700} fill="#fff">{s.codigo}</text>
        </g>
      ))}
    </svg>
  );
}
