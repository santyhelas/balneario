"use client";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { cx } from "@/components/ui";

export type AnnouncementTone = "info" | "novedad" | "importante";
type A = { id: string; titulo: string; texto: string; tipo: AnnouncementTone };
const TONE: Record<AnnouncementTone, { box: string; tag: string }> = {
  novedad: { box: "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-50", tag: "Novedad" },
  info: { box: "border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-50", tag: "Información" },
  importante: { box: "border-amber-400 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-50", tag: "Importante" },
};

export function AnnouncementCard({ a, onDismiss, busy }: { a: A; onDismiss?: () => void; busy?: boolean }) {
  return (
    <div role="status" className={cx("flex flex-wrap items-start justify-between gap-3 rounded-2xl border px-4 py-3 text-sm", TONE[a.tipo].box)}>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider opacity-70">Mi Balneario · {TONE[a.tipo].tag}</div>
        <div className="font-semibold">{a.titulo}</div>
        <p className="mt-0.5 whitespace-pre-wrap">{a.texto}</p>
      </div>
      {onDismiss && (
        <button type="button" disabled={busy} onClick={onDismiss} className="shrink-0 rounded-lg border border-current/30 bg-white/60 px-3 py-1 font-semibold hover:bg-white dark:bg-black/20">Entendido</button>
      )}
    </div>
  );
}

/** Avisos del equipo de Mi Balneario para el balneario (aparecen en el panel hasta tocar «Entendido»). */
export function Announcements() {
  const [list, setList] = useState<A[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    getSupabase().rpc("my_announcements").then(({ data }) => setList((data as A[] | null) ?? []), () => undefined);
  }, []);
  if (!list.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {list.map((a) => (
        <AnnouncementCard key={a.id} a={a} busy={busy === a.id} onDismiss={async () => {
          setBusy(a.id);
          const { error } = await getSupabase().rpc("dismiss_announcement", { p_id: a.id });
          setBusy(null);
          if (!error) setList((l) => l.filter((x) => x.id !== a.id));
        }} />
      ))}
    </div>
  );
}
