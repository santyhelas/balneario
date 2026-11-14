"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { formatDateTime } from "@/lib/format";
import { SyncNotice } from "@/components/shell";
import { EmptyState, Input, Spinner, cx } from "@/components/ui";
import { OwnerRequests } from "@/components/owner/requests";
import { OwnerAnnouncements } from "@/components/owner/announcements-admin";
import { useOwner } from "@/components/owner/context";

type Row = { id: string; nombre: string; propietario: string | null; carpas: number; sombrillas: number; ultimo_uso: string | null; pausado: string | null };

type Tab = "ver" | "pedidos" | "avisos";

/** Soporte: ver un balneario en solo lectura, los pedidos de los clientes y los avisos a todos. */
export default function SupportPage() {
  const [tab, setTab] = useState<Tab | null>(null);
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("t");
    setTab(t === "pedidos" || t === "avisos" ? t : "ver");
  }, []);
  function go(t: Tab) {
    setTab(t);
    window.history.replaceState(null, "", t === "ver" ? "/dueno/soporte" : `/dueno/soporte?t=${t}`);
  }
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Soporte</h1>
      <div className="my-4 inline-flex gap-1 rounded-xl bg-surface-2 p-1" role="tablist">
        {([["ver", "Ver un balneario"], ["pedidos", "Pedidos"], ["avisos", "Avisos"]] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => go(k)}
            className={cx("rounded-lg px-4 py-1.5 text-sm font-semibold", tab === k ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}>{l}</button>
        ))}
      </div>
      {tab === "ver" && <SupportList />}
      {tab === "pedidos" && <OwnerRequests />}
      {tab === "avisos" && <OwnerAnnouncements />}
    </>
  );
}

function SupportList() {
  const { mineId } = useOwner();
  const sb = getSupabase();
  const q = useLoader(async () => (unwrap(await sb.rpc("admin_overview")) as { balnearios: Row[] }).balnearios, [], 120_000);
  const [search, setSearch] = useState("");
  const t = search.trim().toLowerCase();
  const list = (q.data ?? []).filter((b) => b.id !== mineId && (!t || b.nombre.toLowerCase().includes(t) || (b.propietario ?? "").toLowerCase().includes(t)));
  return (
    <>
      <p className="mb-4 max-w-2xl text-sm text-muted">
        Mirá el balneario de un cliente tal como está (mapa, reservas, caja y usuarios) para ayudarlo. Es <strong>solo lectura</strong>: no podés cambiar nada,
        y al cliente le aparece el aviso «El soporte de Mi Balneario miró tus datos».
      </p>
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      <div className="mb-4 w-full sm:w-80"><Input type="search" aria-label="Buscar balneario" placeholder="Buscar por nombre o correo…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      {!q.data ? (q.loading && <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando…</div>) : list.length === 0 ? <EmptyState>No hay balnearios para mostrar.</EmptyState> : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((b) => (
            <li key={b.id}>
              <Link href={`/dueno/soporte/${b.id}`} className="block rounded-2xl border border-line bg-surface p-4 transition hover:border-accent hover:shadow-sm">
                <div className="font-semibold">{b.nombre}</div>
                <div className="truncate text-xs text-muted">{b.propietario ?? "Sin propietario"}</div>
                <div className="mt-2 text-xs text-muted">{b.carpas} carpas · {b.sombrillas} sombrillas · último uso {b.ultimo_uso ? formatDateTime(b.ultimo_uso) : "nunca"}</div>
                <div className="mt-3 text-sm font-semibold text-accent">Ver en solo lectura →</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
