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
import { WindguruSettingsCard } from "@/components/windguru-settings";

type WsRow = { name: string; subtitle: string | null; logo_data: string | null; legal_id: string | null; phone: string | null; address: string | null; latitude: number | null; longitude: number | null; version: number };
type Member = { user_id: string; role: string; email: string | null; created_at: string };

export default function ConfiguracionPage() {
  const { ws, isAdmin, reloadWorkspace } = useWorkspace();
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
            <WindguruSettingsCard />
          </div>
          <div className="flex flex-col gap-4">
            <ProfileCard />
            <LinkedAccountsCard />
            <UsersCard />
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
  const [lat, setLat] = useState(row.latitude?.toString() ?? "");
  const [lon, setLon] = useState(row.longitude?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const la = lat.trim() === "" ? null : Number(lat.replace(",", "."));
    const lo = lon.trim() === "" ? null : Number(lon.replace(",", "."));
    if (la !== null && !(la >= -90 && la <= 90)) return setMsg({ tone: "danger", text: "Latitud inválida (entre -90 y 90)." });
    if (lo !== null && !(lo >= -180 && lo <= 180)) return setMsg({ tone: "danger", text: "Longitud inválida (entre -180 y 180)." });
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
    <Card title="Balneario">
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
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Latitud" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="-37.2639" disabled={!editable} />
          <TextField label="Longitud" inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} placeholder="-56.9731" disabled={!editable} />
        </div>
        <p className="text-xs text-muted">La ubicación se usa para el clima, el viento y el recorrido del sol. Aparecen en el comprobante el nombre, el CUIT, el teléfono y la dirección.</p>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {editable ? <Button type="submit" loading={busy}>Guardar cambios</Button> : <p className="text-sm text-muted">Solo el propietario o un administrador pueden modificar estos datos.</p>}
      </form>
    </Card>
  );
}

function ProfileCard() {
  const { email, profile, saveProfile, theme, setTheme, tempUnit, setTempUnit } = useWorkspace();
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
        <MyUsernameField />
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
