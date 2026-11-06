"use client";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { Alert, Badge, Button, Card, ConfirmDialog, TextField } from "@/components/ui";

/** "Mi plan": el plan de Mi Balneario del balneario, el débito automático y "No renovar". */

const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "danger" | "info" }> = {
  pendiente: { label: "Sin activar", tone: "warn" },
  activa: { label: "Débito automático activo", tone: "ok" },
  cancelada: { label: "No se renueva", tone: "warn" },
  manual: { label: "Pago manual", tone: "info" },
  exenta: { label: "Sin vencimiento", tone: "ok" },
};
const EVENT: Record<string, string> = {
  alta: "Alta del plan", debito_activado: "Débito activado", pago_aprobado: "Pago aprobado", pago_rechazado: "Pago rechazado",
  cancelada: "No se renueva", pago_manual: "Pago registrado", cambio_plan: "Cambio de plan",
};

export function PlanCard() {
  const { plan, role, email, reloadPlan, ws } = useWorkspace();
  const owner = role === "propietario";
  const [payer, setPayer] = useState(email && !email.endsWith(".invalid") ? email : "");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger" | "info"; text: string } | null>(null);

  // Al volver de Mercado Pago: el aviso de Mercado Pago puede tardar unos segundos.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("plan") !== "listo") return;
    window.history.replaceState(null, "", window.location.pathname + "#plan");
    setMsg({ tone: "info", text: "¡Gracias! En cuanto Mercado Pago confirme el débito se actualiza acá (puede tardar unos minutos)." });
    document.getElementById("plan")?.scrollIntoView({ behavior: "smooth" });
    const ids = [5_000, 15_000, 45_000].map((ms) => setTimeout(() => { reloadPlan(); }, ms));
    return () => ids.forEach(clearTimeout);
  }, [reloadPlan]);

  if (!plan) return null;
  const st = STATUS[plan.estado] ?? { label: plan.estado, tone: "info" as const };
  const exempt = plan.estado === "exenta";

  async function subscribe() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/plan/suscribir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: payer.trim() }) });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error ?? "No se pudo abrir Mercado Pago.");
      window.location.assign(body.url);
    } catch (err) {
      setBusy(false);
      setMsg({ tone: "danger", text: err instanceof Error ? err.message : "No se pudo abrir Mercado Pago." });
    }
  }

  async function cancel() {
    setBusy(true);
    setMsg(null);
    try {
      if (plan!.debito_automatico) {
        const res = await fetch("/api/plan/cancelar", { method: "POST" });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(body.error ?? "No se pudo cancelar.");
      } else {
        const { error } = await getSupabase().rpc("cancel_my_plan", { p_workspace_id: ws.id });
        if (error) throw new Error(friendlyError(error));
      }
      setConfirm(false);
      await reloadPlan();
      setMsg({ tone: "ok", text: `Listo: no se renueva. Seguís usando todo hasta el ${formatDate(plan!.pago_hasta)}; después tus datos quedan para ver y descargar.` });
    } catch (err) {
      setMsg({ tone: "danger", text: err instanceof Error ? err.message : "No se pudo cancelar." });
    } finally {
      setBusy(false);
    }
  }

  const planName = plan.plan === "mensual" ? "Mensual" : "Por temporada (1/12 al 31/3)";
  const canActivate = owner && !exempt && !plan.debito_automatico;

  return (
    <section id="plan" className="scroll-mt-20">
      <Card title="Mi plan">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="font-semibold">{planName}</span>
          <span className="tabular text-muted">· {formatMoney(plan.precio)}{plan.plan === "mensual" ? " por mes" : " por temporada"}</span>
          <Badge tone={plan.vencido ? "danger" : st.tone}>{plan.vencido ? "Vencido: solo lectura" : st.label}</Badge>
        </div>
        {!exempt && (
          <dl className="mb-3 grid grid-cols-2 gap-2 text-sm">
            <div><dt className="text-xs text-muted">Pago hasta</dt><dd className="font-medium">{formatDate(plan.pago_hasta)}</dd></div>
            {plan.debito_automatico
              ? <div><dt className="text-xs text-muted">Próximo débito</dt><dd className="font-medium">{plan.proximo_debito ? formatDate(plan.proximo_debito) : "—"}</dd></div>
              : <div><dt className="text-xs text-muted">Solo lectura desde</dt><dd className="font-medium">{formatDate(plan.bloquea_desde)}</dd></div>}
            {plan.pagador && <div className="col-span-2"><dt className="text-xs text-muted">Cuenta que paga</dt><dd>{plan.pagador}</dd></div>}
          </dl>
        )}
        {plan.ultimo_estado === "rechazado" && !plan.vencido && (
          <Alert tone="warn" className="mb-3">Mercado Pago no pudo cobrar el último débito. Revisá que la tarjeta tenga fondos o esté vigente; Mercado Pago lo reintenta solo.</Alert>
        )}

        {canActivate && (
          <div className="mb-3 rounded-xl border border-line bg-surface-2 p-3">
            <p className="mb-2 text-sm">
              {plan.plan === "mensual"
                ? "Activá el débito automático: Mercado Pago te cobra cada mes y no tenés que acordarte."
                : "Activá el débito automático: Mercado Pago te cobra la temporada cada 1 de diciembre."}{" "}
              Podés pagar con tarjeta de crédito, débito o dinero en cuenta, y cancelarlo cuando quieras.
            </p>
            <TextField label="Correo de tu cuenta de Mercado Pago" type="email" value={payer} onChange={(e) => setPayer(e.target.value)} />
            <Button className="mt-2" loading={busy} onClick={subscribe}>Activar débito con Mercado Pago</Button>
            {plan.plan === "temporada" && ["12", "01", "02", "03"].includes(plan.hoy.slice(5, 7)) && (
              <p className="mt-2 text-xs text-muted">Con la temporada ya empezada, el débito arranca el próximo 1/12. Esta temporada se paga aparte: escribinos.</p>
            )}
          </div>
        )}

        {msg && <Alert tone={msg.tone} className="mb-3">{msg.text}</Alert>}

        {owner && !exempt && plan.estado !== "cancelada" && (
          <Button variant="ghost" onClick={() => setConfirm(true)}>No renovar</Button>
        )}
        {!owner && !exempt && <p className="text-xs text-muted">El plan lo maneja el propietario del balneario.</p>}

        {plan.movimientos.length > 0 && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-muted">Movimientos del plan</summary>
            <ul className="mt-2 divide-y divide-line">
              {plan.movimientos.map((m, i) => (
                <li key={i} className="flex justify-between gap-2 py-1.5">
                  <span>{EVENT[m.tipo] ?? m.tipo}<span className="block text-xs text-muted">{formatDateTime(m.fecha, ws.timezone)}{m.detalle ? ` · ${m.detalle}` : ""}</span></span>
                  {m.importe != null && <span className={m.tipo === "pago_rechazado" ? "tabular text-danger" : "tabular"}>{formatMoney(m.importe)}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
      <ConfirmDialog open={confirm} title="No renovar el plan" confirmLabel="No renovar" danger busy={busy}
        message={<>Se cancela {plan.debito_automatico ? "el débito automático en Mercado Pago" : "la renovación"}. Seguís usando todo hasta el <strong>{formatDate(plan.pago_hasta)}</strong>; después el sistema queda en solo lectura: ves y descargás tus datos, pero no cargás cambios. Lo podés reactivar cuando quieras.</>}
        onCancel={() => setConfirm(false)} onConfirm={cancel} />
    </section>
  );
}
