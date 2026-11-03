"use client";
import { useEffect, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError, isVersionConflict } from "@/lib/errors";
import { useWorkspace } from "@/components/workspace";
import { Alert, Button, Field, Modal, Textarea, TextField } from "@/components/ui";
import { PhoneInput } from "@/components/phone-input";
import { EMPTY_PHONE, formatPhone, parsePhone, phoneProblem, type PhoneParts } from "@/lib/phone";
import { EMAIL_RE, emailSuggestion } from "@/lib/email";

export type Customer = {
  id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  locality: string | null;
  other_contact: string | null;
  notes: string | null;
  version: number;
  created_at: string;
};

type Similar = { id: string; first_name: string; last_name: string; phone: string | null; motivo: string };

/**
 * Alta o edición de cliente. Se reutiliza desde Clientes y desde Nueva reserva.
 * Advierte posibles duplicados (mismo teléfono o mismo nombre) pero NO bloquea el alta.
 */
export function CustomerForm({
  open,
  customer,
  onClose,
  onSaved,
  initialName,
}: {
  open: boolean;
  customer: Customer | null;
  onClose: () => void;
  onSaved: (c: Customer) => void;
  /** Texto inicial para el nombre (alta rápida desde Nueva reserva). */
  initialName?: string;
}) {
  const { ws } = useWorkspace();
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [phoneParts, setPhoneParts] = useState<PhoneParts>(EMPTY_PHONE);
  const phone = formatPhone(phoneParts) ?? "";
  const [email, setEmail] = useState("");
  const [locality, setLocality] = useState("");
  const [other, setOther] = useState("");
  const [notes, setNotes] = useState("");
  const [similar, setSimilar] = useState<Similar[]>([]);
  const [confirmedDup, setConfirmedDup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const [f0, ...rest] = (initialName ?? "").trim().split(/\s+/);
    setFirst(customer?.first_name ?? f0 ?? "");
    setLast(customer?.last_name ?? rest.join(" "));
    setPhoneParts(parsePhone(customer?.phone));
    setEmail(customer?.email ?? "");
    setLocality(customer?.locality ?? "");
    setOther(customer?.other_contact ?? "");
    setNotes(customer?.notes ?? "");
    setSimilar([]);
    setConfirmedDup(false);
    setError(null);
  }, [open, customer, initialName]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const sb = getSupabase();
    const pp = phoneProblem(phoneParts);
    if (pp) return setError(`Teléfono: ${pp}`);
    const mail = email.trim().toLowerCase();
    if (mail) {
      if (!EMAIL_RE.test(mail)) return setError("El correo no tiene un formato válido (ej: nombre@gmail.com).");
      const sug = emailSuggestion(mail);
      if (sug) return setError(`¿Quisiste escribir ${sug}? Corregilo o borrá el correo.`);
    }
    setBusy(true);
    try {
      if (mail && mail !== (customer?.email ?? "").toLowerCase()) {
        // ¿El dominio existe y recibe correos?
        const r = await fetch(`/api/verificar-email?email=${encodeURIComponent(mail)}`).then((x) => x.json()).catch(() => ({ ok: null }));
        if (r.ok === false) {
          setError(r.reason === "formato" ? "El correo no tiene un formato válido."
            : `El correo no existe: el dominio "${r.domain}" no recibe correos. Revisá cómo está escrito.`);
          return;
        }
        // ¿Ya lo tiene otro cliente?
        if (!confirmedDup) {
          let dq = sb.from("customers").select("id, first_name, last_name, phone").eq("workspace_id", ws.id).ilike("email", mail.replace(/[\\%_]/g, "\\$&")).limit(3);
          if (customer) dq = dq.neq("id", customer.id);
          const { data: same } = await dq;
          if (same && same.length > 0) {
            setSimilar((same as Omit<Similar, "motivo">[]).map((c) => ({ ...c, motivo: "Mismo correo" })));
            setConfirmedDup(true);
            return;
          }
        }
      }
      if (!customer && !confirmedDup) {
        const { data, error } = await sb.rpc("find_similar_customers", {
          p_workspace_id: ws.id, p_first_name: first, p_last_name: last, p_phone: phone || null,
        });
        if (error) throw error;
        if (data && (data as Similar[]).length > 0) {
          setSimilar(data as Similar[]);
          setConfirmedDup(true); // el próximo clic guarda igual
          return;
        }
      }
      const payload = {
        first_name: first.trim(),
        last_name: last.trim(),
        phone: phone.trim() || null,
        email: mail || null,
        locality: locality.trim() || null,
        other_contact: other.trim() || null,
        notes: notes.trim() || null,
      };
      if (customer) {
        const { data, error } = await sb.from("customers").update({ ...payload, version: customer.version + 1 }).eq("id", customer.id).select().single();
        if (error) throw error;
        onSaved(data as Customer);
      } else {
        const { data, error } = await sb.from("customers").insert({ ...payload, workspace_id: ws.id }).select().single();
        if (error) throw error;
        onSaved(data as Customer);
      }
    } catch (err) {
      setError(friendlyError(err));
      if (isVersionConflict(err)) onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={customer ? "Editar cliente" : "Nuevo cliente"} busy={busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Nombre" required maxLength={80} value={first} onChange={(e) => { setFirst(e.target.value); setConfirmedDup(false); setSimilar([]); }} />
          <TextField label="Apellido" maxLength={80} value={last} onChange={(e) => { setLast(e.target.value); setConfirmedDup(false); setSimilar([]); }} />
        </div>
        <PhoneInput value={phoneParts} onChange={(p) => { setPhoneParts(p); setConfirmedDup(false); setSimilar([]); }} />
        {/* La localidad ya no se pide (se conserva la de clientes anteriores). */}
        <TextField label="Correo (opcional)" type="email" maxLength={150} value={email} onChange={(e) => { setEmail(e.target.value); setConfirmedDup(false); setSimilar([]); }}
          hint="Se puede dejar vacío. Si lo cargás, se revisa que esté bien escrito." />
        <TextField label="Otro contacto (opcional)" maxLength={200} value={other} onChange={(e) => setOther(e.target.value)} placeholder="Ej: Instagram, teléfono de un familiar" />
        <Field label="Observaciones"><Textarea maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>

        {similar.length > 0 && (
          <Alert tone="warn">
            <p className="mb-1 font-medium">Puede que este cliente ya exista:</p>
            <ul className="mb-1 list-disc pl-5">
              {similar.map((s) => (
                <li key={s.id}>{s.first_name} {s.last_name}{s.phone ? ` · ${s.phone}` : ""} <span className="text-muted">({s.motivo})</span></li>
              ))}
            </ul>
            <p>Si es otra persona, tocá <strong>Guardar igual</strong>.</p>
          </Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button type="submit" loading={busy}>{similar.length > 0 ? "Guardar igual" : "Guardar"}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Busca clientes por nombre, apellido o teléfono. */
export async function searchCustomers(workspaceId: string, q: string, limit = 50): Promise<Customer[]> {
  const sb = getSupabase();
  let query = sb.from("customers").select("*").eq("workspace_id", workspaceId).order("last_name").order("first_name").limit(limit);
  const term = q.trim();
  if (term) {
    const digits = term.replace(/\D/g, "");
    const safe = term.replace(/[%,()*]/g, " ").trim();
    const parts = [`first_name.ilike.%${safe}%`, `last_name.ilike.%${safe}%`, `locality.ilike.%${safe}%`];
    if (digits.length >= 3) parts.push(`phone_digits.ilike.%${digits}%`);
    // "Ana Pérez" → también buscar nombre y apellido combinados
    const words = safe.split(/\s+/).filter(Boolean);
    if (words.length >= 2) parts.push(`and(first_name.ilike.%${words[0]}%,last_name.ilike.%${words.slice(1).join(" ")}%)`);
    query = query.or(parts.join(","));
  }
  const { data, error } = await query;
  if (error) throw error;
  return data as Customer[];
}
