"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError, isVersionConflict } from "@/lib/errors";
import { resizeImage } from "@/lib/image";
import { useWorkspace, type ThemePref } from "@/components/workspace";
import { useStatus } from "@/components/status";
import { BrandLogo, PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, Field, Select, Spinner, TextField } from "@/components/ui";
import { LinkedAccountsCard } from "@/components/linked-accounts";
import { MyUsernameField, UsersCard } from "@/components/users";
import { LocationPicker } from "@/components/location-picker";
import { ExtrasCard } from "@/components/extras";
import { PlanCard } from "@/components/plan-card";
import { RulesCard } from "@/components/rules-card";
import { DEBT_CASES, DEFAULT_MAIL, DEFAULT_TEMPLATES, PLACEHOLDERS, debtVars, fillTemplate, type DebtCase, type MailKey, type Templates } from "@/lib/whatsapp-messages";

type WsRow = { name: string; subtitle: string | null; logo_data: string | null; legal_id: string | null; phone: string | null; address: string | null; latitude: number | null; longitude: number | null; version: number };
type Member = { user_id: string; role: string; email: string | null; created_at: string };

export default function ConfiguracionPage() {
  const { ws, isAdmin, reloadWorkspace, isGuest } = useWorkspace();
  const sb = getSupabase();
  const q = useLoader(async () => {
    const row = unwrap(await sb.from("workspaces").select("name, subtitle, logo_data, legal_id, phone, address, latitude, longitude, version").eq("id", ws.id).single()) as WsRow;
    const members = unwrap(await sb.from("workspace_members").select("user_id, role, email, created_at").eq("workspace_id", ws.id).order("created_at")) as Member[];
    return { row, members };
  }, [ws.id], 0);

  return (
    <>
      <PageHeader title="Configuración" subtitle="Datos del balneario, tu perfil y preferencias." />
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {!q.data ? (q.loading && <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando…</div>) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
          <BalnearioCard key={q.data.row.version} row={q.data.row} editable={isAdmin} onSaved={async () => { await reloadWorkspace(); q.reload(); }} onConflict={q.reload} />
          <MessagesCard key={`m${q.data.row.version}`} editable={isAdmin} onSaved={q.reload} />
          <ExtrasCard />
          <div data-tour="config-reglas"><RulesCard /></div>
          </div>
          <div className="flex flex-col gap-4">
            {!isGuest && <PlanCard />}
            <ProfileCard />
            {!isGuest && <LinkedAccountsCard />}
            {!isGuest && <div data-tour="config-usuarios"><UsersCard /></div>}
          </div>
        </div>
      )}
    </>
  );
}

