"use client";
import { useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Textarea, TextField } from "@/components/ui";

export type Pkg = { id: string; min_days: number; percent: number; active: boolean; version: number };
export type Agreement = { id: string; name: string; percent: number; active: boolean; valid_from: string | null; valid_to: string | null; conditions: string | null; version: number };

export function PackagesCard({ pkgs, cashPercent, wsVersion, editable, onChanged }: { pkgs: Pkg[]; cashPercent: number; wsVersion: number; editable: boolean; onChanged: () => void }) {
  const { ws } = useWorkspace();
  const [days, setDays] = useState("");
  const [pct, setPct] = useState("");
  const [cash, setCash] = useState(String(cashPercent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sb = getSupabase();
  const active = pkgs.filter((p) => p.active);

  async function run(fn: () => PromiseLike<{ error: unknown }>) {
    setBusy(true);
    setError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) return setError(friendlyError(error));
    onChanged();
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const d = Number(days);
    const p = Number(pct.replace(",", "."));
    if (!Number.isInteger(d) || d < 2) return setError("Los días deben ser un número entero mayor a 1.");
    if (!(p > 0 && p <= 100)) return setError("El porcentaje debe estar entre 0 y 100.");
    await run(() => sb.from("package_discounts").insert({ workspace_id: ws.id, min_days: d, percent: p }).select("id"));
    setDays("");
    setPct("");
  }

  return (
    <Card title="Descuentos por paquete de días">
      {active.length === 0 ? <EmptyState>Sin descuentos por paquete.</EmptyState> : (
        <ul className="mb-3 divide-y divide-line text-sm">
          {active.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 py-1.5">
              <span>Desde <strong>{p.min_days} días</strong>: {Number(p.percent)}%</span>
              {editable && (
                <div className="flex gap-2">
                  <button className="text-xs text-accent hover:underline" disabled={busy} onClick={() => {
                    const v = window.prompt(`Nuevo porcentaje para ${p.min_days} días`, String(Number(p.percent)));
                    if (v === null) return;
                    const n = Number(v.replace(",", "."));
                    if (!(n > 0 && n <= 100)) return setError("El porcentaje debe estar entre 0 y 100.");
                    run(() => sb.from("package_discounts").update({ percent: n, version: p.version + 1 }).eq("id", p.id).select("id"));
                  }}>Cambiar %</button>
                  <button className="text-xs text-danger hover:underline" disabled={busy} onClick={() =>
                    run(() => sb.from("package_discounts").update({ active: false, version: p.version + 1 }).eq("id", p.id).select("id"))
                  }>Quitar</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mb-3 text-xs text-muted">Se aplica el escalón más alto que alcance la estadía. Ej.: 10 días toma el de 7.</p>
      {editable && (
        <form onSubmit={add} className="mb-4 flex flex-wrap items-end gap-2">
          <Field label="Desde (días)"><Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} className="w-24" /></Field>
          <Field label="%"><Input inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} className="w-20" /></Field>
          <Button type="submit" variant="secondary" loading={busy}>Agregar</Button>
        </form>
      )}
      <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
        <Field label="Descuento por pago en efectivo (%)">
          <Input inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} disabled={!editable} className="w-24" />
        </Field>
        {editable && Number(cash.replace(",", ".")) !== Number(cashPercent) && (
          <Button variant="secondary" loading={busy} onClick={() => {
            const n = Number(cash.replace(",", "."));
            if (!(n >= 0 && n <= 100)) return setError("El porcentaje debe estar entre 0 y 100.");
            run(() => sb.from("workspaces").update({ cash_discount_percent: n, version: wsVersion + 1 }).eq("id", ws.id).select("id"));
          }}>Guardar</Button>
        )}
      </div>
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
    </Card>
  );
}

export function AgreementsCard({ agreements, editable, onChanged }: { agreements: Agreement[]; editable: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<Agreement | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <Card title="Convenios" actions={editable ? <Button variant="secondary" onClick={() => setCreating(true)}>Nuevo convenio</Button> : undefined}>
      {agreements.length === 0 ? <EmptyState>Sin convenios.</EmptyState> : (
        <ul className="divide-y divide-line text-sm">
          {agreements.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 py-2">
              <div>
                <div className="font-medium">{a.name} · {Number(a.percent)}% {!a.active && <Badge tone="muted">Desactivado</Badge>}</div>
                <div className="text-xs text-muted">
                  {a.valid_from || a.valid_to ? `Vigente ${a.valid_from ? `desde ${formatDate(a.valid_from)}` : ""} ${a.valid_to ? `hasta ${formatDate(a.valid_to)}` : ""}` : "Sin fecha de vencimiento"}
                  {a.conditions ? ` · ${a.conditions}` : ""}
                </div>
              </div>
              {editable && <button className="text-xs text-accent hover:underline" onClick={() => setEditing(a)}>Editar</button>}
            </li>
          ))}
        </ul>
      )}
      <AgreementModal open={creating || editing !== null} agreement={editing} onClose={() => { setCreating(false); setEditing(null); }} onDone={() => { setCreating(false); setEditing(null); onChanged(); }} />
    </Card>
  );
}

export function AgreementModal({ open, agreement, onClose, onDone }: { open: boolean; agreement: Agreement | null; onClose: () => void; onDone: () => void }) {
  const { ws } = useWorkspace();
  const [name, setName] = useState("");
  const [pct, setPct] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [conditions, setConditions] = useState("");
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null | undefined>(undefined);

  if (open && lastId !== (agreement?.id ?? null)) {
    setLastId(agreement?.id ?? null);
    setName(agreement?.name ?? "");
    setPct(agreement ? String(Number(agreement.percent)) : "");
    setFrom(agreement?.valid_from ?? "");
    setTo(agreement?.valid_to ?? "");
    setConditions(agreement?.conditions ?? "");
    setActive(agreement?.active ?? true);
    setError(null);
  }
  if (!open && lastId !== undefined) setLastId(undefined);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const sb = getSupabase();
    setBusy(true);
    setError(null);
    const base = { name: name.trim(), valid_from: from || null, valid_to: to || null, conditions: conditions.trim() || null, active };
    let res;
    if (agreement) {
      res = await sb.from("agreements").update({ ...base, version: agreement.version + 1 }).eq("id", agreement.id).select("id");
    } else {
      const p = Number(pct.replace(",", "."));
      if (!(p > 0 && p <= 100)) {
        setBusy(false);
        return setError("El porcentaje debe estar entre 0 y 100.");
      }
      res = await sb.from("agreements").insert({ ...base, workspace_id: ws.id, percent: p }).select("id");
    }
    setBusy(false);
    if (res.error) return setError(friendlyError(res.error));
    onDone();
  }

  return (
    <Modal open={open} onClose={onClose} title={agreement ? `Editar convenio ${agreement.name}` : "Nuevo convenio"} busy={busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <TextField label="Nombre" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Ej: Hotel Parque Bonito" />
        {agreement ? (
          <p className="text-sm text-muted">Descuento: <strong className="text-fg">{Number(agreement.percent)}%</strong>. Para cambiar el porcentaje, desactivá este convenio y creá uno nuevo: así las reservas anteriores conservan el suyo.</p>
        ) : (
          <TextField label="Descuento (%)" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} required />
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vigente desde (opcional)"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Hasta (opcional)"><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <Field label="Condiciones (opcional)"><Textarea value={conditions} onChange={(e) => setConditions(e.target.value)} maxLength={500} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Activo (se ofrece en nuevas reservas)</label>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button type="submit" loading={busy}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}

