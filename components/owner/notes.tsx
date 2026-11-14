"use client";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { Button, Modal, Spinner, Textarea } from "@/components/ui";

/** Notas internas del dueño sobre un balneario (el balneario no las ve). */
export function NotesModal({ ws, onClose }: { ws: { id: string; nombre: string }; onClose: () => void }) {
  const sb = getSupabase();
  const q = useLoader(async () => unwrap(await sb.rpc("admin_notes", { p_workspace_id: ws.id })) as { id: string; texto: string; fecha: string }[], [ws.id], 0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function add() {
    if (!text.trim()) return;
    setBusy(true);
    const { error } = await sb.rpc("admin_add_note", { p_workspace_id: ws.id, p_body: text.trim() });
    setBusy(false);
    if (error) return setErr(friendlyError(error));
    setText(""); setErr(null); q.reload();
  }
  const [confirm, setConfirm] = useState<string | null>(null);
  async function remove(id: string) {
    if (confirm !== id) return setConfirm(id);
    setConfirm(null);
    const { error } = await sb.rpc("admin_delete_note", { p_id: id });
    if (error) return setErr(friendlyError(error));
    q.reload();
  }
  return (
    <Modal open title={`Notas · ${ws.nombre}`} onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Cerrar</Button>}>
      <p className="mb-2 text-xs text-muted">Solo las ves vos. Sirven para acordarte de llamadas, pedidos y acuerdos.</p>
      <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder="Ej.: Llamé el 3/1, quiere 5 sombrillas más para febrero." aria-label="Nueva nota" />
      <div className="mt-2 flex justify-end"><Button loading={busy} disabled={!text.trim()} onClick={add}>Guardar nota</Button></div>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      <div className="mt-3 max-h-80 overflow-y-auto">
        {!q.data ? <Spinner small /> : q.data.length === 0 ? <p className="text-sm text-muted">Todavía no hay notas.</p> : (
          <ul className="flex flex-col gap-2">
            {q.data.map((n) => (
              <li key={n.id} className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-50">
                <p className="whitespace-pre-wrap">{n.texto}</p>
                <div className="mt-1 flex items-center justify-between text-xs opacity-70">
                  <span>{formatDateTime(n.fecha)}</span>
                  <button type="button" className="hover:underline" onClick={() => remove(n.id)}>{confirm === n.id ? "¿Seguro? Tocá de nuevo para borrar" : "Borrar"}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
