"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { OwnerBoard } from "@/components/owner/board";
import { useOwner } from "@/components/owner/context";

export default function OwnerPage() {
  const { mineId } = useOwner();
  const router = useRouter();
  // Desde «Interesados» → «Habilitar»: llega con el correo y el nombre ya puestos.
  const [prefill, setPrefill] = useState<{ email: string; note: string } | null | undefined>(undefined);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setPrefill(p.get("correo") ? { email: p.get("correo")!, note: p.get("nota") ?? "" } : null);
  }, []);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Altas habilitadas</h1>
      <p className="mb-5 text-sm text-muted">Los correos que pueden crear su balneario.</p>
      {prefill !== undefined && <OwnerBoard view="altas" mineId={mineId} prefill={prefill} onSupport={(id) => router.push(`/dueno/soporte/${id}`)} />}
    </>
  );
}
