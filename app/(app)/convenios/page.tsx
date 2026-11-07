"use client";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Spinner } from "@/components/ui";
import { AgreementsCard, DiscountCapCard, DiscountModeCard, PackagesCard, loadAgreements, type DiscountMode, type Pkg } from "@/components/pricing";

export default function ConveniosPage() {
  const { ws, isAdmin } = useWorkspace();
  const sb = getSupabase();
  const q = useLoader(async () => {
    const pkgs = unwrap(await sb.from("package_discounts").select("id, min_days, percent, active, version").eq("workspace_id", ws.id).order("min_days")) as Pkg[];
    const agreements = await loadAgreements(sb, ws.id);
    let w = await sb.from("workspaces").select("cash_discount_percent, discount_mode, discount_cap_percent, version").eq("id", ws.id).single();
    if (w.error?.code === "42703") w = (await sb.from("workspaces").select("cash_discount_percent, discount_mode, version").eq("id", ws.id).single()) as typeof w;
    if (w.error?.code === "42703") w = (await sb.from("workspaces").select("cash_discount_percent, version").eq("id", ws.id).single()) as typeof w;
    const wsRow = unwrap(w) as { cash_discount_percent: number; discount_mode?: DiscountMode; discount_cap_percent?: number | null; version: number };
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
            <div data-tour="convenios-modo" className="flex flex-col gap-4">
            <DiscountModeCard mode={q.data.wsRow.discount_mode ?? null} wsVersion={q.data.wsRow.version} editable={isAdmin} onChanged={q.reload} />
            <DiscountCapCard key={`cap${q.data.wsRow.version}`} cap={q.data.wsRow.discount_cap_percent} wsVersion={q.data.wsRow.version} editable={isAdmin} onChanged={q.reload} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
