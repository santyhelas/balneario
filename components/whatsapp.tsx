"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { useLoader } from "@/lib/data";
import { whatsappLink } from "@/lib/reservations";
import { mailtoLink, providerForEmail, type MailProvider, type Templates } from "@/lib/whatsapp-messages";
import { useWorkspace } from "@/components/workspace";
import { Button, Modal, Textarea, cx } from "@/components/ui";

/** Mensajes propios del balneario (Configuración → Mensajes de WhatsApp). Sin la actualización 0027: los de siempre. */
export function useMessageTemplates(): Templates | null {
  const { ws } = useWorkspace();
  const q = useLoader<Templates | null>(async () => {
    const { data, error } = await getSupabase().from("workspaces").select("message_templates").eq("id", ws.id).maybeSingle();
    if (error) return null;
    return ((data as { message_templates: Templates | null } | null)?.message_templates) ?? null;
  }, [ws.id], 300_000);
  const { reload } = q;
  useEffect(() => {
    window.addEventListener("plantillas-cambiaron", reload);
    return () => window.removeEventListener("plantillas-cambiaron", reload);
  }, [reload]);
  return q.data ?? null;
}

/**
 * Botón de WhatsApp que primero muestra el mensaje para editarlo antes de mandarlo.
 * Lo que se cambia acá vale solo para este envío; el mensaje de siempre se cambia en Configuración.
 */
export function WhatsAppSend({ phone, text, label = "WhatsApp", title, className, onSent }: {
  phone: string | null; text: string; label?: string; title?: string; className?: string; onSent?: () => void;
}) {
  const { isAdmin } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(text);
  const link = whatsappLink(phone, draft.trim() || text);
  if (!whatsappLink(phone, text)) return <span className="text-xs text-muted" title="El cliente no tiene un celular válido cargado">Sin teléfono</span>;

  return (
    <>
      <button type="button" title={title ?? "Ver y editar el mensaje antes de mandarlo"} onClick={() => { setDraft(text); setOpen(true); }}
        className={cx("rounded-lg border border-green-600/40 bg-green-50 px-2.5 py-1.5 text-sm font-semibold text-green-800 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-200", className)}>
        {label}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Mensaje de WhatsApp"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancelar</Button>
            <a href={link ?? "#"} target="_blank" rel="noopener noreferrer" onClick={() => { setOpen(false); onSent?.(); }}>
              <Button>Abrir WhatsApp</Button>
            </a>
          </>
        }
      >
        <p className="text-xs text-muted">Podés cambiar el texto antes de mandarlo. El cambio vale solo para este mensaje.</p>
        <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={8} maxLength={2000} aria-label="Mensaje" />
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <button type="button" className="text-muted hover:underline" onClick={() => setDraft(text)} disabled={draft === text}>Volver al texto original</button>
          {isAdmin && <Link href="/configuracion#mensajes" className="text-accent hover:underline" onClick={() => setOpen(false)}>Cambiar el mensaje de siempre</Link>}
        </div>
      </Modal>
    </>
  );
}

/** Con qué correo trabaja el balneario (Configuración → Mensajes → Correo). Sin la actualización 0035: Gmail. */
export type MailSender = { provider: MailProvider; from: string | null };

/** El correo desde el que se escribe: el de la cuenta con la que se entró al sistema. */
export function useMailProvider(): MailSender {
  const { email } = useWorkspace();
  return useMemo(() => ({ provider: providerForEmail(email), from: email }), [email]);
}

/** Botón «Enviar correo»: abre la ventana para escribirle al cliente desde el correo de la cuenta. */
export function MailButton(props: { email: string; subject: string; body: string; className?: string; label?: string }) {
  const sender = useMailProvider();
  return <MailLink {...props} provider={sender} />;
}

/** Igual que MailButton, pero con el correo ya elegido (para listas largas: se consulta una sola vez). */
export function MailLink({ email, subject, body, className, label = "Enviar correo", provider: sender }: { email: string; subject: string; body: string; className?: string; label?: string; provider: MailSender }) {
  const { provider, from } = sender;
  return (
    <a href={mailtoLink(email, subject, body, provider, from)} target={provider === "app" ? undefined : "_blank"} rel="noopener noreferrer"
      title={`Escribir a ${email}${from ? ` desde ${from}` : ""} (el mensaje se cambia en Configuración → Mensajes → Correo)`}
      className={cx("inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent-soft px-3 py-1.5 text-sm font-semibold text-accent hover:opacity-90", className)}>
      {label}
    </a>
  );
}
