"use client";
import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { addDays, formatDate, formatMoney, parseMoney, todayISO } from "@/lib/format";
import { HistoryFeed } from "@/components/history-feed";
import { MONTHS } from "@/lib/methods";
import { useWorkspace } from "@/components/workspace";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Spinner, Textarea, TextField } from "@/components/ui";

type Rate = { id: string; space_kind: "carpa" | "sombrilla"; year: number; month: number; half: 1 | 2; season: string; daily_price: number; version: number };
type Pkg = { id: string; min_days: number; percent: number; active: boolean; version: number };
type Agreement = { id: string; name: string; percent: number; active: boolean; valid_from: string | null; valid_to: string | null; conditions: string | null; version: number };

/** Temporada de una fecha: de julio a junio (ene 2027 → 2026/2027). */
function seasonOf(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return m >= 7 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}
/** Meses de una temporada en orden: jul..dic del primer año, ene..jun del segundo. */
function seasonMonths(season: string, all: boolean): { year: number; month: number }[] {
  const y = Number(season.slice(0, 4));
  const list = [7, 8, 9, 10, 11, 12].map((m) => ({ year: y, month: m })).concat([1, 2, 3, 4, 5, 6].map((m) => ({ year: y + 1, month: m })));
  return all ? list : list.filter((x) => [12, 1, 2, 3].includes(x.month));
}
function lastDay(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export default function TarifasPage() {
  const { ws, isAdmin } = useWorkspace();
  const sb = getSupabase();
  const today = todayISO(ws.timezone);
  const currentSeason = seasonOf(today);
  const nextSeason = `${Number(currentSeason.slice(0, 4)) + 1}/${Number(currentSeason.slice(0, 4)) + 2}`;
  const [season, setSeason] = useState(currentSeason);
  const [allMonths, setAllMonths] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [histFrom, setHistFrom] = useState(addDays(today, -365));
  const [histTo, setHistTo] = useState(today);

  const q = useLoader(async () => {
    const rates = unwrap(await sb.from("rates").select("id, space_kind, year, month, half, season, daily_price, version").eq("workspace_id", ws.id)) as Rate[];
    const pkgs = unwrap(await sb.from("package_discounts").select("id, min_days, percent, active, version").eq("workspace_id", ws.id).order("min_days")) as Pkg[];
    const agreements = unwrap(await sb.from("agreements").select("id, name, percent, active, valid_from, valid_to, conditions, version").eq("workspace_id", ws.id).order("active", { ascending: false }).order("name")) as Agreement[];
    const wsRow = unwrap(await sb.from("workspaces").select("cash_discount_percent, version").eq("id", ws.id).single()) as { cash_discount_percent: number; version: number };
    return { rates, pkgs, agreements, wsRow };
  }, [ws.id], 0);

  const seasons = useMemo(() => {
    const set = new Set<string>([currentSeason, nextSeason]);
    q.data?.rates.forEach((r) => set.add(r.season));
    return [...set].sort();
  }, [q.data, currentSeason, nextSeason]);

  const rateMap = useMemo(() => {
    const m = new Map<string, Rate>();
    q.data?.rates.forEach((r) => m.set(`${r.space_kind}-${r.year}-${r.month}-${r.half}`, r));
    return m;
  }, [q.data]);

  if (!q.data && q.loading) return <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando tarifario…</div>;

  return (
    <>
      <PageHeader
        title="Tarifario"
        subtitle="Precio por día, por quincena. Si una estadía cruza quincenas, cada día se cobra a su precio."
        actions={isAdmin ? <Button variant="secondary" onClick={() => setCopyOpen(true)}>Copiar tarifas</Button> : undefined}
      />
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {!isAdmin && <Alert tone="info" className="mb-4">Solo los administradores pueden modificar precios.</Alert>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card
          title="Precios por día"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Select value={season} onChange={(e) => setSeason(e.target.value)} className="w-auto" aria-label="Temporada">
                {seasons.map((s) => <option key={s} value={s}>Temporada {s}</option>)}
              </Select>
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={allMonths} onChange={(e) => setAllMonths(e.target.checked)} /> Todos los meses
              </label>
            </div>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr><th className="py-2 pr-3">Período</th><th className="pr-3">Carpa ($/día)</th><th>Sombrilla ($/día)</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {seasonMonths(season, allMonths).flatMap(({ year, month }) =>
                  ([1, 2] as const).map((half) => (
                    <tr key={`${year}-${month}-${half}`}>
                      <td className="py-1.5 pr-3">
                        <div className="font-medium">{MONTHS[month - 1]} {year}</div>
                        <div className="text-xs text-muted">{half === 1 ? "1ª quincena · 1 al 15" : `2ª quincena · 16 al ${lastDay(year, month)}`}</div>
                      </td>
                      {(["carpa", "sombrilla"] as const).map((kind) => (
                        <td key={kind} className="pr-3">
                          <PriceCell
                            key={rateMap.get(`${kind}-${year}-${month}-${half}`)?.version ?? 0}
                            rate={rateMap.get(`${kind}-${year}-${month}-${half}`) ?? null}
                            kind={kind}
                            year={year}
                            month={month}
                            half={half}
                            editable={isAdmin}
                            onSaved={q.reload}
                          />
                        </td>
                      ))}
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="Descuentos y convenios">
            <p className="text-sm text-muted">Los descuentos por paquete, el porcentaje por efectivo y los convenios se editan en <Link className="text-accent underline" href="/convenios">Convenios y descuentos</Link>.</p>
          </Card>
          <Card title="Orden de aplicación">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
              <li>Precio base: cada día al precio de su quincena.</li>
              <li>Descuento por paquete (el escalón más alto que alcance la estadía).</li>
              <li>Convenio, sobre lo que queda.</li>
              <li>Pago en efectivo, sobre lo que queda.</li>
              <li>Descuento manual (solo administradores, con motivo).</li>
            </ol>
            <p className="mt-2 text-xs text-muted">Cada descuento se redondea hacia abajo al peso entero. Las reservas ya hechas conservan el precio con el que se contrataron.</p>
          </Card>
        </div>
      </div>

      <Card title="Historial de cambios de tarifas" className="mt-4">
        <p className="mb-3 text-xs text-muted">Cada precio que se cargó o cambió, con el valor anterior y el nuevo, quién lo hizo y cuándo. Las reservas ya hechas no cambian aunque cambie la tarifa.</p>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Field label="Desde"><Input type="date" value={histFrom} max={today} onChange={(e) => e.target.value && setHistFrom(e.target.value)} className="w-auto" /></Field>
          <Field label="Hasta"><Input type="date" value={histTo} min={histFrom} onChange={(e) => e.target.value && setHistTo(e.target.value)} className="w-auto" /></Field>
        </div>
        <HistoryFeed from={histFrom} to={histTo} tables={["rates", "package_discounts"]} includePayments={false} emptyText="No hubo cambios de tarifas en esas fechas." />
      </Card>

      {q.data && <CopyModal open={copyOpen} seasons={seasons} onClose={() => setCopyOpen(false)} onDone={() => { setCopyOpen(false); q.reload(); }} />}
    </>
  );
}

function PriceCell({ rate, kind, year, month, half, editable, onSaved }: { rate: Rate | null; kind: string; year: number; month: number; half: 1 | 2; editable: boolean; onSaved: () => void }) {
  const { ws } = useWorkspace();
  const initial = rate ? String(Number(rate.daily_price)).replace(".", ",") : "";
  const [value, setValue] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (value === initial) return;
    if (value.trim() === "") {
      setValue(initial);
      return;
    }
    const n = parseMoney(value);
    if (n === null || n < 0) {
      setState("error");
      setError("Precio inválido");
      return;
    }
    setState("saving");
    setError(null);
    const { error } = await getSupabase().rpc("set_rate", {
      p_workspace_id: ws.id, p_space_kind: kind, p_year: year, p_month: month, p_half: half,
      p_daily_price: n, p_expected_version: rate?.version ?? null,
    });
    if (error) {
      setState("error");
      setError(friendlyError(error));
      return;
    }
    setState("saved");
    onSaved();
  }

  if (!editable) return <span className="tabular">{rate ? formatMoney(rate.daily_price) : <span className="text-muted">Sin cargar</span>}</span>;
  return (
    <div>
      <Input
        inputMode="decimal"
        value={value}
        placeholder="Sin cargar"
        onChange={(e) => { setValue(e.target.value); setState("idle"); }}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className={`tabular max-w-36 ${state === "error" ? "border-danger" : ""}`}
        aria-label={`Precio ${kind} ${MONTHS[month - 1]} ${year} quincena ${half}`}
        disabled={state === "saving"}
      />
      {state === "saved" && <span className="text-xs text-ok">Guardado</span>}
      {error && <span className="block text-xs text-danger">{error}</span>}
    </div>
  );
}

function CopyModal({ open, seasons, onClose, onDone }: { open: boolean; seasons: string[]; onClose: () => void; onDone: () => void }) {
  const { ws } = useWorkspace();
  const [mode, setMode] = useState<"quincena" | "mes" | "temporada">("mes");
  const [src, setSrc] = useState({ year: new Date().getFullYear() + 1, month: 1, half: 1 as 1 | 2, season: seasons[0] ?? "" });
  const [dst, setDst] = useState({ year: new Date().getFullYear() + 1, month: 2, half: 1 as 1 | 2, season: seasons[seasons.length - 1] ?? "" });
  const [adjust, setAdjust] = useState("0");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const sb = getSupabase();
    const pct = Number(adjust.replace(",", "."));
    if (!Number.isFinite(pct) || pct < -90 || pct > 1000) return setError("Ajuste inválido.");
    setBusy(true);
    setError(null);
    setResult(null);
    const res = mode === "temporada"
      ? await sb.rpc("copy_season", { p_workspace_id: ws.id, p_src_season: src.season, p_dst_season: dst.season, p_adjust_percent: pct, p_overwrite: overwrite })
      : await sb.rpc("copy_rates", {
          p_workspace_id: ws.id, p_src_year: src.year, p_src_month: src.month, p_src_half: mode === "quincena" ? src.half : null,
          p_dst_year: dst.year, p_dst_month: dst.month, p_dst_half: mode === "quincena" ? dst.half : null,
          p_adjust_percent: pct, p_overwrite: overwrite,
        });
    setBusy(false);
    if (res.error) return setError(friendlyError(res.error));
    const r = res.data as { copiados: number; omitidos: number };
    if (r.copiados === 0 && r.omitidos === 0) return setError("No hay precios cargados en el origen elegido.");
    setResult(`Se copiaron ${r.copiados} precios.${r.omitidos ? ` ${r.omitidos} ya existían y no se tocaron.` : ""}`);
  }

  const years = [new Date().getFullYear() - 1, new Date().getFullYear(), new Date().getFullYear() + 1, new Date().getFullYear() + 2];
  const periodPicker = (v: typeof src, set: (x: typeof src) => void) =>
    mode === "temporada" ? (
      <Input value={v.season} onChange={(e) => set({ ...v, season: e.target.value })} placeholder="2026/2027" />
    ) : (
      <div className="flex gap-2">
        <Select value={v.month} onChange={(e) => set({ ...v, month: Number(e.target.value) })}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select>
        <Select value={v.year} onChange={(e) => set({ ...v, year: Number(e.target.value) })}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</Select>
        {mode === "quincena" && (
          <Select value={v.half} onChange={(e) => set({ ...v, half: Number(e.target.value) as 1 | 2 })}><option value={1}>1ª quinc.</option><option value={2}>2ª quinc.</option></Select>
        )}
      </div>
    );

  return (
    <Modal open={open} onClose={() => { setResult(null); onClose(); }} title="Copiar tarifas" busy={busy} wide>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Qué copiar">
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="quincena">Una quincena a otra</option>
            <option value="mes">Un mes a otro (las dos quincenas)</option>
            <option value="temporada">Una temporada completa a otra</option>
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Desde">{periodPicker(src, setSrc)}</Field>
          <Field label="Hacia">{periodPicker(dst, setDst)}</Field>
        </div>
        <TextField label="Ajuste (%)" inputMode="decimal" value={adjust} onChange={(e) => setAdjust(e.target.value)} hint="Ej.: 15 para aumentar 15% por inflación; 0 para copiar igual. Se redondea al peso." />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Reemplazar precios que ya estén cargados en el destino</label>
        {error && <Alert tone="danger">{error}</Alert>}
        {result && <Alert tone="ok">{result}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => { const had = result !== null; setResult(null); if (had) onDone(); else onClose(); }} disabled={busy}>{result ? "Listo" : "Cancelar"}</Button>
          <Button type="submit" loading={busy}>Copiar</Button>
        </div>
      </form>
    </Modal>
  );
}
