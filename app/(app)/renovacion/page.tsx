"use client";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatDateTime, todayISO } from "@/lib/format";
import { seasonOf } from "@/lib/history";
import { buildRenewals, seasonRange, shiftSeason, type Mark, type NewSeg, type Person, type PrevSeg, type Renewal, type RenewalStatus } from "@/lib/renewal";
import { whatsappLink } from "@/lib/reservations";
import { renewalMessage } from "@/lib/whatsapp-messages";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Badge, Card, EmptyState, Input, Select, Spinner, cx } from "@/components/ui";

type SegRow = {
  reservation_id: string; space_id: string; start_date: string; end_date: string;
  spaces: { code: string; kind: "carpa" | "sombrilla" } | null;
  reservations: { number: number; customer_id: string } | null;
};

const STATUS: Record<RenewalStatus, { label: string; tone: "ok" | "info" | "warn" | "muted" }> = {
  ya_reservo: { label: "Ya reservó", tone: "ok" },
  avisado: { label: "Avisado", tone: "info" },
  no_vuelve: { label: "No vuelve", tone: "muted" },
  pendiente: { label: "Sin avisar", tone: "warn" },
};
const FILTERS: { v: RenewalStatus | "todos"; label: string }[] = [
  { v: "todos", label: "Todos" }, { v: "pendiente", label: "Sin avisar" }, { v: "avisado", label: "Avisados" },
  { v: "ya_reservo", label: "Ya reservaron" }, { v: "no_vuelve", label: "No vuelven" },
];
const dm = (iso: string) => formatDate(iso).slice(0, 5);

/** Lee una consulta grande en partes (las listas de ids no pueden ser muy largas en la dirección). */
async function inChunks<T>(ids: string[], run: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 150) out.push(...(await run(ids.slice(i, i + 150))));
  return out;
}

/**
 * Renovación de temporada: los clientes de la temporada pasada con su lugar habitual,
 * para ofrecérselo primero. Muestra si ya reservaron, si se les avisó o si su lugar ya está tomado.
 */
