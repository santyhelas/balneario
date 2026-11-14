"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { whatsappLink } from "@/lib/reservations";
import { mailtoLink, providerForEmail } from "@/lib/whatsapp-messages";
import { SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, EmptyState, Input, Modal, Spinner, TextField, Textarea, cx } from "@/components/ui";
import { KPI_ICON, Kpi, daysBetween, type Overview } from "@/components/owner/board";
import { upcoming, type Due } from "@/components/owner/collections";
import { useOwner } from "@/components/owner/context";

type Datos = { alias: string | null; cbu: string | null; titular: string | null; banco: string | null; emisor: string | null; cuit: string | null };
type Billing = {
  datos: Datos;
  balnearios: { id: string; nombre: string; telefono: string | null; correo: string | null; pagos: { id: string; importe: number; fecha: string; detalle: string | null; recibo: number | null }[] }[];
};
const MES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

export default function OwnerCollections() {
  const sb = getSupabase();
  const ov = useLoader(async () => unwrap(await sb.rpc("admin_overview")) as Overview, [], 120_000);
  const bi = useLoader(async () => unwrap(await sb.rpc("admin_billing")) as Billing, [], 120_000);
  const [remind, setRemind] = useState<Due | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const d = ov.data, b = bi.data;
  const hoy = d?.hoy ?? "";
  const dues = d ? upcoming(d.balnearios, hoy) : [];
  const vencido = dues.filter((x) => !x.auto && x.fecha < hoy);
  const prox30 = dues.filter((x) => x.fecha >= hoy && daysBetween(hoy, x.fecha) <= 30);
  const total12 = dues.reduce((a, x) => a + x.importe, 0);
  const byMonth = new Map<string, Due[]>();
  for (const x of dues) {
    const k = x.fecha < hoy ? "vencido" : x.fecha.slice(0, 7);
    byMonth.set(k, [...(byMonth.get(k) ?? []), x]);
  }
  const contact = (id: string) => b?.balnearios.find((x) => x.id === id);

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Cobros</h1>
      <p className="mb-5 text-sm text-muted">Lo que te tienen que pagar, los recordatorios y los recibos de lo que ya cobraste.</p>
      <SyncNotice error={ov.error ?? bi.error} stale={ov.stale || bi.stale} updatedAt={ov.updatedAt} onRetry={() => { ov.reload(); bi.reload(); }} />
      {bi.error && /admin_billing|schema cache|function/i.test(bi.error) && <Alert tone="warn" className="mb-3">Falta correr la actualización 0056 en Supabase.</Alert>}
      {msg && <Alert tone="ok" className="mb-3">{msg}</Alert>}
      {!d ? (ov.loading && <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando…</div>) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Kpi icon={KPI_ICON.reloj} tone={vencido.length ? "red" : "green"} label="Vencido sin cobrar" value={formatMoney(vencido.reduce((a, x) => a + x.importe, 0))} note={vencido.length ? `${vencido.length} ${vencido.length === 1 ? "pago" : "pagos"}` : "nada atrasado"} />
            <Kpi icon={KPI_ICON.calendario} tone="sand" label="Próximos 30 días" value={formatMoney(prox30.reduce((a, x) => a + x.importe, 0))} note={`${prox30.length} ${prox30.length === 1 ? "pago" : "pagos"}`} />
            <Kpi icon={KPI_ICON.plata} label="Próximos 12 meses" value={formatMoney(total12)} note="si todos pagan a tiempo" />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="flex flex-col gap-4 lg:col-span-2">
              <Card title="Calendario de cobros">
                {dues.length === 0 ? <EmptyState>No hay cobros pendientes en los próximos 12 meses.</EmptyState> : (
                  <div className="flex flex-col gap-4">
                    {[...byMonth.entries()].map(([k, items]) => (
                      <section key={k}>
                        <h3 className={cx("mb-1.5 flex items-baseline justify-between text-sm font-semibold", k === "vencido" && "text-danger")}>
                          <span>{k === "vencido" ? "Vencido" : `${MES[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`}</span>
                          <span className="tabular text-muted">{formatMoney(items.reduce((a, x) => a + x.importe, 0))}</span>
                        </h3>
                        <ul className="divide-y divide-line rounded-xl border border-line">
                          {items.map((x) => (
                            <li key={x.key} className="flex flex-wrap items-center gap-3 px-3 py-2">
                              <div className="w-14 shrink-0 text-center">
                                <div className="text-lg font-bold leading-none tabular">{Number(x.fecha.slice(8, 10))}</div>
                                <div className="text-[10px] uppercase text-muted">{MES[Number(x.fecha.slice(5, 7)) - 1].slice(0, 3)}</div>
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="font-medium">{x.b.nombre}</div>
                                <div className="text-xs text-muted">{x.concepto}</div>
                              </div>
                              <span className="tabular font-semibold">{formatMoney(x.importe)}</span>
                              {x.auto ? <Badge tone="ok">Débito</Badge>
                                : x.fecha < hoy ? <Badge tone="danger">Vencido</Badge>
                                : daysBetween(hoy, x.fecha) <= 7 ? <Badge tone="warn">Esta semana</Badge> : null}
                              {!x.auto && <Button variant="secondary" onClick={() => setRemind(x)}>Recordar</Button>}
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}
                <p className="mt-3 text-xs text-muted">Para anotar un pago que te hicieron, andá a <Link href="/dueno/balnearios" className="text-accent hover:underline">Balnearios</Link> → «Registrar pago».</p>
              </Card>
              <Payments billing={b} />
            </div>
            <BillingInfo datos={b?.datos ?? null} onSaved={() => { setMsg("Datos de cobro guardados."); bi.reload(); }} />
          </div>
        </div>
      )}
      {remind && <ReminderModal due={remind} contact={contact(remind.b.id)} datos={b?.datos ?? null} hoy={hoy} onClose={() => setRemind(null)} />}
    </>
  );
}

function Payments({ billing }: { billing: Billing | null }) {
  const [q, setQ] = useState("");
  if (!billing) return null;
  const t = q.trim().toLowerCase();
  const rows = billing.balnearios.flatMap((b) => b.pagos.map((p) => ({ ...p, balneario: b.nombre })))
    .filter((p) => !t || p.balneario.toLowerCase().includes(t)).sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 50);
  return (
    <Card title="Pagos recibidos y recibos">
      <div className="mb-3 w-full sm:w-72"><Input type="search" aria-label="Buscar balneario" placeholder="Buscar balneario…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {rows.length === 0 ? <EmptyState>Todavía no hay pagos registrados.</EmptyState> : (
        <ul className="divide-y divide-line">
          {rows.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{p.balneario}</div>
                <div className="text-xs text-muted">{formatDateTime(p.fecha)}{p.detalle ? ` · ${p.detalle}` : ""}</div>
              </div>
              <span className="tabular font-semibold">{formatMoney(p.importe)}</span>
              <a href={`/dueno/recibo/${p.id}`} target="_blank" rel="noopener noreferrer"
                className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-surface-2">{p.recibo ? `Recibo N° ${p.recibo}` : "Hacer recibo"}</a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function BillingInfo({ datos, onSaved }: { datos: Datos | null; onSaved: () => void }) {
  const [v, setV] = useState<Datos>({ alias: "", cbu: "", titular: "", banco: "", emisor: "", cuit: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (datos) setV({ alias: datos.alias ?? "", cbu: datos.cbu ?? "", titular: datos.titular ?? "", banco: datos.banco ?? "", emisor: datos.emisor ?? "", cuit: datos.cuit ?? "" }); }, [datos]);
  const f = (k: keyof Datos) => ({ value: v[k] ?? "", onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }) });
  return (
    <Card title="Tus datos de cobro" className="self-start">
      <p className="mb-3 text-xs text-muted">Van en los recordatorios y en los recibos.</p>
      <div className="flex flex-col gap-2">
        <TextField label="Alias" {...f("alias")} maxLength={60} />
        <TextField label="CBU / CVU" {...f("cbu")} maxLength={40} inputMode="numeric" />
        <TextField label="Titular de la cuenta" {...f("titular")} maxLength={100} />
        <TextField label="Banco o billetera" {...f("banco")} maxLength={60} />
        <TextField label="Nombre en el recibo" hint="Ej.: Mi Balneario — Santiago Helas" {...f("emisor")} maxLength={120} />
        <TextField label="CUIT (opcional)" {...f("cuit")} maxLength={20} />
        {err && <p className="text-sm text-danger">{err}</p>}
        <Button loading={busy} onClick={async () => {
          setBusy(true);
          const { error } = await getSupabase().rpc("admin_set_billing_info", { p: v });
          setBusy(false);
          if (error) return setErr(friendlyError(error));
          setErr(null); onSaved();
        }}>Guardar</Button>
      </div>
    </Card>
  );
}

function ReminderModal({ due, contact, datos, hoy, onClose }: { due: Due; contact?: Billing["balnearios"][number]; datos: Datos | null; hoy: string; onClose: () => void }) {
  const { email } = useOwner();
  const pago = [datos?.alias && `alias *${datos.alias}*`, datos?.cbu && `CBU ${datos.cbu}`].filter(Boolean).join(" o ");
  const quien = datos?.titular ? ` (a nombre de ${datos.titular}${datos.banco ? `, ${datos.banco}` : ""})` : "";
  const cuando = due.fecha < hoy ? `venció el ${formatDate(due.fecha)}` : due.fecha === hoy ? "vence hoy" : `vence el ${formatDate(due.fecha)}`;
  const base = `¡Hola! Te escribo de Mi Balneario por ${due.b.nombre}.\nTe recuerdo que ${cuando} el pago de *${due.concepto.replace(/ \(sin pagos registrados\)$/, "")}*: *${formatMoney(due.importe)}*.\n${pago ? `Podés transferir al ${pago}${quien}.\n` : ""}Cuando lo hagas, mandame el comprobante así lo registro. ¡Gracias!`;
  const [text, setText] = useState(base);
  const wa = whatsappLink(contact?.telefono ?? null, text);
  const plain = text.replace(/\*/g, "");
  return (
    <Modal open title={`Recordatorio · ${due.b.nombre}`} onClose={onClose}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cerrar</Button>
        {contact?.correo && <a href={mailtoLink(contact.correo, `Mi Balneario: ${due.concepto}`, plain, providerForEmail(email), email)} target="_blank" rel="noopener noreferrer"><Button variant="secondary">Mandar por correo</Button></a>}
        {wa && <a href={wa} target="_blank" rel="noopener noreferrer"><Button>Abrir WhatsApp</Button></a>}
      </>}>
      <p className="mb-2 text-xs text-muted">
        {contact?.telefono ? `WhatsApp: ${contact.telefono}` : "El balneario no tiene teléfono cargado (se carga en su Configuración)."}
        {contact?.correo ? ` · Correo: ${contact.correo}` : ""}
      </p>
      <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label="Mensaje" />
      {!pago && <p className="mt-2 text-xs text-warn">Cargá tu alias en «Tus datos de cobro» para que vaya en el mensaje.</p>}
    </Modal>
  );
}
