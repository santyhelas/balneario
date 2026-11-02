"use client";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Card, Spinner } from "@/components/ui";
import { AgreementsCard, PackagesCard, type Agreement, type Pkg } from "@/components/pricing";

export default function ConveniosPage() {
  const { ws, isAdmin } = useWorkspace();
  const sb = getSupabase();
  const q = useLoader(async () => {
    const pkgs = unwrap(await sb.from("package_discounts").select("id, min_days, percent, active, version").eq("workspace_id", ws.id).order("min_days")) as Pkg[];
    const agreements = unwrap(await sb.from("agreements").select("id, name, percent, active, valid_from, valid_to, conditions, version").eq("workspace_id", ws.id).order("active", { ascending: false }).order("name")) as Agreement[];
    const wsRow = unwrap(await sb.from("workspaces").select("cash_discount_percent, version").eq("id", ws.id).single()) as { cash_discount_percent: number; version: number };
    return { pkgs, agreements, wsRow };
  }, [ws.id], 0);

  return (
    <>
      <PageHeader title="Convenios y descuentos" subtitle="Descuentos por cantidad de días, por pago en efectivo y convenios con hoteles y entidades." />
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {!isAdmin && <Alert tone="info" className="mb-4">Solo los administradores pueden modificar descuentos y convenios.</Alert>}
      {!q.data ? (q.loading && <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando…</div>) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <PackagesCard pkgs={q.data.pkgs} cashPercent={q.data.wsRow.cash_discount_percent} wsVersion={q.data.wsRow.version} editable={isAdmin} onChanged={q.reload} />
          <div className="flex flex-col gap-4">
            <AgreementsCard agreements={q.data.agreements} editable={isAdmin} onChanged={q.reload} />
            <Card title="Cómo se aplican">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
                <li>Precio base según el tarifario (cada día a su quincena).</li>
                <li>Paquete: el escalón más alto que alcance la estadía.</li>
                <li>Convenio, sobre lo que queda.</li>
                <li>Pago en efectivo, sobre lo que queda.</li>
                <li>Descuento manual (solo administradores, con motivo).</li>
              </ol>
              <p className="mt-2 text-xs text-muted">Cada descuento se redondea hacia abajo al peso. Desactivar un convenio no cambia las reservas ya hechas.</p>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
