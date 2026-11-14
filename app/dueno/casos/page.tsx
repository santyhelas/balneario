"use client";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, EmptyState, Field, Modal, Select, Spinner, TextField, Textarea, cx } from "@/components/ui";

type Numero = { clave?: string; valor: number; texto: string };
type Caso = { id: string; balneario_id: string | null; nombre: string; ciudad: string | null; frase: string | null; autor: string | null; permiso: boolean; numeros: Numero[]; publicado: boolean; orden: number };

/** Casos de éxito para la página principal: números reales de un balneario + una frase, solo con su permiso. */
export default function OwnerCases() {
  const sb = getSupabase();
  const q = useLoader(async () => unwrap(await sb.rpc("admin_success_cases")) as Caso[], [], 300_000);
  const [edit, setEdit] = useState<Caso | "nuevo" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Casos de éxito</h1>
          <p className="text-sm text-muted">Lo que se muestra en la página principal, en «Balnearios que ya lo usan». Solo se publica con permiso del balneario.</p>
        </div>
        <Button onClick={() => setEdit("nuevo")}>Nuevo caso</Button>
      </div>
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {q.error && /admin_success|schema cache|function/i.test(q.error) && !q.data && <Alert tone="warn">Falta correr la actualización 0057 en Supabase.</Alert>}
      {msg && <Alert tone="ok" className="mb-3">{msg}</Alert>}
      {!q.data ? (q.loading && <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando…</div>) : q.data.length === 0 ? (
        <EmptyState>Todavía no hay casos. Elegí un balneario contento, pedile permiso y una frase, y armalo acá.</EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {q.data.map((c) => (
            <Card key={c.id} title={<span className="flex items-center gap-2">{c.nombre} {c.publicado ? <Badge tone="ok">En la página</Badge> : <Badge tone="muted">Borrador</Badge>}</span>}>
              <Preview c={c} />
              <div className="mt-3 flex gap-2"><Button variant="secondary" onClick={() => setEdit(c)}>Editar</Button></div>
            </Card>
          ))}
        </div>
      )}
      {edit && <CaseModal c={edit === "nuevo" ? null : edit} onClose={() => setEdit(null)}
        onSaved={(t) => { setEdit(null); setMsg(t); q.reload(); }} />}
    </>
  );
}

function Preview({ c }: { c: Pick<Caso, "nombre" | "ciudad" | "frase" | "autor" | "numeros"> }) {
  return (
    <div className="rounded-2xl bg-[#eaf5f6] p-4 text-[#13252e]">
      {c.numeros.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {c.numeros.map((n, i) => (
            <div key={i} className="rounded-xl bg-white p-2.5"><div className="text-2xl font-extrabold text-[#0b4f6c]">{Number(n.valor).toLocaleString("es-AR")}</div><div className="text-xs opacity-75">{n.texto}</div></div>
          ))}
        </div>
      )}
      {c.frase && <p className="mt-3 text-sm">“{c.frase}”</p>}
      <div className="mt-3 text-sm font-bold">{c.nombre}</div>
      <div className="text-xs opacity-70">{[c.autor, c.ciudad].filter(Boolean).join(" · ")}</div>
    </div>
  );
}

