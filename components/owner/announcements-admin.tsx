"use client";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatDateTime, todayISO } from "@/lib/format";
import { SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, EmptyState, Field, Select, Spinner, TextField, Textarea } from "@/components/ui";
import { AnnouncementCard, type AnnouncementTone } from "@/components/announcements";

type Aviso = { id: string; titulo: string; texto: string; tipo: AnnouncementTone; hasta: string; creado: string; terminado: string | null; activo: boolean; leidos: number };

/** Avisos a todos los balnearios: les aparecen en su panel hasta que tocan «Entendido» (o hasta la fecha que elijas). */
export function OwnerAnnouncements() {
  const sb = getSupabase();
  const q = useLoader(async () => unwrap(await sb.rpc("admin_announcements")) as Aviso[], [], 120_000);
  const plus = (n: number) => { const d = new Date(todayISO() + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tone, setTone] = useState<AnnouncementTone>("novedad");
  const [until, setUntil] = useState(plus(14));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);

  async function publish() {
    if (title.trim().length < 2 || body.trim().length < 2) return setMsg({ tone: "danger", text: "Poné el título y el texto del aviso." });
    if (!confirm) return setConfirm(true);
    setBusy(true);
    const { error } = await sb.rpc("admin_publish_announcement", { p_title: title.trim(), p_body: body.trim(), p_tone: tone, p_ends_on: until });
    setBusy(false);
    setConfirm(false);
    if (error) return setMsg({ tone: "danger", text: friendlyError(error) });
    setTitle(""); setBody("");
    setMsg({ tone: "ok", text: "Aviso publicado. Lo ven todos los balnearios la próxima vez que entren a su panel." });
    q.reload();
  }

  return (
    <>
      <h2 className="text-lg font-semibold">Avisos a los balnearios</h2>
      <p className="mb-5 text-sm text-muted">Novedades o avisos importantes para todos los balnearios. Les aparece arriba en su panel hasta que tocan «Entendido».</p>
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {msg && <Alert tone={msg.tone} className="mb-3">{msg.text}</Alert>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Nuevo aviso">
          <div className="flex flex-col gap-3">
            <TextField label="Título" value={title} onChange={(e) => { setTitle(e.target.value); setConfirm(false); }} maxLength={120} placeholder="Ej.: Nueva función: reservas de grupo" />
            <Field label="Texto" htmlFor="aviso-texto"><Textarea id="aviso-texto" rows={5} value={body} onChange={(e) => { setBody(e.target.value); setConfirm(false); }} maxLength={2000} placeholder="Contá en pocas palabras qué cambió o qué tienen que hacer." /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Tipo" htmlFor="aviso-tipo">
                <Select id="aviso-tipo" value={tone} onChange={(e) => setTone(e.target.value as AnnouncementTone)}>
                  <option value="novedad">Novedad</option><option value="info">Información</option><option value="importante">Importante</option>
                </Select>
              </Field>
              <TextField label="Se muestra hasta el" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-muted">Así lo van a ver:</div>
              <AnnouncementCard a={{ id: "x", titulo: title || "Título del aviso", texto: body || "El texto del aviso.", tipo: tone }} />
            </div>
            <Button loading={busy} variant={confirm ? "danger" : "primary"} onClick={publish}>{confirm ? "Confirmar: mandar a todos los balnearios" : "Publicar aviso"}</Button>
          </div>
        </Card>
        <Card title="Avisos publicados">
          {!q.data ? (q.loading && <Spinner small />) : q.data.length === 0 ? <EmptyState>Todavía no publicaste avisos.</EmptyState> : (
            <ul className="divide-y divide-line">
              {q.data.map((a) => (
                <li key={a.id} className="flex flex-wrap items-start gap-2 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{a.titulo} {a.activo ? <Badge tone="ok">Visible</Badge> : <Badge tone="muted">Terminado</Badge>}</div>
                    <p className="line-clamp-2 text-sm text-muted">{a.texto}</p>
                    <div className="text-xs text-muted">{formatDateTime(a.creado)} · hasta el {formatDate(a.hasta)} · {a.leidos} {a.leidos === 1 ? "persona lo leyó" : "personas lo leyeron"}</div>
                  </div>
                  {a.activo && <Button variant="ghost" onClick={async () => {
                    const { error } = await sb.rpc("admin_end_announcement", { p_id: a.id });
                    if (error) setMsg({ tone: "danger", text: friendlyError(error) }); else q.reload();
                  }}>Dejar de mostrar</Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