export default function RenovacionPage() {
  const { ws } = useWorkspace();
  const sb = getSupabase();
  const today = todayISO(ws.timezone);
  const current = seasonOf(today);
  const [season, setSeason] = useState(current);
  const last = shiftSeason(season, -1);
  const [filter, setFilter] = useState<RenewalStatus | "todos">("todos");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = useLoader(async () => {
    const segSelect = "reservation_id, space_id, start_date, end_date, spaces(code, kind), reservations!inner(number, customer_id, status, is_courtesy)";
    const prevR = seasonRange(last);
    const nextR = seasonRange(season);
    const [prevRows, nextRows] = await Promise.all([
      sb.from("reservation_segments").select(segSelect).eq("workspace_id", ws.id).eq("active", true)
        .eq("reservations.status", "confirmada").eq("reservations.is_courtesy", false)
        .gte("start_date", prevR.from).lte("start_date", prevR.to).limit(20000),
      sb.from("reservation_segments").select(segSelect).eq("workspace_id", ws.id).eq("active", true)
        .eq("reservations.status", "confirmada")
        .gte("end_date", nextR.from).lte("start_date", nextR.to).limit(20000),
    ]);
    const prev = (unwrap(prevRows) as unknown as SegRow[]).filter((s) => s.reservations && s.spaces).map<PrevSeg>((s) => ({
      reservation_id: s.reservation_id, customer_id: s.reservations!.customer_id, space_id: s.space_id,
      code: s.spaces!.code, kind: s.spaces!.kind, start_date: s.start_date, end_date: s.end_date,
    }));
    const next = (unwrap(nextRows) as unknown as SegRow[]).filter((s) => s.reservations).map<NewSeg>((s) => ({
      reservation_id: s.reservation_id, number: s.reservations!.number, customer_id: s.reservations!.customer_id,
      space_id: s.space_id, start_date: s.start_date, end_date: s.end_date,
    }));
    const ids = [...new Set(prev.map((s) => s.customer_id))];
    const people = await inChunks(ids, async (part) =>
      unwrap(await sb.from("customers").select("id, first_name, last_name, phone").in("id", part)) as Person[]);
    const m = await sb.from("renewal_marks").select("customer_id, status, contacted_at").eq("workspace_id", ws.id).eq("season", season);
    const missing = !!m.error && (m.error.code === "42P01" || m.error.code === "PGRST205");
    const marks = missing ? [] : (unwrap(m) as Mark[]);
    return { list: buildRenewals(prev, people, next, marks), missing };
  }, [ws.id, season], 60_000);

  const list = useMemo(() => q.data?.list ?? [], [q.data]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { todos: list.length };
    for (const r of list) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [list]);
  const shown = list.filter((r) => (filter === "todos" || r.status === filter) &&
    (!search.trim() || `${r.customer.first_name} ${r.customer.last_name ?? ""} ${r.main.code} ${r.customer.phone ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())));

  async function mark(r: Renewal, status: "pendiente" | "avisado" | "no_vuelve") {
    setBusy(r.customer.id + status);
    setError(null);
    const { error: err } = await sb.rpc("set_renewal_mark", { p_workspace_id: ws.id, p_customer_id: r.customer.id, p_season: season, p_status: status });
    setBusy(null);
    if (err) setError(err.code === "PGRST202" ? "Falta aplicar la actualización 0025 de la base de datos." : friendlyError(err));
    q.reload();
  }

  const place = (r: Renewal) => `${r.main.kind === "sombrilla" ? "Sombrilla" : "Carpa"} ${r.main.code}`;

  return (
    <>
      <PageHeader
        title="Renovación de temporada"
        subtitle={`Clientes de la temporada ${last}, para ofrecerles primero su lugar en la ${season}.`}
        actions={
          <Select value={season} onChange={(e) => setSeason(e.target.value)} className="w-auto" aria-label="Temporada a renovar">
            {[current, shiftSeason(current, 1)].map((s) => <option key={s} value={s}>Renovar para {s}</option>)}
          </Select>
        }
      />
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {q.data?.missing && <Alert tone="warn" className="mb-3">Para guardar a quién se le avisó hay que aplicar la actualización 0025 de la base de datos. La lista igual se puede ver.</Alert>}
      {error && <Alert tone="danger" className="mb-3">{error}</Alert>}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button key={f.v} type="button" onClick={() => setFilter(f.v)}
            className={cx("rounded-full border px-3 py-1 text-sm", filter === f.v ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line hover:bg-surface-2")}>
            {f.label} ({counts[f.v] ?? 0})
          </button>
        ))}
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nombre, carpa o teléfono" className="ml-auto w-full sm:w-64" aria-label="Buscar" />
      </div>

      <Card>
        {q.loading && !q.data ? (
          <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando clientes…</div>
        ) : list.length === 0 ? (
          <EmptyState>No hay reservas en la temporada {last}. (No se cuentan las cortesías ni las canceladas.)</EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState>Nadie en este filtro.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((r) => {
              const st = STATUS[r.status];
              const name = `${r.customer.first_name} ${r.customer.last_name ?? ""}`.trim();
              const wa = whatsappLink(r.customer.phone, renewalMessage({ firstName: r.customer.first_name, balneario: ws.name, places: place(r), lastSeason: last, newSeason: season }));
              const reserveHref = `/reservas/nueva?cliente=${r.customer.id}&espacio=${r.main.space_id}&desde=${r.proposeFrom}&hasta=${r.proposeTo}`;
              return (
                <li key={r.customer.id} className="flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-md bg-surface-2 px-2 py-0.5 text-sm font-bold tabular">{place(r)}</span>
                      <span className="font-semibold">{name}</span>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {r.stays} {r.stays === 1 ? "estadía" : "estadías"} · {r.totalDays} días · del {dm(r.first)} al {dm(r.last)}
                      {r.others.length > 0 && ` · también usó ${r.others.join(", ")}`}
                      {r.customer.phone ? ` · ${r.customer.phone}` : " · sin teléfono"}
                      {r.status === "avisado" && r.contactedAt && ` · avisado ${formatDateTime(r.contactedAt, ws.timezone)}`}
                    </div>
                    {r.newReservations.length > 0 && (
                      <div className="mt-0.5 text-xs">
                        {r.newReservations.map((n) => (
                          <Link key={n.id} href={`/reservas/${n.id}`} className="mr-2 text-accent hover:underline">Reserva #{n.number} ({dm(n.start)} al {dm(n.end)})</Link>
                        ))}
                      </div>
                    )}
                    {r.takenBy && r.status !== "ya_reservo" && (
                      <div className="mt-0.5 text-xs font-medium text-warn">
                        Su {place(r).toLowerCase()} ya tiene otra reserva del {dm(r.takenBy.start)} al {dm(r.takenBy.end)} (#{r.takenBy.number}).
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {r.status !== "ya_reservo" && wa && (
                      <a href={wa} target="_blank" rel="noopener noreferrer" onClick={() => { if (!q.data?.missing) mark(r, "avisado"); }}
                        className="rounded-md border border-green-600/40 bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-800 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-200">
                        Ofrecer por WhatsApp
                      </a>
                    )}
                    {r.status === "pendiente" && !q.data?.missing && (
                      <SmallBtn onClick={() => mark(r, "avisado")} busy={busy === r.customer.id + "avisado"}>Ya le avisé</SmallBtn>
                    )}
                    {(r.status === "pendiente" || r.status === "avisado") && !q.data?.missing && (
                      <SmallBtn onClick={() => mark(r, "no_vuelve")} busy={busy === r.customer.id + "no_vuelve"}>No vuelve</SmallBtn>
                    )}
                    {(r.status === "avisado" || r.status === "no_vuelve") && (
                      <SmallBtn onClick={() => mark(r, "pendiente")} busy={busy === r.customer.id + "pendiente"}>Deshacer</SmallBtn>
                    )}
                    {r.status !== "ya_reservo" && r.status !== "no_vuelve" && (
                      <Link href={reserveHref} title={`Abre Nueva reserva con ${name}, la ${place(r).toLowerCase()} y las fechas del ${dm(r.proposeFrom)} al ${dm(r.proposeTo)}`}
                        className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-accent-fg hover:opacity-90">Reservar</Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <p className="mt-2 text-xs text-muted">
        «Reservar» abre Nueva reserva con el cliente, su lugar y las mismas fechas que el año pasado: podés cambiarlas antes de confirmar.
        Las temporadas van de julio a junio.
      </p>
    </>
  );
}

function SmallBtn({ onClick, busy, children }: { onClick: () => void; busy: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={busy}
      className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-semibold hover:bg-surface-2 disabled:opacity-60">{children}</button>
  );
}
