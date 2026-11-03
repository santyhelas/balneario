"use client";
import { useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { addDays, formatDate, todayISO } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { Alert, Button, Input, Spinner, cx } from "@/components/ui";

type Note = { id: string; day: string; text: string; done: boolean; version: number; created_at: string };

/**
 * Notas del día para el personal. Se guardan en la base (se ven en todos los dispositivos),
 * se actualizan solas cada minuto y no se borran: "quitar" las oculta y queda en el historial.
 */
export function DayNotes() {
  const { ws } = useWorkspace();
  const sb = getSupabase();
  const today = todayISO(ws.timezone);
  const [day, setDay] = useState(today);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = useLoader<{ notes: Note[]; pending: Note[]; missing?: boolean }>(async () => {
    const res = await sb.from("day_notes").select("id, day, text, done, version, created_at")
      .eq("workspace_id", ws.id).eq("active", true).eq("day", day).order("created_at");
    // Sin la actualización 0018 la tabla no existe todavía.
    if (res.error && (res.error.code === "42P01" || res.error.code === "PGRST205")) return { notes: [], pending: [], missing: true };
    const notes = unwrap(res) as Note[];
    // Pendientes de días anteriores (solo al mirar hoy).
    const pending = day === today
      ? (unwrap(await sb.from("day_notes").select("id, day, text, done, version, created_at")
          .eq("workspace_id", ws.id).eq("active", true).eq("done", false).lt("day", today).gte("day", addDays(today, -14)).order("day")) as Note[])
      : [];
    return { notes, pending };
  }, [ws.id, day, today], 60_000);

  async function add(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    const { error: err } = await sb.from("day_notes").insert({ workspace_id: ws.id, day, text: t.slice(0, 300) });
    setBusy(false);
    if (err) return setError(friendlyError(err));
    setText("");
    q.reload();
  }

  async function update(n: Note, patch: Partial<Note> & Record<string, unknown>) {
    setError(null);
    const { data, error: err } = await sb.from("day_notes").update({ ...patch, version: n.version + 1 }).eq("id", n.id).select("id");
    if (err) setError(friendlyError(err));
    else if (!data?.length) setError("No se pudo guardar. Recargá la página.");
    q.reload();
  }

  const toggle = (n: Note) => update(n, n.done ? { done: false, done_at: null, done_by: null } : { done: true, done_at: new Date().toISOString() });
  const label = day === today ? "Hoy" : day === addDays(today, 1) ? "Mañana" : formatDate(day);

  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-bold uppercase tracking-widest">Notas del día · {label}</h2>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setDay(addDays(day, -1))} className="rounded-lg border border-line px-2 py-1 text-sm hover:bg-surface-2" aria-label="Día anterior">←</button>
          <button type="button" onClick={() => setDay(today)} disabled={day === today} className="rounded-lg border border-line px-2 py-1 text-xs hover:bg-surface-2 disabled:opacity-50">Hoy</button>
          <button type="button" onClick={() => setDay(addDays(day, 1))} className="rounded-lg border border-line px-2 py-1 text-sm hover:bg-surface-2" aria-label="Día siguiente">→</button>
        </div>
      </div>

      {q.data?.missing ? (
        <p className="text-sm text-muted">Para usar las notas hay que aplicar la actualización 0018 de la base de datos.</p>
      ) : (
        <>
          <form onSubmit={add} className="mb-3 flex gap-2">
            <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={300}
              placeholder={day === today ? "Ej: hoy viene el proveedor de hielo" : `Nota para ${label.toLowerCase() === "mañana" ? "mañana" : `el ${label}`}`} aria-label="Nueva nota" />
            <Button type="submit" loading={busy} disabled={!text.trim()}>Agregar</Button>
          </form>
          {error && <Alert tone="danger" className="mb-2">{error}</Alert>}

          {q.loading && !q.data ? (
            <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando…</div>
          ) : (
            <>
              {(q.data?.notes.length ?? 0) === 0 && (q.data?.pending.length ?? 0) === 0 && (
                <p className="rounded-lg border border-dashed border-line py-4 text-center text-sm text-muted">Sin notas para {label === "Hoy" ? "hoy" : label === "Mañana" ? "mañana" : `el ${label}`}.</p>
              )}
              <ul className="flex flex-col gap-1">
                {q.data?.notes.map((n) => <NoteRow key={n.id} n={n} onToggle={() => toggle(n)} onRemove={() => update(n, { active: false })} />)}
              </ul>
              {(q.data?.pending.length ?? 0) > 0 && (
                <div className="mt-3">
                  <div className="mb-1 text-xs font-semibold text-warn">Quedaron pendientes de días anteriores</div>
                  <ul className="flex flex-col gap-1">
                    {q.data!.pending.map((n) => (
                      <NoteRow key={n.id} n={n} from={formatDate(n.day)} onToggle={() => toggle(n)} onRemove={() => update(n, { active: false })}
                        onMoveToday={() => update(n, { day: today })} />
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function NoteRow({ n, from, onToggle, onRemove, onMoveToday }: { n: Note; from?: string; onToggle: () => void; onRemove: () => void; onMoveToday?: () => void }) {
  return (
    <li className="group flex items-start gap-2 rounded-lg px-1 py-1.5 hover:bg-surface-2">
      <input type="checkbox" checked={n.done} onChange={onToggle} className="mt-1 h-4 w-4 shrink-0" aria-label={n.done ? "Marcar como pendiente" : "Marcar como hecha"} />
      <span className={cx("min-w-0 flex-1 text-sm", n.done && "text-muted line-through")}>
        {n.text}
        {from && <span className="ml-1 text-xs text-muted">({from})</span>}
      </span>
      {onMoveToday && <button type="button" onClick={onMoveToday} className="shrink-0 text-xs text-accent hover:underline">Pasar a hoy</button>}
      <button type="button" onClick={onRemove} className="shrink-0 text-xs text-muted hover:text-danger" aria-label="Quitar nota" title="Quitar">Quitar</button>
    </li>
  );
}
