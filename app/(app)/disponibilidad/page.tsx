"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { addDays, formatDate, todayISO } from "@/lib/format";
import { daysOf } from "@/lib/stay";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Button, Field, Input, Spinner, cx } from "@/components/ui";

type Space = { id: string; code: string; kind: "carpa" | "sombrilla"; active: boolean };
type Item = {
  item_type: "tramo" | "mantenimiento"; space_id: string; start_date: string; end_date: string;
  reservation_id: string | null; reservation_number: number | null; customer_name: string | null; is_courtesy: boolean;
  reservation_start: string | null; reservation_end: string | null; is_relocation: boolean; label: string | null;
};
type Block = { start: number; len: number; item: Item };

// Miércoles con "X" para no confundirlo con martes.
const WEEKDAY = ["D", "L", "M", "X", "J", "V", "S"];
const COL = 48; // ancho de cada día en píxeles
const LABEL_W = 96; // ancho de la columna del número de espacio
const FREE = "bg-green-500 hover:bg-green-600"; // libre: verde intenso
const TAKEN = "bg-red-600 text-white"; // reservada / ocupada: rojo intenso

export default function DisponibilidadPage() {
  const { ws } = useWorkspace();
  const sb = getSupabase();
  const today = todayISO(ws.timezone);
  const [from, setFrom] = useState(today);
  const [toInput, setToInput] = useState(addDays(today, 20));
  const [kind, setKind] = useState<"todas" | "carpa" | "sombrilla">("todas");
  const [search, setSearch] = useState("");
  // "Hasta" lo elige el usuario; si queda antes de "Desde", se muestra solo ese día. Máximo un año para que la grilla no se vuelva inmanejable.
  const MAX_DAYS = 366;
  const toClamped = toInput < from ? from : toInput;
  const to = toClamped > addDays(from, MAX_DAYS - 1) ? addDays(from, MAX_DAYS - 1) : toClamped;
  const span = daysOf(from, to).length;
  const shift = (n: number) => { setFrom(addDays(from, n)); setToInput(addDays(to, n)); };
  const days = useMemo(() => daysOf(from, to), [from, to]);

  const q = useLoader(async () => {
    const spaces = unwrap(await sb.from("spaces").select("id, code, kind, active").eq("workspace_id", ws.id)) as Space[];
    const items = unwrap(await sb.rpc("timeline_items", { p_workspace_id: ws.id, p_from: from, p_to: to })) as Item[];
    return { spaces, items };
  }, [ws.id, from, to]);

  const rows = useMemo(() => {
    if (!q.data) return [];
    const term = norm(search.trim());
    const bySpace0 = new Map<string, Item[]>();
    q.data.items.forEach((it) => bySpace0.set(it.space_id, [...(bySpace0.get(it.space_id) ?? []), it]));
    // Busca por número de espacio o por nombre / apellido del cliente (sin importar tildes ni mayúsculas).
    const spaces = q.data.spaces
      .filter((s) => (kind === "todas" || s.kind === kind) &&
        (!term || norm(s.code).includes(term) || (bySpace0.get(s.id) ?? []).some((it) => matchesName(it, term))))
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
  const nameTerm = norm(search.trim());
  const searchingName = !!nameTerm && rows.some((r) => r.blocks.some((b) => matchesName(b.item, nameTerm)));

  return (
    <>
      <PageHeader title="Disponibilidad" subtitle="Planificación por espacio y por día. Tocá un día libre para reservar desde esa fecha." actions={<Link href="/reservas/nueva"><Button>Nueva reserva</Button></Link>} />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Desde"><Input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-auto" /></Field>
        <Field label="Hasta"><Input type="date" value={to} min={from} onChange={(e) => e.target.value && setToInput(e.target.value)} className="w-auto" /></Field>
        <span className="pb-2 text-sm text-muted">{span} {span === 1 ? "día" : "días"}</span>
        <Field label="Mostrar">
          <div className="flex overflow-hidden rounded-lg border border-line" role="group" aria-label="Tipo de espacio">
            {([["todas", "Todas"], ["carpa", "Carpas"], ["sombrilla", "Sombrillas"]] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k}
                className={cx("px-3 py-2 text-sm font-medium", kind === k ? "bg-accent text-accent-fg" : "bg-surface hover:bg-surface-2")}>{l}</button>
            ))}
          </div>
        </Field>
        <Field label="Buscar"><Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="N° de carpa, nombre o apellido" className="w-64" /></Field>
        <Button variant="secondary" onClick={() => shift(-span)} aria-label="Período anterior">←</Button>
        <Button variant="secondary" onClick={() => { setFrom(today); setToInput(addDays(today, span - 1)); }} disabled={from === today}>Hoy</Button>
        <Button variant="secondary" onClick={() => shift(span)} aria-label="Período siguiente">→</Button>
        {q.loading && <Spinner small />}
      </div>
      {toClamped > to && <p className="mb-2 text-sm text-muted">Se muestra hasta un año por vez: del {formatDate(from)} al {formatDate(to)}.</p>}
      <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <Legend cls="bg-green-500 border-green-600" label="Libre" />
        <Legend cls="bg-red-600 border-red-700" label="Reservada / ocupada" />
        <Legend cls="bg-violet-500/80 border-violet-500" label="Cortesía" />
        <Legend cls="bg-zinc-500/80 border-zinc-500" label="Mantenimiento" />
        <Legend cls="bg-red-600 border-white border-dashed" label="Con cambio de ubicación" />
      </div>
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />

      {!q.data ? (q.loading && <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando…</div>) : (
        <div className="overflow-auto rounded-xl border border-line bg-surface" style={{ maxHeight: "80dvh" }}>
          <div style={{ width: LABEL_W + days.length * COL }}>
            {/* Encabezado de días */}
            <div className="sticky top-0 z-20 flex border-b border-line bg-surface">
              <div style={{ width: LABEL_W }} className="sticky left-0 z-30 shrink-0 border-r border-line bg-surface px-2 py-2 text-sm font-semibold text-muted">Espacio</div>
              {days.map((d) => {
                const wd = new Date(d + "T00:00:00Z").getUTCDay();
                return (
                  <div key={d} style={{ width: COL }} className={cx("shrink-0 py-1.5 text-center text-xs leading-tight", d === today ? "bg-accent text-accent-fg" : wd === 0 || wd === 6 ? "bg-surface-2" : "")}>
                    <div className="text-sm font-bold">{WEEKDAY[wd]}</div>
                    <div>{d.slice(8, 10)}{d.slice(8, 10) === "01" || d === from ? `/${d.slice(5, 7)}` : ""}</div>
                  </div>
                );
              })}
            </div>
            {rows.length === 0 && <p className="p-4 text-sm text-muted">{search.trim() ? `No hay carpas ni clientes que coincidan con "${search.trim()}" entre el ${formatDate(from)} y el ${formatDate(to)}. Si buscás un cliente, probá con otras fechas.` : "No hay espacios con ese filtro."}</p>}
            {rows.map(({ space, blocks, busy }, ri) => (
              <div key={space.id}>
              {kind === "todas" && (ri === 0 || rows[ri - 1].space.kind !== space.kind) && (
                <div className="border-b border-line bg-surface-2 py-1.5 text-sm font-bold" style={{ width: LABEL_W + days.length * COL }}>
                  <span className="sticky left-0 px-3">{space.kind === "carpa" ? "Carpas" : "Sombrillas"} ({rows.filter((r) => r.space.kind === space.kind).length})</span>
                </div>
              )}
              <div className="flex border-b border-line">
                <div style={{ width: LABEL_W }} className={cx("sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-line bg-surface px-2 text-base font-bold", !space.active && "text-muted line-through")}>
                  <span className="text-xs font-normal text-muted">{space.kind === "carpa" ? "Carpa" : "Sombr."}</span>{space.code}
                </div>
                <div className="relative grid h-12 shrink-0" style={{ gridTemplateColumns: `repeat(${days.length}, ${COL}px)` }}>
                  {days.map((d, i) => busy.has(i) ? null : (
                    space.active && d >= today ? (
                      <Link key={d} href={`/reservas/nueva?espacio=${space.id}&desde=${d}`} style={{ gridColumn: i + 1, gridRow: 1 }}
                        className={cx("m-1 rounded", FREE)} title={`${space.code} libre el ${formatDate(d)} · tocá para reservar`} aria-label={`Reservar ${space.code} desde el ${formatDate(d)}`} />
                    ) : (
                      <div key={d} style={{ gridColumn: i + 1, gridRow: 1 }} className={cx("m-1 rounded", space.active ? "bg-surface-2" : "bg-surface-2 opacity-40")} />
                    )
                  ))}
                  {blocks.map((b, k) => {
                    const it = b.item;
                    const common = { gridColumn: `${b.start + 1} / span ${b.len}`, gridRow: 1 } as const;
                    if (it.item_type === "mantenimiento") {
                      return <div key={k} style={common} className="m-1 truncate rounded bg-zinc-500 px-1.5 text-sm leading-[2.5rem] text-white" title={`Mantenimiento: ${it.label} (${formatDate(it.start_date)} al ${formatDate(it.end_date)})`}>{it.label}</div>;
                    }
                    return (
                      <Link key={k} href={`/reservas/${it.reservation_id}`} style={common}
                        className={cx("m-1 truncate rounded px-1.5 text-sm font-semibold leading-[2.5rem] hover:opacity-90",
                          it.is_courtesy ? "bg-violet-600 text-white" : TAKEN, searchingName && (matchesName(it, nameTerm) ? "ring-4 ring-amber-400" : "opacity-40"), it.is_relocation && "border-2 border-dashed border-surface")}
                        title={`#${it.reservation_number} ${it.customer_name} · ${formatDate(it.start_date)} al ${formatDate(it.end_date)}${it.is_relocation ? " · reserva con cambio de ubicación" : ""} (estadía ${formatDate(it.reservation_start)} al ${formatDate(it.reservation_end)})`}>
                        {it.customer_name}
                      </Link>
                    );
                  })}
                </div>
              </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {q.data && (
        <p className="mt-2 text-sm text-muted">
          {rows.filter((r) => r.freeCount === days.length && r.space.active).length} {kind === "sombrilla" ? "sombrillas" : kind === "carpa" ? "carpas" : "espacios"} libres todo el período ({formatDate(from)} al {formatDate(to)}).
        </p>
      )}
    </>
  );
}

function norm(t: string) {
  return t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function matchesName(it: Item, term: string) {
  return it.item_type === "tramo" && !!it.customer_name && norm(it.customer_name).includes(term);
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return <span className="flex items-center gap-1.5"><span className={cx("inline-block h-4 w-6 rounded border", cls)} />{label}</span>;
}
