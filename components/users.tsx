"use client";
import { useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { USERNAME_RE, normalizeUsername } from "@/lib/remember";
import { useWorkspace } from "@/components/workspace";
import { Alert, Badge, Button, Card, ConfirmDialog, Field, Modal, Select, Spinner, TextField } from "@/components/ui";

type WsUser = { user_id: string; role: string; email: string | null; username: string | null; created_at: string; is_me: boolean };

async function api(method: "POST" | "PATCH", body: unknown) {
  try {
    const res = await fetch("/api/usuarios", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? null : data.error ?? "No se pudo completar la operación.";
  } catch {
    return "No hay conexión con el servidor.";
  }
}

/** Campos de contraseña con "Repetí la contraseña". */
function PasswordPair({ pw, setPw, pw2, setPw2 }: { pw: string; setPw: (v: string) => void; pw2: string; setPw2: (v: string) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField label="Contraseña" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} hint="Mínimo 8 caracteres." />
      <TextField label="Repetí la contraseña" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} error={pw2 && pw !== pw2 ? "No coincide." : null} />
    </div>
  );
}

export function UsersCard() {
  const { ws, role, isAdmin } = useWorkspace();
  const q = useLoader(async () => unwrap(await getSupabase().rpc("workspace_users", { p_workspace_id: ws.id })) as WsUser[], [ws.id], 0);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<WsUser | null>(null);
  const [removing, setRemoving] = useState<WsUser | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const isOwner = role === "propietario";

  async function changeRole(u: WsUser, r: string) {
    setMsg(null);
    const { error } = await getSupabase().rpc("set_member_role", { p_workspace_id: ws.id, p_user_id: u.user_id, p_role: r });
    if (error) return setMsg({ tone: "danger", text: friendlyError(error) });
    setMsg({ tone: "ok", text: `${u.username ?? u.email} ahora es ${r}.` });
    q.reload();
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    const { error } = await getSupabase().rpc("remove_member", { p_workspace_id: ws.id, p_user_id: removing.user_id });
    setBusy(false);
    if (error) return setMsg({ tone: "danger", text: friendlyError(error) });
    setMsg({ tone: "ok", text: `Se quitó el acceso a ${removing.username ?? removing.email}.` });
    setRemoving(null);
    q.reload();
  }

  const canReset = (u: WsUser) => !u.is_me && u.role !== "propietario" && (isOwner || u.role === "operador");

  return (
    <Card title="Usuarios" actions={isAdmin ? <Button variant="secondary" onClick={() => { setMsg(null); setCreating(true); }}>Crear usuario</Button> : undefined}>
      {q.error && <Alert tone="danger" className="mb-2">{q.error}</Alert>}
      {!q.data ? <div className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Cargando…</div> : (
        <ul className="divide-y divide-line text-sm">
          {q.data.map((u) => (
            <li key={u.user_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="font-medium">{u.username ?? <span className="text-muted">(sin usuario)</span>} {u.is_me && <Badge tone="info">Vos</Badge>}</div>
                {u.email && <div className="truncate text-xs text-muted">{u.email}</div>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {isOwner && !u.is_me && u.role !== "propietario" ? (
                  <Select value={u.role} onChange={(e) => changeRole(u, e.target.value)} className="w-auto py-1" aria-label="Rol">
                    <option value="administrador">administrador</option>
                    <option value="operador">operador</option>
                  </Select>
                ) : <Badge tone={u.role === "propietario" ? "info" : "muted"}>{u.role}</Badge>}
                {isAdmin && canReset(u) && <button className="text-xs text-accent hover:underline" onClick={() => { setMsg(null); setResetting(u); }}>Contraseña</button>}
                {isAdmin && !u.is_me && u.role !== "propietario" && <button className="text-xs text-danger hover:underline" onClick={() => setRemoving(u)}>Quitar</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">
        Solo estas cuentas pueden ver y modificar los datos. <strong>Propietario</strong>: todo. <strong>Administrador</strong>: todo menos gestionar administradores. <strong>Operador</strong>: reservas, cobros, caja y clientes (sin tarifas, anulaciones ni descuentos manuales).
      </p>
      {msg && <Alert tone={msg.tone} className="mt-3">{msg.text}</Alert>}

      <CreateUserModal open={creating} isOwner={isOwner} onClose={() => setCreating(false)} onDone={(u) => { setCreating(false); setMsg({ tone: "ok", text: `Usuario «${u}» creado. Ya puede ingresar con su usuario y contraseña.` }); q.reload(); }} />
      <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} onDone={() => { setMsg({ tone: "ok", text: `Contraseña de ${resetting?.username ?? resetting?.email} cambiada.` }); setResetting(null); }} />
      <ConfirmDialog
        open={removing !== null}
        title="Quitar acceso"
        message={<>«{removing?.username ?? removing?.email}» ya no va a poder ver ni modificar los datos del balneario. Lo que haya cargado queda en el historial.</>}
        confirmLabel="Quitar acceso"
        danger
        busy={busy}
        onConfirm={remove}
        onCancel={() => setRemoving(null)}
      />
    </Card>
  );
}

function CreateUserModal({ open, isOwner, onClose, onDone }: { open: boolean; isOwner: boolean; onClose: () => void; onDone: (u: string) => void }) {
  const [usuario, setUsuario] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [rol, setRol] = useState("operador");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const u = normalizeUsername(usuario);
    if (!USERNAME_RE.test(u)) return setError("El usuario debe tener entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo (sin espacios).");
    if (pw.length < 8) return setError("La contraseña debe tener al menos 8 caracteres.");
    if (pw !== pw2) return setError("Las contraseñas no coinciden.");
    setBusy(true);
    setError(null);
    const err = await api("POST", { usuario: u, password: pw, password2: pw2, rol });
    setBusy(false);
    if (err) return setError(err);
    setUsuario(""); setPw(""); setPw2(""); setRol("operador");
    onDone(u);
  }

  return (
    <Modal open={open} onClose={onClose} title="Crear usuario" busy={busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <TextField label="Usuario" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={usuario} onChange={(e) => setUsuario(e.target.value)} hint="Con esto va a ingresar. Ej: maria" required />
        <PasswordPair pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />
        <Field label="Rol">
          <Select value={rol} onChange={(e) => setRol(e.target.value)}>
            <option value="operador">Operador</option>
            {isOwner && <option value="administrador">Administrador</option>}
          </Select>
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button type="submit" loading={busy} disabled={!!pw2 && pw !== pw2}>Crear usuario</Button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose, onDone }: { user: WsUser | null; onClose: () => void; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (pw.length < 8) return setError("La contraseña debe tener al menos 8 caracteres.");
    if (pw !== pw2) return setError("Las contraseñas no coinciden.");
    setBusy(true);
    setError(null);
    const err = await api("PATCH", { user_id: user.user_id, password: pw, password2: pw2 });
    setBusy(false);
    if (err) return setError(err);
    setPw(""); setPw2("");
    onDone();
  }
  return (
    <Modal open={user !== null} onClose={onClose} title={`Nueva contraseña para ${user?.username ?? user?.email ?? ""}`} busy={busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <PasswordPair pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button type="submit" loading={busy} disabled={!!pw2 && pw !== pw2}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}

/** El usuario con el que ingresa la persona que tiene la sesión iniciada. */
export function MyUsernameField() {
  const q = useLoader(async () => {
    const { data, error } = await getSupabase().rpc("my_username");
    if (error) throw error;
    return (data as string | null) ?? "";
  }, [], 0);
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const current = q.data ?? "";
  const v = value ?? current;

  async function save() {
    const u = normalizeUsername(v);
    if (!USERNAME_RE.test(u)) return setMsg({ tone: "danger", text: "Entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo (sin espacios)." });
    setBusy(true);
    setMsg(null);
    const { data, error } = await getSupabase().rpc("set_my_username", { p_username: u });
    setBusy(false);
    if (error) return setMsg({ tone: "danger", text: friendlyError(error) });
    setValue(null);
    setMsg({ tone: "ok", text: `Listo: ahora podés ingresar con el usuario «${data as string}».` });
    q.reload();
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-40 flex-1">
          <TextField label="Usuario para ingresar" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={v} onChange={(e) => setValue(e.target.value)} placeholder="Ej: santi" />
        </div>
        <Button type="button" variant="secondary" loading={busy} disabled={!v || normalizeUsername(v) === current} onClick={save}>{current ? "Cambiar" : "Guardar"}</Button>
      </div>
      {!current && !q.loading && <p className="text-xs text-warn">Todavía no elegiste un usuario: mientras tanto ingresás con tu correo.</p>}
      {q.error && <p className="text-xs text-danger">{q.error}</p>}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
    </div>
  );
}
