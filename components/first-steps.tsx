"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { useWorkspace } from "@/components/workspace";
import { useStatus } from "@/components/status";
import { Button, cx } from "@/components/ui";

/**
 * Primeros pasos para un balneario nuevo: una lista en el Panel que se tilda sola
 * a medida que se carga lo necesario (tarifas, caja, primera reserva...).
 * Se oculta cuando está todo hecho, o si el dueño la cierra (eso se recuerda en este navegador).
 */

type Step = {
  key: string;
  title: string;
  text: string;
  href: string;
  action: string;
  done: boolean;
  optional?: boolean;
};

const HIDE_KEY = (ws: string) => `mb-primeros-pasos-oculto:${ws}`;

export function FirstSteps({ onOpenCash }: { onOpenCash: () => void }) {
  const { ws, isAdmin, isGuest } = useWorkspace();
  const st = useStatus();
  const cajaEstado = st.summary?.caja.estado;
  const [hidden, setHidden] = useState(true);
  const [state, setState] = useState<null | { rates: number; cash: number; res: number; customers: number; plano: number; welcome: boolean }>(null);

  useEffect(() => {
    try { setHidden(localStorage.getItem(HIDE_KEY(ws.id)) === "1"); } catch { setHidden(false); }
  }, [ws.id]);

  const load = useCallback(async () => {
    const sb = getSupabase();
    const count = async (table: string) => {
      const { count: n } = await sb.from(table).select("id", { count: "exact", head: true }).eq("workspace_id", ws.id);
      return n ?? 0;
    };
    const [rates, cash, res, customers, plano, wsRow] = await Promise.all([
      count("rates"), count("cash_sessions"), count("reservations"), count("customers"), count("map_features"),
      sb.from("workspaces").select("message_templates").eq("id", ws.id).maybeSingle(),
    ]);
    const tpl = (wsRow.data?.message_templates ?? {}) as Record<string, string>;
    setState({ rates, cash, res, customers, plano, welcome: !!tpl.bienvenida?.trim() });
  }, [ws.id]);

  useEffect(() => {
    if (!isAdmin || isGuest || hidden) return;
    load();
  }, [isAdmin, isGuest, hidden, load, cajaEstado]);

  if (!isAdmin || isGuest || hidden || !state) return null;

  const steps: Step[] = [
    {
      key: "datos", title: "Datos del balneario",
      text: "Nombre, logo y la ubicación de la playa (para el clima y el viento).",
      href: "/configuracion", action: "Ir a Configuración", done: ws.latitude !== null,
    },
    {
      key: "plano", title: "Armá el plano",
      text: "En el Mapa tocá «Editar plano»: mové las carpas a su lugar y dibujá pasillos, parador y baños.",
      href: "/mapa", action: "Ir al Mapa", done: state.plano > 0,
    },
    {
      key: "tarifas", title: "Cargá los precios",
      text: "En el Tarifario poné el precio por día de carpa y sombrilla para cada quincena. Si todavía no los tenés, al reservar podés poner el precio a mano.",
      href: "/tarifas", action: "Ir al Tarifario", done: state.rates > 0,
    },
    {
      key: "caja", title: "Abrí la caja del día",
      text: "Para registrar cobros (al reservar o después) la caja del día tiene que estar abierta. Se abre con el efectivo que hay.",
      href: "/caja", action: "Abrir la caja", done: state.cash > 0,
    },
    {
      key: "reserva", title: "Cargá tu primera reserva",
      text: "Con «Nueva reserva»: el cliente (se crea ahí mismo), las fechas, la carpa y el cobro. Si ya tenías reservas anotadas, cargalas así una por una.",
      href: "/reservas/nueva", action: "Nueva reserva", done: state.res > 0,
    },
    {
      key: "bienvenida", title: "Escribí tu mensaje de bienvenida", optional: true,
      text: "El WhatsApp que le mandás al cliente al reservar, con las reglas del balneario.",
      href: "/configuracion#mensajes", action: "Escribirlo", done: state.welcome,
    },
  ];
  const required = steps.filter((s) => !s.optional);
  const doneCount = required.filter((s) => s.done).length;
  if (doneCount === required.length) return null;
  const next = steps.find((s) => !s.done);

  function hide() {
    try { localStorage.setItem(HIDE_KEY(ws.id), "1"); } catch { /* sin almacenamiento: se oculta solo por ahora */ }
    setHidden(true);
  }

  return (
    <section className="rounded-2xl border border-accent/30 bg-surface p-4 shadow-sm md:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">Primeros pasos</h2>
          <p className="text-sm text-muted">Hecho {doneCount} de {required.length}. Se tilda solo a medida que cargás cada cosa.</p>
        </div>
        <button type="button" onClick={hide} className="text-xs text-muted hover:underline">Ocultar</button>
      </div>
      <div className="mb-4 h-2 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full w-full origin-left rounded-full bg-accent transition-transform duration-300 ease-out motion-reduce:transition-none" style={{ transform: `scaleX(${doneCount / required.length})` }} />
      </div>
      <ol className="flex flex-col gap-2">
        {steps.map((s, i) => {
          const isNext = s.key === next?.key;
          return (
            <li key={s.key} className={cx("flex flex-wrap items-center gap-3 rounded-xl border p-3", isNext ? "border-accent bg-accent-soft/40" : "border-line", s.done && "opacity-70")}>
              <span className={cx("grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-bold",
                s.done ? "bg-ok text-white" : isNext ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted")}>
                {s.done ? "✓" : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className={cx("font-semibold", s.done && "line-through decoration-1")}>
                  {s.title}{s.optional && <span className="ml-1 text-xs font-normal text-muted">(opcional)</span>}
                </div>
                {!s.done && <p className="text-sm text-muted">{s.text}</p>}
              </div>
              {!s.done && (
                s.key === "caja"
                  ? <Button variant={isNext ? "primary" : "secondary"} onClick={onOpenCash}>{s.action}</Button>
                  : <Link href={s.href}><Button variant={isNext ? "primary" : "secondary"}>{s.action}</Button></Link>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
