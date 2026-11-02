"use client";
import { PageHeader } from "@/components/shell";
import { Spinner } from "@/components/ui";

// Temporal: se reemplaza por el listado de reservas en la próxima entrega.
export default function ReservasPage() {
  return (
    <>
      <PageHeader title="Reservas" />
      <p className="flex items-center gap-2 text-sm text-muted"><Spinner small /> Esta sección se está terminando.</p>
    </>
  );
}
