"use client";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { useLoader } from "@/lib/data";
import { formatDateTime } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { Alert, Button, Card, ConfirmDialog, Spinner } from "@/components/ui";

type Status = { conectado: boolean; email?: string | null; carpeta?: string | null; ultima_ok?: string | null; ultimo_archivo?: string | null; ultimo_error?: string | null; missing?: boolean };

const MSG: Record<string, { tone: "ok" | "danger" | "warn"; text: string }> = {
  conectado: { tone: "ok", text: "¡Listo! Google Drive quedó conectado y ya se subió la primera copia." },
  "conectado-sin-copia": { tone: "warn", text: "Google Drive quedó conectado, pero la primera copia no se pudo subir. Se reintenta sola; también podés tocar «Subir una copia ahora»." },
  cancelado: { tone: "warn", text: "Cancelaste la conexión con Google Drive. No se cambió nada." },
  "sin-permiso": { tone: "danger", text: "Google no dio el permiso para guardar archivos. Volvé a intentar y dejá tildada la opción de Google Drive." },
  vencido: { tone: "danger", text: "La conexión tardó demasiado. Volvé a intentar." },
  "solo-propietario": { tone: "danger", text: "Solo el propietario puede conectar Google Drive." },
  invitado: { tone: "danger", text: "En la demo no se puede conectar Google Drive." },
  "sin-configurar": { tone: "danger", text: "Falta configurar Google Drive en el servidor (Vercel). Seguí los pasos de configuración." },
  error: { tone: "danger", text: "No se pudo conectar Google Drive. Volvé a intentar en un rato." },
};

/** Copias automáticas en el Google Drive del propietario. */
export function DriveCard() {
  const { ws, role, isAdmin, isGuest } = useWorkspace();
  const sb = getSupabase();
  const [msg, setMsg] = useState<{ tone: "ok" | "danger" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState<"subir" | "desconectar" | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  useEffect(() => {
    const d = new URLSearchParams(window.location.search).get("drive");
    if (d && MSG[d]) setMsg(MSG[d]);
  }, []);

  const q = useLoader<Status>(async () => {
    const { data, error } = await sb.rpc("drive_status", { p_workspace_id: ws.id });
    if (error && (error.code === "PGRST202" || error.code === "42883")) return { conectado: false, missing: true };
    if (error) throw error;
    return data as Status;
  }, [ws.id], 60_000);

  async function post(path: string, kind: "subir" | "desconectar") {
    setBusy(kind);
    setMsg(null);
    const r = await fetch(path, { method: "POST" }).then(async (x) => ({ ok: x.ok, body: await x.json().catch(() => ({})) })).catch(() => ({ ok: false, body: { error: "Sin conexión." } }));
    setBusy(null);
    if (!r.ok) setMsg({ tone: "danger", text: (r.body as { error?: string }).error ?? "No se pudo completar." });
    else setMsg({ tone: "ok", text: kind === "subir" ? `Copia subida a Google Drive: ${(r.body as { archivo?: string }).archivo ?? ""}` : "Google Drive desconectado. Las copias que ya estaban en tu Drive quedan ahí." });
    q.reload();
  }

  if (isGuest) return null;
  const s = q.data;
  return (
    <Card title="Copias en Google Drive">
      {msg && <Alert tone={msg.tone} className="mb-3">{msg.text}</Alert>}
      {!s ? (
        <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando…</div>
      ) : s.missing ? (
        <p className="text-sm text-muted">Para usar Google Drive hay que aplicar la actualización 0024 de la base de datos.</p>
      ) : !s.conectado ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted">
            Todos los días se guarda sola una copia completa en una carpeta de tu Google Drive, fuera de este sistema.
            La página solo puede ver y tocar los archivos que ella misma crea; nada más de tu Drive.
          </p>
          {role === "propietario"
            ? <a href="/api/drive/conectar"><Button className="w-full">Conectar Google Drive</Button></a>
            : <p className="text-muted">Solo el propietario puede conectarlo.</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <p>Conectado{s.email ? <> con <strong>{s.email}</strong></> : ""}.</p>
          <p className="text-muted">
            Última copia subida: {s.ultima_ok ? <strong className="text-fg">{formatDateTime(s.ultima_ok, ws.timezone)}</strong> : "todavía ninguna"}.
            Se sube una por día a la madrugada y se guardan las últimas 30.
          </p>
          {s.ultimo_error && <Alert tone="warn">Último intento con problema: {s.ultimo_error}</Alert>}
          <div className="mt-1 flex flex-wrap gap-2">
            {s.carpeta && <a href={`https://drive.google.com/drive/folders/${s.carpeta}`} target="_blank" rel="noopener noreferrer"><Button variant="secondary">Abrir la carpeta</Button></a>}
            {isAdmin && <Button variant="secondary" loading={busy === "subir"} onClick={() => post("/api/drive/subir", "subir")}>Subir una copia ahora</Button>}
            {role === "propietario" && <Button variant="secondary" disabled={busy !== null} onClick={() => setConfirmOff(true)}>Desconectar</Button>}
          </div>
          <p className="text-xs text-muted">Para usar una copia de Drive: descargala de tu Drive y subila acá con «Importar una copia».</p>
        </div>
      )}
      <ConfirmDialog open={confirmOff} title="Desconectar Google Drive" confirmLabel="Desconectar" danger busy={busy === "desconectar"}
        message="Se dejan de subir copias a tu Drive. Las que ya están en tu Drive no se borran."
        onCancel={() => setConfirmOff(false)} onConfirm={() => { setConfirmOff(false); post("/api/drive/desconectar", "desconectar"); }} />
    </Card>
  );
}
