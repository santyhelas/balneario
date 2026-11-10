"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { addDays, formatDate } from "@/lib/format";
import { type Full } from "@/lib/reservations";
import { daysOf, indexGrid, isFreeFor, type GridRow } from "@/lib/stay";
import { useWorkspace } from "@/components/workspace";
import { useAction } from "@/components/payments";
import { Alert, Button, Field, Input, Modal, Select, Spinner, TextField, cx } from "@/components/ui";

/** Cambiar de carpa a una reserva: por un solo día o por el resto de la estadía. La usa la reserva y el mapa. */
export function RelocateModal({ open, full, today, onClose, onDone, initialDay, initialTarget }: {
  open: boolean; full: Full; today: string; onClose: () => void; onDone: (t: string) => void;
  /** Desde el mapa: el día que se está mirando y, si se eligió, la carpa de destino. */
  initialDay?: string; initialTarget?: string;
}) {
  const { ws } = useWorkspace();
  const { r, segments } = full;
  const firstDay = r.start_date > today ? r.start_date : today;
  const [mode, setMode] = useState<"dia" | "resto">("dia");
  // Por defecto: mañana si el cliente ya está en el balneario; si no, el primer día de la estadía.
  const tomorrow = addDays(today, 1);
  const [day, setDay] = useState(
    initialDay && initialDay >= firstDay && initialDay <= r.end_date ? initialDay : firstDay === today && tomorrow <= r.end_date ? tomorrow : firstDay,
  );
  const [kind, setKind] = useState<"carpa" | "sombrilla">(segments[0]?.spaces.kind ?? "carpa");
  const [target, setTarget] = useState(initialTarget ?? "");
  const [reason, setReason] = useState("");
  const [grid, setGrid] = useState<GridRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const a = useAction();
  const from = day;
  const to = mode === "dia" ? day : r.end_date;

  const current = segments.find((s) => s.start_date <= day && s.end_date >= day);

  async function load() {
    setLoading(true);
    setTarget((t) => (t && t === initialTarget ? t : ""));
    const res = await getSupabase().rpc("availability_grid", { p_workspace_id: ws.id, p_from: from, p_to: to, p_kind: kind });
    setLoading(false);
    if (res.error) return a.setError(friendlyError(res.error));
    const rows = res.data as GridRow[];
    setGrid(rows);
    // La carpa elegida en el mapa: si no está libre en esas fechas, se avisa abajo.
    if (initialTarget && !rows.some((g) => g.space_id === initialTarget)) setTarget("");
  }
  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, from, to, kind]);

  const options = useMemo(() => {
    if (!grid) return [];
    const idx = indexGrid(grid);
    const days = daysOf(from, to);
    const seen = new Map<string, string>();
    grid.forEach((g) => seen.set(g.space_id, g.code));
    return [...seen.entries()]
      .filter(([sid]) => sid !== current?.space_id && isFreeFor(idx, sid, days))
      .map(([space_id, code]) => ({ space_id, code }))
      .sort((x, y) => x.code.localeCompare(y.code, "es", { numeric: true }));
  }, [grid, from, to, current]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!target) return a.setError("Elegí el espacio de destino.");
    a.run(
      () => getSupabase().rpc("relocate_reservation", { p_reservation_id: r.id, p_target_space_id: target, p_from: from, p_to: to, p_expected_version: r.version, p_reason: reason || null }),
      () => { setReason(""); onDone(mode === "dia" ? `Cambio por el ${formatDate(day)} registrado. Al día siguiente vuelve a su lugar.` : `Cambio desde el ${formatDate(day)} registrado.`); },
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="Cambiar de carpa" busy={a.busy} wide>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5 text-sm sm:flex-row">
          {([["dia", "Solo por un día", "Vuelve automáticamente a su lugar al día siguiente"], ["resto", "Por el resto de la estadía", `Desde la fecha elegida hasta el ${formatDate(r.end_date)}`]] as const).map(([v, l, h]) => (
            <label key={v} className={cx("flex flex-1 cursor-pointer items-start gap-2 rounded-lg border p-2", mode === v ? "border-accent bg-accent-soft" : "border-line")}>
              <input type="radio" checked={mode === v} onChange={() => setMode(v)} className="mt-1" />
              <span><strong>{l}</strong><span className="block text-xs text-muted">{h}</span></span>
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={mode === "dia" ? "Día del cambio" : "Desde"}>
            <Input type="date" value={day} min={r.start_date} max={r.end_date} onChange={(e) => e.target.value && setDay(e.target.value)} />
          </Field>
          <Field label="Tipo de destino">
            <Select value={kind} onChange={(e) => setKind(e.target.value as "carpa" | "sombrilla")}><option value="carpa">Carpa</option><option value="sombrilla">Sombrilla</option></Select>
          </Field>
        </div>
        {current && <p className="text-sm text-muted">Ese día está en <strong className="text-fg">{current.spaces.code}</strong>.</p>}
        <Field label={`Libres del ${formatDate(from)} al ${formatDate(to)}`}>
          {loading ? <span className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Buscando…</span> : options.length === 0 ? (
            <Alert tone="warn">No hay {kind === "carpa" ? "carpas" : "sombrillas"} libres en esas fechas.</Alert>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(3.25rem,1fr))] gap-1.5">
              {options.map((o) => (
                <button key={o.space_id} type="button" onClick={() => setTarget(o.space_id)}
                  className={cx("rounded-md border py-1.5 text-sm font-semibold", target === o.space_id ? "border-accent bg-accent text-accent-fg" : "border-ok/50 bg-ok-soft text-ok")}>
                  {o.code}
                </button>
              ))}
            </div>
          )}
        </Field>
        {initialTarget && target === initialTarget && !options.some((o) => o.space_id === initialTarget) && (
          <Alert tone="warn">La carpa elegida no está libre todos esos días. Probá «Solo por un día» o elegí otra.</Alert>
        )}
        {kind !== segments[0]?.spaces.kind && <Alert tone="info">Cambia de tipo de espacio. El precio contratado no se modifica.</Alert>}
        <TextField label="Motivo (opcional)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Ej: quiere más sombra" />
        <p className="text-xs text-muted">La reserva sigue siendo una sola. Los pagos y la deuda no cambian. Se puede revertir desde el historial.</p>
        {a.error && <Alert tone="danger">{a.error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={a.busy}>Cancelar</Button>
          <Button type="submit" loading={a.busy} disabled={!target}>Confirmar cambio</Button>
        </div>
      </form>
    </Modal>
  );
}

