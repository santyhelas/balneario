"use client";
import { useRouter } from "next/navigation";
import { OwnerBoard } from "@/components/owner/board";
import { useOwner } from "@/components/owner/context";

export default function OwnerPage() {
  const { mineId } = useOwner();
  const router = useRouter();
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Precios</h1>
      <p className="mb-5 text-sm text-muted">Los precios que se proponen a los clientes nuevos.</p>
      <OwnerBoard view="precios" mineId={mineId} onSupport={(id) => router.push(`/dueno/soporte/${id}`)} />
    </>
  );
}