function CaseModal({ c, onClose, onSaved }: { c: Caso | null; onClose: () => void; onSaved: (t: string) => void }) {
  const sb = getSupabase();
  const bal = useLoader(async () => ((unwrap(await sb.rpc("admin_overview")) as { balnearios: { id: string; nombre: string }[] }).balnearios), [], 0);
  const [ws, setWs] = useState(c?.balneario_id ?? "");
  const [name, setName] = useState(c?.nombre ?? "");
  const [city, setCity] = useState(c?.ciudad ?? "");
  const [quote, setQuote] = useState(c?.frase ?? "");
  const [author, setAuthor] = useState(c?.autor ?? "");
  const [consent, setConsent] = useState(c?.permiso ?? false);
  const [pub, setPub] = useState(c?.publicado ?? false);
  const [stats, setStats] = useState<Numero[]>([]);
  const [chosen, setChosen] = useState<Numero[]>(c?.numeros ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!ws) { setStats([]); return; }
    sb.rpc("admin_case_stats", { p_workspace_id: ws }).then(({ data }) => setStats((data as Numero[] | null) ?? []));
    const b = bal.data?.find((x) => x.id === ws);
    if (b && !name) setName(b.nombre);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, bal.data]);
  const isOn = (n: Numero) => chosen.some((x) => x.clave === n.clave);
  const toggle = (n: Numero) => setChosen(isOn(n) ? chosen.filter((x) => x.clave !== n.clave) : chosen.length >= 4 ? chosen : [...chosen, n]);

  async function save() {
    if (pub && !consent) return setErr("Para publicarlo marcá que tenés el permiso del balneario.");
    setBusy(true);
    // Los números se guardan fijos (como están hoy): «Actualizar números» los vuelve a tomar.
    const numeros = chosen.map((n) => ({ clave: n.clave, valor: stats.find((s) => s.clave === n.clave)?.valor ?? n.valor, texto: n.texto }));
    const { error } = await sb.rpc("admin_save_success_case", { p_id: c?.id ?? null, p: { balneario_id: ws || null, nombre: name, ciudad: city, frase: quote, autor: author, permiso: consent, publicado: pub, numeros } });
    setBusy(false);
    if (error) return setErr(friendlyError(error));
    onSaved(pub ? "Guardado. Aparece en la página principal en menos de una hora." : "Guardado como borrador.");
  }
  return (
    <Modal open wide title={c ? `Editar · ${c.nombre}` : "Nuevo caso de éxito"} onClose={onClose} busy={busy}
      footer={<>
        {c && <Button variant="ghost" className="mr-auto text-danger" onClick={async () => {
          if (!confirmDelete) return setConfirmDelete(true);
          const { error } = await sb.rpc("admin_delete_success_case", { p_id: c.id });
          if (error) return setErr(friendlyError(error));
          onSaved("Caso borrado.");
        }}>{confirmDelete ? "¿Seguro? Tocá de nuevo" : "Borrar"}</Button>}
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button loading={busy} onClick={save}>Guardar</Button>
      </>}>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <Field label="Balneario" htmlFor="caso-ws">
            <Select id="caso-ws" value={ws} onChange={(e) => setWs(e.target.value)}>
              <option value="">— Elegí uno —</option>
              {(bal.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.nombre}</option>)}
            </Select>
          </Field>
          <TextField label="Nombre que se muestra" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          <div className="grid grid-cols-2 gap-2">
            <TextField label="Ciudad / playa" value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} />
            <TextField label="Quién lo dice" value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={100} placeholder="Ej.: Lucía, encargada" />
          </div>
          <Field label="Frase del balneario" htmlFor="caso-frase"><Textarea id="caso-frase" rows={3} value={quote} onChange={(e) => setQuote(e.target.value)} maxLength={600} placeholder="Lo que te dijo, con sus palabras." /></Field>
          {stats.length > 0 && (
            <div>
              <div className="mb-1 text-sm font-medium">Números para mostrar <span className="text-xs text-muted">(hasta 4)</span></div>
              <div className="flex flex-wrap gap-2">
                {stats.map((n) => (
                  <button key={n.clave} type="button" onClick={() => toggle(n)}
                    className={cx("rounded-xl border px-3 py-1.5 text-left text-sm", isOn(n) ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-surface-2")}>
                    <strong className="tabular">{Number(n.valor).toLocaleString("es-AR")}</strong> {n.texto}
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> El balneario me dio permiso para mostrar su nombre, la frase y estos números.</label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={pub} disabled={!consent} onChange={(e) => setPub(e.target.checked)} /> Mostrar en la página principal</label>
          {err && <p className="text-sm text-danger">{err}</p>}
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-muted">Así se va a ver:</div>
          <Preview c={{ nombre: name || "Nombre del balneario", ciudad: city, frase: quote, autor: author, numeros: chosen.map((n) => ({ ...n, valor: stats.find((s) => s.clave === n.clave)?.valor ?? n.valor })) }} />
        </div>
      </div>
    </Modal>
  );
}
