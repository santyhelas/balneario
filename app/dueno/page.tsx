"use client";
import { useRouter } from "next/navigation";
import { OwnerBoard } from "@/components/owner/board";
import { OwnerMetrics } from "@/components/owner/metrics";
import { OwnerToday } from "@/components/owner/today";
import { useOwner } from "@/components/owner/context";

export default function OwnerHome() {
  const { mineId } = useOwner();
  const router = useRouter();
  const hour = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "America/Argentina/San_Juan" }));
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{hour < 13 ? "Buen día" : hour < 20 ? "Buenas tardes" : "Buenas noches"}</h1>
        <p className="text-sm text-muted">Así viene Mi Balneario hoy.</p>
      </div>
      <OwnerToday />
      <OwnerBoard view="resumen" mineId={mineId} onSupport={(id) => router.push(`/dueno/soporte/${id}`)} />
      <OwnerMetrics />
    </div>
  );
}