function ImagePicker({ label, value, onChange, disabled, round, maxSide, maxBytes }: {
  label: string; value: string | null; onChange: (v: string | null) => void; disabled?: boolean; round?: boolean; maxSide: number; maxBytes: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Field label={label}>
      <div className="flex items-center gap-3">
        {value
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={value} alt="" className={`h-16 w-16 border border-line object-cover ${round ? "rounded-full" : "rounded-xl"}`} />
          : <div className={`flex h-16 w-16 items-center justify-center border border-dashed border-line text-xs text-muted ${round ? "rounded-full" : "rounded-xl"}`}>Sin foto</div>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" disabled={disabled} loading={busy} onClick={() => input.current?.click()}>{value ? "Cambiar" : "Elegir imagen"}</Button>
          {value && <Button type="button" variant="ghost" disabled={disabled} onClick={() => onChange(null)}>Quitar</Button>}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            setBusy(true);
            setError(null);
            try {
              onChange(await resizeImage(f, maxSide, maxBytes));
            } catch (err) {
              setError(err instanceof Error ? err.message : "No se pudo usar la imagen.");
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </Field>
  );
}

function BalnearioCard({ row, editable, onSaved, onConflict }: { row: WsRow; editable: boolean; onSaved: () => Promise<void>; onConflict: () => void }) {
  const { ws } = useWorkspace();
  const [name, setName] = useState(row.name);
  const [subtitle, setSubtitle] = useState(row.subtitle ?? "");
  const [logo, setLogo] = useState<string | null>(row.logo_data);
  const [legalId, setLegalId] = useState(row.legal_id ?? "");
  const [phone, setPhone] = useState(row.phone ?? "");
  const [address, setAddress] = useState(row.address ?? "");
  const [lat, setLat] = useState<number | null>(row.latitude == null ? null : Number(row.latitude));
  const [lon, setLon] = useState<number | null>(row.longitude == null ? null : Number(row.longitude));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const la = lat;
    const lo = lon;
    if (!name.trim()) return setMsg({ tone: "danger", text: "El nombre no puede quedar vacío." });
    setBusy(true);
    setMsg(null);
    const { error } = await getSupabase().from("workspaces").update({
      name: name.trim(), subtitle: subtitle.trim() || null, logo_data: logo, legal_id: legalId.trim() || null,
      phone: phone.trim() || null, address: address.trim() || null, latitude: la, longitude: lo, version: row.version + 1,
    }).eq("id", ws.id).select("id").single();
    setBusy(false);
    if (error) {
      setMsg({ tone: "danger", text: friendlyError(error) });
      if (isVersionConflict(error)) onConflict();
      return;
    }
    setMsg({ tone: "ok", text: "Datos del balneario guardados. Ya se ven en todas las computadoras y celulares." });
    await onSaved();
  }

  return (
    <Card title="Balneario" tour="config-balneario">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex items-center gap-3 rounded-xl bg-surface-2 p-3">
          <BrandLogo ws={{ ...ws, logo_data: logo, name }} className="h-12 w-12" />
          <div className="min-w-0">
            <div className="truncate font-bold uppercase">{name || "—"}</div>
            <div className="truncate text-xs text-accent">{subtitle || "Gestión del balneario"}</div>
          </div>
          <span className="ml-auto text-xs text-muted">Vista previa del menú</span>
        </div>
        <TextField label="Nombre del balneario" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required disabled={!editable} />
        <TextField label="Subtítulo (opcional)" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} maxLength={80} placeholder="Ej: Gestión Costa Atlántica" disabled={!editable} />
        <ImagePicker label="Logo o foto del balneario" value={logo} onChange={setLogo} disabled={!editable} maxSide={512} maxBytes={300_000} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="CUIT (opcional)" value={legalId} onChange={(e) => setLegalId(e.target.value)} maxLength={30} disabled={!editable} />
          <TextField label="Teléfono (opcional)" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} disabled={!editable} />
        </div>
        <TextField label="Dirección (opcional)" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} disabled={!editable} />
        <LocationPicker lat={lat} lon={lon} onChange={(a, b) => { setLat(a); setLon(b); }} disabled={!editable} />
        <p className="text-xs text-muted">La ubicación se usa para el clima, el viento y el sol de tu balneario; se guarda al tocar «Guardar cambios». En el comprobante aparecen el nombre, el CUIT, el teléfono y la dirección.</p>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {editable ? <Button type="submit" loading={busy}>Guardar cambios</Button> : <p className="text-sm text-muted">Solo el propietario o un administrador pueden modificar estos datos.</p>}
      </form>
    </Card>
  );
}

function ProfileCard() {
  const { email, profile, saveProfile, theme, setTheme, tempUnit, setTempUnit, isGuest } = useWorkspace();
  const status = useStatus();
  const [name, setName] = useState(profile.displayName ?? "");
  const [avatar, setAvatar] = useState<string | null>(profile.avatar);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  useEffect(() => {
    setName(profile.displayName ?? "");
    setAvatar(profile.avatar);
  }, [profile.displayName, profile.avatar]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await saveProfile({ display_name: name.trim() || null, avatar_data: avatar });
      setMsg({ tone: "ok", text: "Perfil guardado." });
    } catch (err) {
      setMsg({ tone: "danger", text: friendlyError(err) });
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    if (pw.length < 8) return setPwMsg({ tone: "danger", text: "La contraseña debe tener al menos 8 caracteres." });
    if (pw !== pw2) return setPwMsg({ tone: "danger", text: "Las contraseñas no coinciden." });
    setPwBusy(true);
    const { error } = await getSupabase().auth.updateUser({ password: pw });
    setPwBusy(false);
    if (error) return setPwMsg({ tone: "danger", text: friendlyError(error) });
    setPw("");
    setPw2("");
    setPwMsg({ tone: "ok", text: "Contraseña cambiada." });
  }

  return (
    <Card title="Mi perfil">
      <form onSubmit={save} className="flex flex-col gap-3">
        {!isGuest && <MyUsernameField />}
        <TextField label="Nombre para mostrar" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={email ?? ""} />
        <ImagePicker label="Foto de perfil" value={avatar} onChange={setAvatar} round maxSide={256} maxBytes={150_000} />
        <p className="text-xs text-muted">Cuenta: {email}</p>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Button type="submit" loading={busy}>Guardar perfil</Button>
      </form>
      <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
        <Field label="Tema">
          <Select value={theme} onChange={(e) => setTheme(e.target.value as ThemePref).catch(() => undefined)}>
            <option value="claro">Claro</option>
            <option value="oscuro">Oscuro</option>
            <option value="sistema">Automático (según el dispositivo)</option>
          </Select>
        </Field>
        <Field label="Temperatura">
          <Select value={tempUnit} onChange={(e) => setTempUnit(e.target.value as "C" | "F").catch(() => undefined)}>
            <option value="C">Celsius (°C)</option>
            <option value="F">Fahrenheit (°F)</option>
          </Select>
        </Field>
      </div>
      <form onSubmit={changePassword} className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
        <h3 className="text-sm font-semibold">Cambiar contraseña</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Nueva contraseña" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <TextField label="Repetila" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </div>
        {pwMsg && <Alert tone={pwMsg.tone}>{pwMsg.text}</Alert>}
        <Button type="submit" variant="secondary" loading={pwBusy} disabled={!pw}>Cambiar contraseña</Button>
      </form>
      <p className="mt-3 text-xs text-muted">Última sincronización: {status.updatedAt ? status.updatedAt.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }) : "—"}</p>
    </Card>
  );
}

