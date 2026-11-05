// Renovación de temporada: clientes de la temporada pasada, su lugar habitual
// y si ya volvieron a reservar o si su lugar ya está tomado este año.

/** Temporada "2026/2027" → del 01/07/2026 al 30/06/2027 (igual que el historial de clientes). */
export function seasonRange(season: string): { from: string; to: string } {
  const y = Number(season.slice(0, 4));
  return { from: `${y}-07-01`, to: `${y + 1}-06-30` };
}

export function shiftSeason(season: string, n: number): string {
  const y = Number(season.slice(0, 4)) + n;
  return `${y}/${y + 1}`;
}

/** Misma fecha un año después (el 29/02 pasa al 28/02). */
export function nextYear(iso: string): string {
  const y = Number(iso.slice(0, 4)) + 1;
  const md = iso.slice(5) === "02-29" ? "02-28" : iso.slice(5);
  return `${y}-${md}`;
}

const days = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000) + 1;

export type PrevSeg = { reservation_id: string; customer_id: string; space_id: string; code: string; kind: "carpa" | "sombrilla"; start_date: string; end_date: string };
export type Person = { id: string; first_name: string; last_name: string | null; phone: string | null };
export type NewSeg = { reservation_id: string; number: number; customer_id: string; space_id: string; start_date: string; end_date: string };
export type Mark = { customer_id: string; status: "pendiente" | "avisado" | "no_vuelve"; contacted_at: string | null };

export type RenewalStatus = "ya_reservo" | "no_vuelve" | "avisado" | "pendiente";

export type Renewal = {
  customer: Person;
  /** Lugar donde pasó más días. */
  main: { space_id: string; code: string; kind: "carpa" | "sombrilla" };
  others: string[];
  stays: number;
  totalDays: number;
  /** Primer y último día que estuvo (temporada pasada). */
  first: string;
  last: string;
  /** Mismas fechas, este año (para proponerle). */
  proposeFrom: string;
  proposeTo: string;
  status: RenewalStatus;
  contactedAt: string | null;
  /** Reservas que ya tiene en la temporada nueva. */
  newReservations: { id: string; number: number; start: string; end: string }[];
  /** Otra persona ya tiene su lugar en esas fechas de este año. */
  takenBy: { number: number; start: string; end: string } | null;
};

export function buildRenewals(prev: PrevSeg[], people: Person[], next: NewSeg[], marks: Mark[]): Renewal[] {
  const byPerson = new Map(people.map((p) => [p.id, p]));
  const markOf = new Map(marks.map((m) => [m.customer_id, m]));
  const groups = new Map<string, PrevSeg[]>();
  for (const s of prev) groups.set(s.customer_id, [...(groups.get(s.customer_id) ?? []), s]);

  const out: Renewal[] = [];
  for (const [cid, segs] of groups) {
    const customer = byPerson.get(cid);
    if (!customer) continue;
    const perSpace = new Map<string, { code: string; kind: "carpa" | "sombrilla"; days: number; first: string }>();
    for (const s of segs) {
      const cur = perSpace.get(s.space_id) ?? { code: s.code, kind: s.kind, days: 0, first: s.start_date };
      cur.days += days(s.start_date, s.end_date);
      if (s.start_date < cur.first) cur.first = s.start_date;
      perSpace.set(s.space_id, cur);
    }
    const ranked = [...perSpace.entries()].sort((a, b) => b[1].days - a[1].days || a[1].first.localeCompare(b[1].first));
    const [mainId, mainInfo] = ranked[0];
    const first = segs.reduce((m, s) => (s.start_date < m ? s.start_date : m), segs[0].start_date);
    const last = segs.reduce((m, s) => (s.end_date > m ? s.end_date : m), segs[0].end_date);
    // Se proponen las fechas de su estadía más larga (si vino dos veces, no se junta todo en una).
    const perRes = new Map<string, { from: string; to: string }>();
    for (const s of segs) {
      const r = perRes.get(s.reservation_id) ?? { from: s.start_date, to: s.end_date };
      if (s.start_date < r.from) r.from = s.start_date;
      if (s.end_date > r.to) r.to = s.end_date;
      perRes.set(s.reservation_id, r);
    }
    const longest = [...perRes.values()].sort((x, y) => days(y.from, y.to) - days(x.from, x.to) || x.from.localeCompare(y.from))[0];
    const proposeFrom = nextYear(longest.from);
    const proposeTo = nextYear(longest.to);

    const mine = next.filter((n) => n.customer_id === cid);
    const newReservations = [...new Map(mine.map((n) => [n.reservation_id, { id: n.reservation_id, number: n.number, start: n.start_date, end: n.end_date }])).values()]
      .sort((a, b) => a.start.localeCompare(b.start));
    const clash = next.find((n) => n.customer_id !== cid && n.space_id === mainId && n.start_date <= proposeTo && n.end_date >= proposeFrom);

    const m = markOf.get(cid);
    const status: RenewalStatus = newReservations.length ? "ya_reservo" : m?.status === "no_vuelve" ? "no_vuelve" : m?.status === "avisado" ? "avisado" : "pendiente";
    out.push({
      customer,
      main: { space_id: mainId, code: mainInfo.code, kind: mainInfo.kind },
      others: ranked.slice(1).map(([, v]) => v.code),
      stays: new Set(segs.map((s) => s.reservation_id)).size,
      totalDays: segs.reduce((a, s) => a + days(s.start_date, s.end_date), 0),
      first, last, proposeFrom, proposeTo,
      status,
      contactedAt: m?.contacted_at ?? null,
      newReservations,
      takenBy: clash ? { number: clash.number, start: clash.start_date, end: clash.end_date } : null,
    });
  }
  // Primero carpas y después sombrillas, por número de lugar.
  return out.sort((a, b) => (a.main.kind === b.main.kind ? 0 : a.main.kind === "carpa" ? -1 : 1) || a.main.code.localeCompare(b.main.code, "es", { numeric: true }));
}
