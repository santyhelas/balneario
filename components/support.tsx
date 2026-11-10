"use client";
import { useState } from "react";
import { SITE_EMAIL, SITE_WHATSAPP } from "@/lib/site";
import { mailtoLink } from "@/lib/whatsapp-messages";
import { useWorkspace } from "@/components/workspace";
import { useMailProvider } from "@/components/whatsapp";
import { startTour } from "@/components/demo-tour";
import { Button, Field, Modal, Select, Textarea, cx } from "@/components/ui";

const KINDS = ["Duda", "Problema o error", "Sugerencia", "Mi plan y pagos"] as const;

/**
 * Ventana de «Consultas»: arma el mensaje para el equipo de Mi Balneario y lo abre en el correo
 * de la cuenta (o en WhatsApp), ya dirigido a nuestro mail. El envío lo confirma la persona en su correo.
 */
export function SupportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { ws, email, isGuest, role } = useWorkspace();
  const sender = useMailProvider();
  const [kind, setKind] = useState<(typeof KINDS)[number]>("Duda");
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const ready = text.trim().length >= 5;

  const subject = `Consulta (${kind.toLowerCase()}) · ${ws.name}`;
  const body = [
    text.trim(),
    "",
    "—",
    `Balneario: ${ws.name}`,
    email ? `Cuenta: ${email}` : null,
    `Enviado desde: ${typeof window !== "undefined" ? window.location.href : ""}`,
  ].filter((l) => l !== null).join("\n");
  const mail = mailtoLink(SITE_EMAIL, subject, body, sender.provider, sender.from);
  const wa = SITE_WHATSAPP ? `https://wa.me/${SITE_WHATSAPP}?text=${encodeURIComponent(`${kind} · ${ws.name}\n\n${text.trim()}`)}` : "";

  function close() {
    onClose();
    setSent(false);
  }

  const linkCls = (primary: boolean) => cx(
    "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold",
    primary ? "bg-accent text-accent-fg hover:opacity-90" : "border border-line bg-surface-2 hover:opacity-90",
    !ready && "pointer-events-none opacity-50",
  );

  return (
    <Modal open={open} onClose={close} title="Consultas"
      footer={<Button variant="secondary" onClick={close}>Cerrar</Button>}>
      <p className="text-sm text-muted">¿Dudas, problemas o ideas? Escribinos y te respondemos a <strong className="text-fg">{email ?? "tu correo"}</strong>.</p>
      <Field label="Sobre qué es">
        <Select value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
          {KINDS.map((k) => <option key={k}>{k}</option>)}
        </Select>
      </Field>
      <Field label="Tu consulta" hint={kind === "Problema o error" ? "Contanos qué estabas haciendo y qué mensaje apareció." : undefined}>
        <Textarea rows={5} value={text} onChange={(e) => { setText(e.target.value); setSent(false); }} placeholder="Escribí tu consulta…" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <a href={ready ? mail : undefined} target={sender.provider === "app" ? undefined : "_blank"} rel="noopener noreferrer"
          aria-disabled={!ready} onClick={() => setSent(true)} className={linkCls(true)}>
          Enviar por mail
        </a>
        {wa && (
          <a href={ready ? wa : undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!ready} onClick={() => setSent(true)} className={linkCls(false)}>
            Enviar por WhatsApp
          </a>
        )}
      </div>
      {sent
        ? <p className="rounded-lg bg-accent-soft px-3 py-2 text-xs text-accent">Se abrió tu correo (o WhatsApp) con la consulta escrita. Tocá «Enviar» ahí para que nos llegue.</p>
        : <p className="text-xs text-muted">Va a {SITE_EMAIL}. Se abre tu correo con el mensaje listo para enviar.</p>}
      {(isGuest || role === "propietario") && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {!isGuest && <Button variant="secondary" onClick={() => { close(); startTour("guia"); }}>Ver la guía de nuevo</Button>}
          {isGuest && <Button variant="secondary" onClick={() => { close(); startTour("novedades"); }}>Ver las novedades</Button>}
        </div>
      )}
    </Modal>
  );
}
