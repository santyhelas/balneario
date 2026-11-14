"use client";
import { useRouter } from "next/navigation";
import { OwnerBoard } from "@/components/owner/board";
import { MetricsCharts, MetricsKpis, useOwnerMetrics } from "@/components/owner/metrics";
import { OwnerToday } from "@/components/owner/today";
import { OwnerStatusStrip } from "@/components/owner/status-strip";
import { useOwner } from "@/components/owner/context";

/** Resumen: todo en una pantalla (saludo y estado, indicadores, para hoy y avisos, gráficos). */
export default function OwnerHome() {
  const { mineId } = useOwner();
  const router = useRouter();
  const metrics = useOwnerMetrics();
  const hour = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "America/Argentina/San_Juan" }));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{hour < 13 ? "Buen día" : hour < 20 ? "Buenas tardes" : "Buenas noches"}</h1>
        <OwnerStatusStrip />
      </div>
      <OwnerBoard view="resumen" mineId={mineId} onSupport={(id) => router.push(`/dueno/soporte/${id}`)}
        kpisExtra={<MetricsKpis q={metrics} />} lead={<OwnerToday />} side={<MetricsCharts q={metrics} />} />
    </div>
  );
}
