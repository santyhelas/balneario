"use client";
import { useRouter } from "next/navigation";
import { OwnerBoard } from "@/components/owner/board";
import { useOwner } from "@/components/owner/context";
import { PriceTiersCard } from "@/components/owner/tiers";

export default function OwnerPage() {
  const { mineId } = useOwner();
  const router = useRouter();
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Precios</h1>
      <p className="mb-5 text-sm text-muted">Los precios que se proponen a los clientes nuevos.</p>
      <div className="flex flex-col gap-4">
        <OwnerBoard view="precios" mineId={mineId} onSupport={(id) => router.push(`/dueno/soporte/${id}`)} />
        <PriceTiersCard />
      </div>
    </>
  );
}
