// Lógica pura para armar los tramos de una estadía (sin acceso a la base).
// La disponibilidad viene de availability_grid (la misma consulta que usa el resto del sistema)
// y la base vuelve a validar todo al guardar.

export type GridRow = { space_id: string; code: string; kind: "carpa" | "sombrilla"; day: string; free: boolean; reason: string | null };
export type Segment = { space_id: string; start_date: string; end_date: string };
export type Run = { start: string; end: string; days: number };

function addDaysISO(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Lista de días AAAA-MM-DD entre dos fechas, inclusive. */
export function daysOf(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDaysISO(d, 1)) out.push(d);
  return out;
}

/** Agrupa días consecutivos en tramos. */
export function toRuns(days: string[]): Run[] {
  const sorted = [...days].sort();
  const runs: Run[] = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && addDaysISO(last.end, 1) === d) {
      last.end = d;
      last.days += 1;
    } else {
      runs.push({ start: d, end: d, days: 1 });
    }
  }
  return runs;
}

/** Índice: espacio → día → libre. */
export function indexGrid(rows: GridRow[]): Map<string, Map<string, boolean>> {
  const idx = new Map<string, Map<string, boolean>>();
  for (const r of rows) {
    if (!idx.has(r.space_id)) idx.set(r.space_id, new Map());
    idx.get(r.space_id)!.set(r.day, r.free);
  }
  return idx;
}

export function isFreeFor(idx: Map<string, Map<string, boolean>>, spaceId: string, days: string[]): boolean {
  const m = idx.get(spaceId);
  return !!m && days.every((d) => m.get(d) === true);
}

/** Días libres y ocupados de un espacio en el rango. */
export function splitDays(idx: Map<string, Map<string, boolean>>, spaceId: string, days: string[]) {
  const m = idx.get(spaceId);
  const free = days.filter((d) => m?.get(d) === true);
  const busy = days.filter((d) => m?.get(d) !== true);
  return { free, busy, freeRuns: toRuns(free), busyRuns: toRuns(busy) };
}

/**
 * Espacios que pueden cubrir un tramo completo, ordenados por cercanía de número al preferido
 * (los números cercanos suelen estar en la misma fila del plano).
 */
export type Pos = Map<string, { x: number; y: number }>;

/** Distancia en el plano entre dos espacios (Infinity si falta la ubicación de alguno). */
export function mapDistance(pos: Pos | undefined, a: string, b: string): number {
  const p = pos?.get(a), q = pos?.get(b);
  return p && q ? Math.hypot(p.x - q.x, p.y - q.y) : Infinity;
}

export function candidatesFor(
  idx: Map<string, Map<string, boolean>>,
  spaces: { space_id: string; code: string }[],
  run: Run,
  excludeId: string | null,
  preferredCode: string | null,
  pos?: Pos,
): { space_id: string; code: string }[] {
  const days = daysOf(run.start, run.end);
  const pref = preferredCode ? Number(preferredCode) : NaN;
  const byMap = !!excludeId && !!pos?.get(excludeId);
  return spaces
    .filter((s) => s.space_id !== excludeId && isFreeFor(idx, s.space_id, days))
    .sort((a, b) => {
      // Con el plano cargado, primero las que están físicamente más cerca (no las de número parecido).
      if (byMap) {
        const d = mapDistance(pos, excludeId!, a.space_id) - mapDistance(pos, excludeId!, b.space_id);
        if (Number.isFinite(d) && d !== 0) return d;
      }
      const da = Number.isFinite(pref) && Number.isFinite(Number(a.code)) ? Math.abs(Number(a.code) - pref) : 0;
      const db = Number.isFinite(pref) && Number.isFinite(Number(b.code)) ? Math.abs(Number(b.code) - pref) : 0;
      return da - db || a.code.localeCompare(b.code, "es", { numeric: true });
    });
}

/** Une asignaciones día → espacio en tramos contiguos (sin huecos ni superposiciones). */
export function buildSegments(assign: { day: string; space_id: string }[]): Segment[] {
  const sorted = [...assign].sort((a, b) => a.day.localeCompare(b.day));
  const segs: Segment[] = [];
  for (const a of sorted) {
    const last = segs[segs.length - 1];
    if (last && last.space_id === a.space_id && addDaysISO(last.end_date, 1) === a.day) {
      last.end_date = a.day;
    } else {
      segs.push({ space_id: a.space_id, start_date: a.day, end_date: a.day });
    }
  }
  return segs;
}

/**
 * Para un grupo que necesita varias carpas: elige las libres que quedan pegadas a la principal en el plano.
 * Va sumando de a una la más cercana a cualquiera de las ya elegidas (así forman una fila o un bloque),
 * y ante empate la más cercana a la principal.
 */
export function nearestGroup(mainId: string, freeIds: string[], count: number, pos: Pos): string[] {
  const chosen: string[] = [];
  const pool = freeIds.filter((id) => id !== mainId && pos.has(id));
  while (chosen.length < count && pool.length > 0) {
    let best = -1, bestD = Infinity, bestMain = Infinity;
    pool.forEach((id, i) => {
      const d = Math.min(...[mainId, ...chosen].map((c) => mapDistance(pos, c, id)));
      const dm = mapDistance(pos, mainId, id);
      if (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && dm < bestMain)) { best = i; bestD = d; bestMain = dm; }
    });
    if (best < 0) break;
    chosen.push(pool[best]);
    pool.splice(best, 1);
  }
  return chosen;
}
