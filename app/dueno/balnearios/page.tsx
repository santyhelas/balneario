"use client";
import { useRouter } from "next/navigation";
import { OwnerBoard } from "@/components/owner/board";
import { useOwner } from "@/components/owner/context";

export default function OwnerPage() {
  const { mineId } = useOwner();
  const router = useRouter();
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Balnearios</h1>
      <p className="mb-5 text-sm text-muted">Los balnearios que usan Mi Balneario: plan, pagos, cantidad de carpas, pausas y usuarios.</p>
      <OwnerBoard view="balnearios" mineId={mineId} onSupport={(id) => router.push(`/dueno/soporte/${id}`)} />
    </>
  );
}