/** Mensajes de WhatsApp propios (recordatorio de deuda). Vacío = el mensaje de siempre. */
function MessagesCard({ editable, onSaved }: { editable: boolean; onSaved: () => void }) {
  const { ws, email } = useWorkspace();
  const sb = getSupabase();
  const q = useLoader(async () => {
    const res = await sb.from("workspaces").select("message_templates, version").eq("id", ws.id).single();
    if (res.error) return { missing: true, templates: {} as Templates, version: 0 };
    const row = res.data as { message_templates: Templates | null; version: number };
    return { missing: false, templates: row.message_templates ?? {}, version: row.version };
  }, [ws.id], 0);
  type Key = DebtCase | MailKey;
  type Tab = DebtCase | "mail";
  const DEFAULTS: Record<Key, string> = { ...DEFAULT_TEMPLATES, ...DEFAULT_MAIL };
  const KEYS = [...DEBT_CASES.map((c) => c.key), "mail_asunto", "mail_cuerpo"] as Key[];
  const [draft, setDraft] = useState<Record<Key, string> | null>(null);
  const [tab, setTab] = useState<Tab>("deuda_hoy");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const lastField = useRef<"subject" | "body">("body");

  useEffect(() => {
    if (!q.data) return;
    const t = q.data.templates;
    setDraft(Object.fromEntries(KEYS.map((k) => [k, t[k]?.trim() ? t[k]! : DEFAULTS[k]])) as Record<Key, string>);
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (window.location.hash === "#mensajes") document.getElementById("mensajes")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [draft === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!q.data || !draft) return <Card title="Mensajes a clientes"><div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando…</div></Card>;
  if (q.data.missing) return <Card title="Mensajes a clientes"><p className="text-sm text-muted">Para cambiar los mensajes hay que aplicar la actualización 0027 de la base de datos.</p></Card>;

  const sample = debtVars({ firstName: "Juan", lastName: "Pérez", phone: "2255 123456", email: "juan@ejemplo.com", balneario: ws.name, number: 125,
    places: "Carpa 17", start: "2027-01-05", end: "2027-01-20", total: 300000, paid: 100000, due: 200000, today: "2027-01-20" });
  const isMail = tab === "mail";
  const bodyKey: Key = isMail ? "mail_cuerpo" : tab;

  function insert(key: string) {
    const tag = `{${key}}`;
    const target: Key = isMail && lastField.current === "subject" ? "mail_asunto" : bodyKey;
    const el = target === "mail_asunto" ? subjectRef.current : area.current;
    const cur = draft![target];
    const at = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    setDraft({ ...draft!, [target]: cur.slice(0, at) + tag + cur.slice(end) });
    setTimeout(() => { el?.focus(); el?.setSelectionRange(at + tag.length, at + tag.length); }, 0);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    // Solo se guarda lo que es distinto del mensaje de siempre.
    const out: Templates = {};
    for (const k of KEYS) {
      const v = draft![k].trim();
      const max = k === "mail_asunto" ? 200 : k === "mail_cuerpo" ? 3000 : 1000;
      if (v && v !== DEFAULTS[k]) out[k] = v.slice(0, max);
    }
    const { error } = await sb.from("workspaces").update({ message_templates: Object.keys(out).length ? out : null, version: q.data!.version + 1 }).eq("id", ws.id).select("id").single();
    setBusy(false);
    if (error) {
      const needs34 = error.code === "23514" && ("mail_asunto" in out || "mail_cuerpo" in out);
      setMsg({ tone: "danger", text: needs34 ? "Para guardar el mensaje de correo hay que aplicar la actualización 0034 de la base de datos." : friendlyError(error) });
      if (isVersionConflict(error)) q.reload();
      return;
    }
    setMsg({ tone: "ok", text: "Mensajes guardados. Se usan en todas las computadoras y celulares." });
    window.dispatchEvent(new Event("plantillas-cambiaron"));
    onSaved(); // la versión del balneario cambió: se recargan las dos tarjetas
  }

  const info = isMail ? { label: "Correo", help: "El correo que se arma al tocar «Enviar correo» en una reserva (si el cliente tiene mail cargado)." } : DEBT_CASES.find((c) => c.key === tab)!;
  const changed = (k: Key) => draft[k] !== DEFAULTS[k];
  return (
    <section id="mensajes" className="scroll-mt-20">
      <Card title="Mensajes a clientes (WhatsApp y correo)" tour="config-mensajes">
        <div className="mb-2 flex flex-wrap gap-1">
          {DEBT_CASES.map((c) => (
            <button key={c.key} type="button" onClick={() => setTab(c.key)}
              className={`rounded-lg border px-2.5 py-1 text-sm ${tab === c.key ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line hover:bg-surface-2"}`}>
              {c.label}{changed(c.key) ? " *" : ""}
            </button>
          ))}
          <button type="button" onClick={() => setTab("mail")}
            className={`rounded-lg border px-2.5 py-1 text-sm ${isMail ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line hover:bg-surface-2"}`}>
            Correo{changed("mail_asunto") || changed("mail_cuerpo") ? " *" : ""}
          </button>
        </div>
        <p className="mb-2 text-xs text-muted">{isMail ? info.help : `WhatsApp · recordatorio de deuda. ${info.help}`}</p>
        {isMail && (
          <p className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-sm">
            Los correos salen desde la cuenta con la que entrás al sistema{email ? <>: <b>{email}</b></> : ""}. Al tocar «Enviar correo» se abre la ventana para escribir, con el mail del cliente, el asunto y el texto ya puestos.
          </p>
        )}
        {isMail && (
          <label className="mb-2 flex flex-col gap-1 text-sm font-medium">Asunto
            <input ref={subjectRef} value={draft.mail_asunto} onFocus={() => { lastField.current = "subject"; }} maxLength={200} disabled={!editable}
              onChange={(e) => setDraft({ ...draft, mail_asunto: e.target.value })}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm font-normal text-fg" />
          </label>
        )}
        <textarea ref={area} value={draft[bodyKey]} onFocus={() => { lastField.current = "body"; }} onChange={(e) => setDraft({ ...draft, [bodyKey]: e.target.value })}
          rows={isMail ? 9 : 6} maxLength={isMail ? 3000 : 1000} disabled={!editable}
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg" aria-label={`Mensaje: ${info.label}`} />
        {editable && (
          <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
            <span className="text-muted">Agregar dato:</span>
            {PLACEHOLDERS.map((p) => (
              <button key={p.key} type="button" onClick={() => insert(p.key)} className="rounded-md border border-line px-2 py-0.5 hover:bg-surface-2">{p.label}</button>
            ))}
          </div>
        )}
        <div className="mt-3 rounded-lg bg-surface-2 p-3 text-sm">
          <div className="mb-1 text-xs font-semibold text-muted">Así sale el mensaje</div>
          {isMail && <p className="mb-2 font-semibold">{fillTemplate(draft.mail_asunto, sample)}</p>}
          <p className="whitespace-pre-wrap">{fillTemplate(draft[bodyKey], sample)}</p>
        </div>
        {msg && <Alert tone={msg.tone} className="mt-2">{msg.text}</Alert>}
        {editable ? (
          <div className="mt-3 flex flex-wrap justify-between gap-2">
            <Button type="button" variant="ghost" disabled={isMail ? !changed("mail_asunto") && !changed("mail_cuerpo") : !changed(tab as DebtCase)}
              onClick={() => setDraft(isMail ? { ...draft, mail_asunto: DEFAULT_MAIL.mail_asunto, mail_cuerpo: DEFAULT_MAIL.mail_cuerpo } : { ...draft, [tab]: DEFAULTS[tab as DebtCase] })}>
              Volver al mensaje original
            </Button>
            <Button type="button" loading={busy} onClick={save}>Guardar mensajes</Button>
          </div>
        ) : <p className="mt-2 text-xs text-muted">Solo un administrador puede cambiar los mensajes.</p>}
        <p className="mt-2 text-xs text-muted">Los datos entre llaves, como {"{nombre}"}, {"{total}"} o {"{saldo}"}, se completan solos con los de cada cliente y reserva. Antes de mandar cada mensaje también lo podés retocar.</p>
      </Card>
    </section>
  );
}
