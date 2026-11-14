"use client";
import { useRouter } from "next/navigation";
import { OwnerBoard } from "@/components/owner/board";
import { useOwner } from "@/components/owner/context";

export default function OwnerPage() {
  const { mineId } = useOwner();
  const router = useRouter();
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Altas habilitadas</h1>
      <p className="mb-5 text-sm text-muted">Los correos que pueden crear su balneario.</p>
      <OwnerBoard view="altas" mineId={mineId} onSupport={(id) => router.push(`/dueno/soporte/${id}`)} />
    </>
  );
}
