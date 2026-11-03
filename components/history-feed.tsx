"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatMoney } from "@/lib/format";
import { METHOD_LABEL } from "@/lib/methods";
import { actorName, CATEGORY_LABEL, describeAudit, type AuditRow, type Category, type Lookups } from "@/lib/history";
import { useWorkspace } from "@/components/workspace";
import { Alert, Badge, Button, EmptyState, Spinner } from "@/components/ui";

export type Entry = {
  key: string;
  at: string;
  category: Category | "cobros";
  title: string;
  details: string[];
  href?: string;
  who: string;
  whoId: string | null;
  tag?: "res-alta" | "seg-alta";
  place?: string;
};

type PayRow = {
  id: string; reservation_id: string; kind: "cobro" | "devolucion" | "anulacion"; amount: number; method: string;
  usd_amount?: number | null; reason: string | null; note: string | null; created_at: string; created_by: string | null;
};

const PAGE = 200;

/** Lista del historial: cambios guardados en la base + cobros, devoluciones y anulaciones. */
export function HistoryFeed({
  from, to, tables, includePayments, actorId, search = "", emptyText = "No hay movimientos en esas fechas.",
}: {
  from: string; to: string;
  /** Tablas del historial a mostrar (null = todas). */
  tables: string[] | null;
  includePayments: boolean;
  actorId?: string;
  search?: string;
  emptyText?: string;
}) {
  const { ws } = useWorkspace();
  const sb = getSupabase();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ audit: string | null; pay: string | null; more: boolean }>({ audit: null, pay: null, more: false });
  const [users, setUsers] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    sb.rpc("workspace_users", { p_workspace_id: ws.id }).then(({ data }) => {
      const m = new Map<string, string>();
      for (const u of (data ?? []) as { user_id: string; username: string | null; email: string | null }[]) m.set(u.user_id, u.username || u.email || "Usuario");
      setUsers(m);
    });
  }, [sb, ws.id]);

  async function load(reset: boolean) {
    setLoading(true);
    setError(null);
    try {
      const fromTs = new Date(`${from}T00:00:00-03:00`).toISOString();
      const toTs = new Date(`${to}T23:59:59.999-03:00`).toISOString();
      const auditBefore = reset ? toTs : cursor.audit;
      const payBefore = reset ? toTs : cursor.pay;

      let audit: AuditRow[] = [];
      if (tables === null || tables.length > 0) {
        if (auditBefore) {
          let q = sb.from("audit_log").select("*").eq("workspace_id", ws.id).gte("at", fromTs).lt("at", auditBefore).order("at", { ascending: false }).limit(PAGE);
          if (tables) q = q.in("table_name", tables);
          if (actorId) q = q.eq("actor_id", actorId);
          audit = unwrap(await q) as AuditRow[];
        }
      }
      let pays: PayRow[] = [];
      if (includePayments && payBefore) {
        let q = sb.from("payments").select("*").eq("workspace_id", ws.id).gte("created_at", fromTs).lt("created_at", payBefore).order("created_at", { ascending: false }).limit(PAGE);
        if (actorId) q = q.eq("created_by", actorId);
        pays = unwrap(await q) as PayRow[];
      }

      // Datos para nombrar carpas, clientes y reservas.
      const resIds = new Set<string>();
      const custIds = new Set<string>();
      for (const a of audit) {
        const d = a.new_data ?? a.old_data ?? {};
        if (a.table_name === "reservation_segments" && d.reservation_id) resIds.add(String(d.reservation_id));
        if (a.table_name === "reservations" && d.customer_id) custIds.add(String(d.customer_id));
      }
      for (const p of pays) resIds.add(p.reservation_id);
      const resRows = resIds.size
        ? (unwrap(await sb.from("reservations").select("id, number, customer_id").in("id", [...resIds])) as { id: string; number: number; customer_id: string }[])
        : [];
      resRows.forEach((r) => custIds.add(r.customer_id));
      const custRows = custIds.size
        ? (unwrap(await sb.from("customers").select("id, first_name, last_name").in("id", [...custIds])) as { id: string; first_name: string; last_name: string | null }[])
        : [];
      const spaceRows = unwrap(await sb.from("spaces").select("id, code, kind").eq("workspace_id", ws.id)) as { id: string; code: string; kind: string }[];
      const L: Lookups = {
        spaces: new Map(spaceRows.map((s) => [s.id, { code: s.code, kind: s.kind }])),
        customers: new Map(custRows.map((c) => [c.id, `${c.first_name} ${c.last_name ?? ""}`.trim()])),
        reservations: new Map(resRows.map((r) => [r.id, { number: r.number, customer_id: r.customer_id }])),
      };

      const list: Entry[] = [];
      for (const a of audit) {
        const d = describeAudit(a, L);
        if (!d) continue;
        list.push({ key: `a${a.id}`, at: a.at, ...d, who: actorName(a.actor_email, users, a.actor_id), whoId: a.actor_id });
      }
      for (const p of pays) {
        const r = L.reservations.get(p.reservation_id);
        const c = r ? L.customers.get(r.customer_id) : undefined;
        const kind = p.kind === "cobro" ? "Cobro" : p.kind === "devolucion" ? "Devolución" : "Anulación de pago";
        list.push({
          key: `p${p.id}`, at: p.created_at, category: "cobros", href: `/reservas/${p.reservation_id}`,
          title: `${kind} de ${formatMoney(p.amount)} · Reserva #${r?.number ?? "?"}${c ? ` (${c})` : ""}`,
          details: [`${METHOD_LABEL[p.method] ?? p.method}${p.usd_amount ? ` · US$ ${p.usd_amount}` : ""}`, p.reason ? `Motivo: ${p.reason}` : "", p.note ?? ""].filter(Boolean),
          who: actorName(null, users, p.created_by), whoId: p.created_by,
        });
      }
      list.sort((x, y) => y.at.localeCompare(x.at));
      // Al crear una reserva, sus carpas van en el mismo renglón (no como renglones aparte).
      const created = new Map(list.filter((e) => e.tag === "res-alta").map((e) => [e.href, e]));
      for (const e of list) {
        if (e.tag !== "seg-alta") continue;
        const r = created.get(e.href);
        if (r && Math.abs(Date.parse(r.at) - Date.parse(e.at)) < 5000) {
          r.details = [...r.details, e.place ?? ""];
          e.tag = undefined;
          e.key = "";
        }
      }
      // Cambio de ubicación: los tramos nuevos se muestran como "Ahora: …" en el mismo renglón.
      for (const e of list) {
        if (!e.title.endsWith(": cambio de ubicación")) continue;
        for (const s of list) {
          if (s.tag === "seg-alta" && s.href === e.href && Math.abs(Date.parse(s.at) - Date.parse(e.at)) < 5000) {
            e.details = [...e.details.filter((x) => !x.startsWith("Motivo")), `Ahora: ${s.place}`, ...e.details.filter((x) => x.startsWith("Motivo"))];
            s.key = "";
          }
        }
      }
      const visible = list.filter((e) => e.key !== "");

      setEntries((prev) => {
        const merged = reset ? visible : [...prev, ...visible];
        const seen = new Set<string>();
        return merged.filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true)));
      });
      setCursor({
        audit: audit.length === PAGE ? audit[audit.length - 1].at : null,
        pay: pays.length === PAGE ? pays[pays.length - 1].created_at : null,
        more: audit.length === PAGE || pays.length === PAGE,
      });
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(true); }, [ws.id, from, to, JSON.stringify(tables), includePayments, actorId, users.size]); // eslint-disable-line react-hooks/exhaustive-deps

  const term = search.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const shown = term
    ? entries.filter((e) => `${e.title} ${e.details.join(" ")} ${e.who}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(term))
    : entries;

  // Agrupado por día (hora argentina).
  const day = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: ws.timezone }).format(new Date(iso));
  const time = (iso: string) => new Intl.DateTimeFormat("es-AR", { timeZone: ws.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  const groups: [string, Entry[]][] = [];
  for (const e of shown) {
    const k = day(e.at);
    if (groups.length && groups[groups.length - 1][0] === k) groups[groups.length - 1][1].push(e);
    else groups.push([k, [e]]);
  }

  return (
    <div>
      {error && <Alert tone="danger" className="mb-3">{error} <button className="underline" onClick={() => load(true)}>Reintentar</button></Alert>}
      {loading && entries.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando historial…</div>
      ) : shown.length === 0 ? (
        <EmptyState>{emptyText}</EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(([d, list]) => (
            <section key={d}>
              <h3 className="sticky top-14 z-10 mb-1 border-b border-line bg-bg/95 py-1 text-sm font-bold backdrop-blur">{formatDate(d)}</h3>
              <ul className="divide-y divide-line">
                {list.map((e) => (
                  <li key={e.key} className="flex gap-3 py-2 text-sm">
                    <span className="tabular w-12 shrink-0 pt-0.5 text-xs text-muted">{time(e.at)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {e.href ? <Link href={e.href} className="font-medium hover:underline">{e.title}</Link> : <span className="font-medium">{e.title}</span>}
                        <Badge tone="muted">{CATEGORY_LABEL[e.category]}</Badge>
                      </div>
                      {e.details.length > 0 && <div className="mt-0.5 text-xs text-muted">{e.details.join(" · ")}</div>}
                    </div>
                    <span className="hidden shrink-0 text-xs text-muted sm:block">{e.who}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {cursor.more && (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" onClick={() => load(false)} loading={loading}>Cargar más</Button>
        </div>
      )}
    </div>
  );
}

/** Lista de usuarios del balneario para filtrar el historial. */
export function useWorkspaceUsers() {
  const { ws } = useWorkspace();
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    getSupabase().rpc("workspace_users", { p_workspace_id: ws.id }).then(({ data }) => {
      setUsers(((data ?? []) as { user_id: string; username: string | null; email: string | null }[]).map((u) => ({ id: u.user_id, name: u.username || u.email || "Usuario" })));
    });
  }, [ws.id]);
  return users;
}
