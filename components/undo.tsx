"use client";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { Alert, ConfirmDialog } from "@/components/ui";

type LastChange = { change_id: string; reservation_number: number; description: string; at: string; actor_email: string | null };

/**
 * "Deshacer último cambio": muestra qué se va a revertir y pide confirmación.
 * Se usa desde la barra superior y desde Reservas.
 */
export function useUndo(onDone?: (text: string) => void) {
  const { ws } = useWorkspace();
  const [change, setChange] = useState<LastChange | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  async function start() {
    setMsg(null);
    const { data, error } = await getSupabase().rpc("last_reversible_change", { p_workspace_id: ws.id });
    if (error) return setMsg({ tone: "danger", text: friendlyError(error) });
    if (!data) return setMsg({ tone: "danger", text: "No hay cambios de carpa ni cancelaciones para deshacer." });
    setChange(data as LastChange);
    setOpen(true);
  }

  async function confirm() {
    if (!change) return;
    setBusy(true);
    const { error } = await getSupabase().rpc("revert_change", { p_change_id: change.change_id, p_reason: "Deshacer último cambio" });
    setBusy(false);
    setOpen(false);
    if (error) return setMsg({ tone: "danger", text: friendlyError(error) });
    const text = `Se deshizo: ${change.description} (reserva #${change.reservation_number}).`;
    setMsg({ tone: "ok", text });
    onDone?.(text);
  }

  const dialog = (
    <ConfirmDialog
      open={open}
      title="Deshacer último cambio"
      message={change ? <>Se va a revertir: <strong className="text-fg">{change.description}</strong> (reserva #{change.reservation_number}), hecho el {formatDateTime(change.at, ws.timezone)}{change.actor_email ? ` por ${change.actor_email}` : ""}. El cambio original queda en el historial.</> : null}
      confirmLabel="Deshacer"
      busy={busy}
      onConfirm={confirm}
      onCancel={() => setOpen(false)}
    />
  );
  const message = msg ? <Alert tone={msg.tone} className="mb-3">{msg.text}</Alert> : null;
  return { start, dialog, message, clearMessage: () => setMsg(null) };
}
