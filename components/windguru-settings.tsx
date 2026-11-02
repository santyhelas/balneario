"use client";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { parseWindguru, spotOf } from "@/lib/windguru";
import { useWorkspace } from "@/components/workspace";
import { Alert, Button, Card, Field, Textarea } from "@/components/ui";

/** Configurar el spot de Windguru que se muestra en el panel y en el mapa. */
export function WindguruSettingsCard() {
  const { ws, isAdmin, reloadWorkspace } = useWorkspace();
  const [current, setCurrent] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  async function load() {
    const { data, error } = await getSupabase().from("workspaces").select("windguru_params, version").eq("id", ws.id).single();
    if (error) {
      setMsg({ tone: "danger", text: error.code === "42703" ? "Falta aplicar la actualización 0013 de la base de datos." : friendlyError(error) });
      return;
    }
    const row = data as { windguru_params: string | null; version: number };
    setCurrent(row.windguru_params);
    setVersion(row.version);
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ws.id]);

  async function save(value: string | null) {
    if (version === null) return;
    setBusy(true);
    setMsg(null);
    const { error } = await getSupabase().from("workspaces").update({ windguru_params: value, version: version + 1 }).eq("id", ws.id).select("id").single();
    setBusy(false);
    if (error) {
      setMsg({ tone: "danger", text: friendlyError(error) });
      load();
      return;
    }
    setInput("");
    setMsg({ tone: "ok", text: value ? `Listo: se muestra el pronóstico del spot ${spotOf(value)}.` : "Se quitó el pronóstico de Windguru." });
    await load();
    await reloadWorkspace();
  }

  function submit() {
    const r = parseWindguru(input);
    if ("error" in r) return setMsg({ tone: "danger", text: r.error });
    save(r.params);
  }

  const spot = spotOf(current);
  return (
    <Card title="Clima (Windguru)">
      <p className="mb-3 text-sm text-muted">
        {spot ? <>Spot actual: <a className="font-medium text-accent underline" href={`https://www.windguru.cz/${spot}`} target="_blank" rel="noopener noreferrer">{spot}</a>. Se muestra en el panel y en el mapa.</> : "Todavía no hay un spot cargado."}
      </p>
      {isAdmin ? (
        <div className="flex flex-col gap-3">
          <Field label="Número de spot, dirección o código del widget">
            <Textarea rows={3} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ej: 48572  ·  https://www.windguru.cz/48572  ·  o el código «<script…>» que da Windguru" />
          </Field>
          <p className="text-xs text-muted">
            En windguru.cz buscá tu playa y abrila: el número de spot es el que aparece en la dirección. Si querés elegir modelo, unidades o datos, en la página del spot usá la opción de <strong>widget</strong> y pegá acá el código completo.
          </p>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={submit} loading={busy} disabled={!input.trim()}>Guardar</Button>
            {current && <Button variant="secondary" onClick={() => save(null)} disabled={busy}>Quitar</Button>}
          </div>
        </div>
      ) : (
        msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : <p className="text-xs text-muted">Solo el propietario o un administrador pueden cambiarlo.</p>
      )}
    </Card>
  );
}
