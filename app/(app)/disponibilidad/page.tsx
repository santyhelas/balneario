"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { addDays, formatDate, todayISO } from "@/lib/format";
import { daysOf } from "@/lib/stay";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Button, Field, Input, Select, Spinner, cx } from "@/components/ui";

type Space = { id: string; code: string; kind: "carpa" | "sombrilla"; active: boolean };
type Item = {
  item_type: "tramo" | "mantenimiento"; space_id: string; start_date: string; end_date: string;
  reservation_id: string | null; reservation_number: number | null; customer_name: string | null; is_courtesy: boolean;
  reservation_start: string | null; reservation_end: string | null; is_relocation: boolean; label: string | null;
};
type Block = { start: number; len: number; item: Item };

const WEEKDAY = ["D", "L", "M", "M", "J", "V", "S"];
const COL = 34; // ancho de cada día en píxeles

export default function DisponibilidadPage() {
  const { ws } = useWorkspace();
  const sb = getSupabase();
  const today = todayISO(ws.timezone);
  const [from, setFrom] = useState(today);
  const [span, setSpan] = useState(21);
  const [kind, setKind] = useState<"todas" | "carpa" | "sombrilla">("carpa");
  const [search, setSearch] = useState("");
  const to = addDays(from, span - 1);
  const days = useMemo(() => daysOf(from, to), [from, to]);

  const q = useLoader(async () => {
    const spaces = unwrap(await sb.from("spaces").select("id, code, kind, active").eq("workspace_id", ws.id)) as Space[];
    const items = unwrap(await sb.rpc("timeline_items", { p_workspace_id: ws.id, p_from: from, p_to: to })) as Item[];
    return { spaces, items };
  }, [ws.id, from, to]);

  const rows = useMemo(() => {
    if (!q.data) return [];
    const term = search.trim().toLowerCase();
    const spaces = q.data.spaces
      .filter((s) => (kind === "todas" || s.kind === kind) && (!term || s.code.toLowerCase().includes(term)))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code, "es", { numeric: true }));
    const bySpace = new Map<string, Item[]>();
    q.data.items.forEach((it) => bySpace.set(it.space_id, [...(bySpace.get(it.space_id) ?? []), it]));
    const idx = (d: string) => days.indexOf(d < from ? from : d > to ? to : d);
    return spaces.map((s) => {
      const blocks: Block[] = (bySpace.get(s.id) ?? []).map((it) => {
        const a = idx(it.start_date);
        const b = idx(it.end_date);
        return { start: a, len: b - a + 1, item: it };
      }).sort((x, y) => x.start - y.start);
      const busy = new Set<number>();
      blocks.forEach((bl) => { for (let i = bl.start; i < bl.start + bl.len; i++) busy.add(i); });
      return { space: s, blocks, busy, freeCount: days.length - busy.size };
    });
  }, [q.data, kind, search, days, from, to]);

  return (
    <>
      <PageHeader title="Disponibilidad" subtitle="Planificación por espacio y por día. Tocá un día libre para reservar desde esa fecha." actions={<Link href="/reservas/nueva"><Button>Nueva reserva</Button></Link>} />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Desde"><Input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-auto" /></Field>
        <Field label="Días">
          <Select value={span} onChange={(e) => setSpan(Number(e.target.value))} className="w-auto">
            {[7, 14, 21, 31, 45, 60].map((d) => <option key={d} value={d}>{d} días</option>)}
          </Select>
        </Field>
        <Field label="Tipo">
          <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="w-auto">
            <option value="carpa">Carpas</option>
            <option value="sombrilla">Sombrillas</option>
            <option value="todas">Todas</option>
          </Select>
        </Field>
        <Field label="Buscar N°"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ej: 17" className="w-24" /></Field>
        <Button variant="secondary" onClick={() => setFrom(addDays(from, -span))} aria-label="Período anterior">←</Button>
        <Button variant="secondary" onClick={() => setFrom(today)} disabled={from === today}>Hoy</Button>
        <Button variant="secondary" onClick={() => setFrom(addDays(from, span))} aria-label="Período siguiente">→</Button>
        {q.loading && <Spinner small />}
      </div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <Legend cls="bg-ok-soft border-ok/40" label="Libre" />
        <Legend cls="bg-danger/80 border-danger" label="Reservada / ocupada" />
        <Legend cls="bg-violet-500/80 border-violet-500" label="Cortesía" />
        <Legend cls="bg-zinc-500/80 border-zinc-500" label="Mantenimiento" />
        <Legend cls="bg-danger/80 border-white border-dashed" label="Con cambio de ubicación" />
      </div>
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />

      {!q.data ? (q.loading && <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando…</div>) : (
        <div className="overflow-auto rounded-xl border border-line bg-surface" style={{ maxHeight: "70dvh" }}>
          <div style={{ width: 72 + days.length * COL }}>
            {/* Encabezado de días */}
            <div className="sticky top-0 z-20 flex border-b border-line bg-surface">
              <div className="sticky left-0 z-30 w-[72px] shrink-0 border-r border-line bg-surface px-2 py-1 text-xs font-semibold text-muted">Espacio</div>
              {days.map((d) => {
                const wd = new Date(d + "T00:00:00Z").getUTCDay();
                return (
                  <div key={d} style={{ width: COL }} className={cx("shrink-0 py-1 text-center text-[10px] leading-tight", d === today ? "bg-accent text-accent-fg" : wd === 0 || wd === 6 ? "bg-surface-2" : "")}>
                    <div className="font-semibold">{WEEKDAY[wd]}</div>
                    <div>{d.slice(8, 10)}{d.slice(8, 10) === "01" || d === from ? `/${d.slice(5, 7)}` : ""}</div>
                  </div>
                );
              })}
            </div>
            {rows.length === 0 && <p className="p-4 text-sm text-muted">No hay espacios con ese filtro.</p>}
            {rows.map(({ space, blocks, busy }) => (
              <div key={space.id} className="flex border-b border-line last:border-0">
                <div className={cx("sticky left-0 z-10 flex w-[72px] shrink-0 items-center gap-1 border-r border-line bg-surface px-2 text-sm font-semibold", !space.active && "text-muted line-through")}>
                  <span className="text-[10px] font-normal text-muted">{space.kind === "carpa" ? "C" : "S"}</span>{space.code}
                </div>
                <div className="relative grid h-9 shrink-0" style={{ gridTemplateColumns: `repeat(${days.length}, ${COL}px)` }}>
                  {days.map((d, i) => busy.has(i) ? null : (
                    space.active && d >= today ? (
                      <Link key={d} href={`/reservas/nueva?espacio=${space.id}&desde=${d}`} style={{ gridColumn: i + 1, gridRow: 1 }}
                        className="m-0.5 rounded bg-ok-soft hover:bg-ok/30" title={`${space.code} libre el ${formatDate(d)} · tocá para reservar`} aria-label={`Reservar ${space.code} desde el ${formatDate(d)}`} />
                    ) : (
                      <div key={d} style={{ gridColumn: i + 1, gridRow: 1 }} className={cx("m-0.5 rounded", space.active ? "bg-surface-2" : "bg-surface-2 opacity-40")} />
                    )
                  ))}
                  {blocks.map((b, k) => {
                    const it = b.item;
                    const common = { gridColumn: `${b.start + 1} / span ${b.len}`, gridRow: 1 } as const;
                    if (it.item_type === "mantenimiento") {
                      return <div key={k} style={common} className="m-0.5 truncate rounded bg-zinc-500/80 px-1 text-[11px] leading-7 text-white" title={`Mantenimiento: ${it.label} (${formatDate(it.start_date)} al ${formatDate(it.end_date)})`}>🔧 {it.label}</div>;
                    }
                    return (
                      <Link key={k} href={`/reservas/${it.reservation_id}`} style={common}
                        className={cx("m-0.5 truncate rounded px-1 text-[11px] font-medium leading-7 hover:opacity-90",
                          it.is_courtesy ? "bg-violet-500/90 text-white" : "bg-danger text-bg", it.is_relocation && "border-2 border-dashed border-surface")}
                        title={`#${it.reservation_number} ${it.customer_name} · ${formatDate(it.start_date)} al ${formatDate(it.end_date)}${it.is_relocation ? " · reserva con cambio de ubicación" : ""} (estadía ${formatDate(it.reservation_start)} al ${formatDate(it.reservation_end)})`}>
                        {it.customer_name}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {q.data && (
        <p className="mt-2 text-xs text-muted">
          {rows.filter((r) => r.freeCount === days.length && r.space.active).length} {kind === "sombrilla" ? "sombrillas" : "espacios"} libres todo el período ({formatDate(from)} al {formatDate(to)}).
        </p>
      )}
    </>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return <span className="flex items-center gap-1.5"><span className={cx("inline-block h-3 w-5 rounded border", cls)} />{label}</span>;
}
