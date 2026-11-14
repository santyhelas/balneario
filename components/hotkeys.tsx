"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { HOTKEYS, RESERVED_KEYS, effectiveHotkeys, getHotkeyPrefs, keyName, setHotkeyPrefs, subscribeHotkeys } from "@/lib/hotkeys";
import { useWorkspace } from "@/components/workspace";
import { Alert, Button, Card } from "@/components/ui";

/** Atajos vigentes para el usuario (se actualizan al cambiarlos en Configuración). */
export function useHotkeys() {
  const prefs = useSyncExternalStore(subscribeHotkeys, getHotkeyPrefs, () => null);
  return useMemo(() => effectiveHotkeys(prefs), [prefs]);
}

/** Carga los atajos guardados del usuario (una vez por sesión). */
export function useLoadHotkeys(userId: string) {
  useEffect(() => {
    getSupabase().from("user_preferences").select("hotkeys").eq("user_id", userId).maybeSingle()
      .then(({ data, error }) => { if (!error) setHotkeyPrefs((data as { hotkeys: Record<string, string> | null } | null)?.hotkeys ?? null); });
  }, [userId]);
}

/** Configuración → Atajos de teclado: cada acción con su tecla; se cambia tocando «Cambiar» y apretando la tecla nueva. */
export function HotkeysCard() {
  const { userId, isGuest } = useWorkspace();
  const keys = useHotkeys();
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(keys.map((k) => [k.id, k.key])));
  const [listening, setListening] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const prefsKey = JSON.stringify(keys.map((k) => k.key));
  useEffect(() => { setDraft(Object.fromEntries(keys.map((k) => [k.id, k.key]))); }, [prefsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setListening(null); return; }
      if (e.key === "Backspace" || e.key === "Delete") { setDraft((d) => ({ ...d, [listening]: "" })); setListening(null); return; }
      if (["Alt", "Shift", "Control", "Meta"].includes(e.key)) return;
      const name = keyName(e);
      if (!name) { setMsg({ tone: "warn", text: "Usá una tecla F (F1 a F10) o Alt + una letra o número. Las letras solas no, porque se escriben en los formularios." }); return; }
      if (RESERVED_KEYS.has(name)) { setMsg({ tone: "warn", text: `${name} la usa el navegador (recargar, pantalla completa, etc.). Elegí otra.` }); return; }
      const other = Object.entries(draft).find(([id, k]) => k === name && id !== listening);
      setDraft((d) => ({ ...d, ...(other ? { [other[0]]: "" } : {}), [listening]: name }));
      setMsg(other ? { tone: "warn", text: `${name} estaba en «${HOTKEYS.find((h) => h.id === other[0])?.label}»: ahora esa acción quedó sin atajo.` } : null);
      setListening(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, draft]);

  const changed = keys.some((k) => draft[k.id] !== k.key);
  async function save(next: Record<string, string>) {
    setBusy(true);
    setMsg(null);
    const { error } = await getSupabase().from("user_preferences")
      .upsert({ user_id: userId, hotkeys: next, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    setBusy(false);
    if (error) {
      setMsg({ tone: "danger", text: error.code === "PGRST204" || error.code === "42703" ? "Para guardar atajos hay que aplicar la actualización 0050 de la base de datos." : friendlyError(error) });
      return;
    }
    setHotkeyPrefs(next);
    setMsg({ tone: "ok", text: "Atajos guardados. Valen en esta y en tus otras computadoras." });
  }

  return (
    <Card>
      <p className="mb-3 text-sm text-muted">Apretá la tecla desde cualquier pantalla para ir directo (no funcionan con una ventana abierta). Son tuyos: cada usuario tiene los suyos.</p>
      <ul className="divide-y divide-line text-sm">
        {HOTKEYS.map((h) => (
          <li key={h.id} className="flex items-center justify-between gap-3 py-2">
            <span>{h.label}</span>
            <span className="flex items-center gap-2">
              {listening === h.id
                ? <span className="animate-pulse rounded border border-accent bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent">Apretá la tecla… (Esc cancela, Borrar = sin atajo)</span>
                : draft[h.id]
                  ? <kbd className="rounded border border-line bg-surface-2 px-2 py-0.5 font-mono text-xs font-semibold">{draft[h.id]}</kbd>
                  : <span className="text-xs text-muted">Sin atajo</span>}
              {!isGuest && listening !== h.id && (
                <button type="button" className="text-xs text-accent hover:underline" onClick={() => { setMsg(null); setListening(h.id); }}>Cambiar</button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {msg && <Alert tone={msg.tone} className="mt-3">{msg.text}</Alert>}
      {!isGuest && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => save(draft)} loading={busy} disabled={!changed}>Guardar atajos</Button>
          <Button variant="secondary" disabled={busy} onClick={() => { const d = Object.fromEntries(HOTKEYS.map((h) => [h.id, h.key])); setDraft(d); save(d); }}>Volver a los de fábrica</Button>
        </div>
      )}
    </Card>
  );
}
