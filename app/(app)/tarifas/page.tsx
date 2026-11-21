"use client";
import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useLoader } from "@/lib/data";
import { friendlyError } from "@/lib/errors";
import { addDays, formatDate, formatMoney, parseMoney, todayISO } from "@/lib/format";
import { HistoryFeed } from "@/components/history-feed";
import { loadAgreements } from "@/components/pricing";
import { MONTHS } from "@/lib/methods";
import { useWorkspace } from "@/components/workspace";
import { featuresOf } from "@/lib/features";
import { PageHeader, SyncNotice } from "@/components/shell";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Spinner, Textarea, TextField, DateInput } from "@/components/ui";
import { KindName, type SpaceKind } from "@/lib/space-kinds";

type Rate = { id: string; space_kind: SpaceKind; year: number; month: number; half: 1 | 2; season: string; daily_price: number; version: number };
type Pkg = { id: string; min_days: number; percent: number; active: boolean; version: number };
type FixedPkg = { id: string; space_kind: SpaceKind; days: number; price: number; valid_from: string | null; valid_to: string | null; version: number };
/** Cantidades de días que se ofrecen en cada mes (además de las que ya tengan precio). */
const DEFAULT_PACKAGE_DAYS = [7, 10, 15, 30];
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
const pad = (n: number) => String(n).padStart(2, "0");
/** Primer y último día de una quincena (ISO). */
function halfBounds(year: number, month: number, half: 1 | 2): [string, string] {
  return half === 1 ? [`${year}-${pad(month)}-01`, `${year}-${pad(month)}-15`] : [`${year}-${pad(month)}-16`, `${year}-${pad(month)}-${pad(lastDay(year, month))}`];
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
    const agreements = await loadAgreements(sb, ws.id);
    const wsRow = unwrap(await sb.from("workspaces").select("cash_discount_percent, version").eq("id", ws.id).single()) as { cash_discount_percent: number; version: number };
    const fixedQ = await sb.from("package_prices").select("id, space_kind, days, price, valid_from, valid_to, version").eq("workspace_id", ws.id).eq("active", true);
    const fixed = fixedQ.error ? [] : (fixedQ.data ?? []) as FixedPkg[];
    const { count: parking } = await sb.from("spaces").select("id", { count: "exact", head: true }).eq("workspace_id", ws.id).eq("kind", "cochera").eq("active", true);
    return { rates, pkgs, agreements, wsRow, parking: parking ?? 0, fixed };
  }, [ws.id], 0);

  // La columna de cocheras aparece si el balneario tiene cocheras (o ya les cargó precio).
  const kinds: SpaceKind[] = (q.data?.parking ?? 0) > 0 || q.data?.rates.some((r) => r.space_kind === "cochera")
    ? ["carpa", "sombrilla", "cochera"] : ["carpa", "sombrilla"];

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

  const fixedMode = featuresOf(ws).paquetes;
  const pkgMap = useMemo(() => {
    const m = new Map<string, FixedPkg>();
    q.data?.fixed.forEach((p) => p.valid_from && p.valid_to && m.set(`${p.space_kind}-${p.valid_from}-${p.valid_to}-${p.days}`, p));
    return m;
  }, [q.data]);

  if (!q.data && q.loading) return <div className="flex items-center gap-2 text-muted"><Spinner small /> Cargando tarifario…</div>;

  return (
    <>
      <PageHeader
        title="Tarifario"
        subtitle="Precio por día de cada mes y, adentro, por quincena y por cantidad de días. Si una estadía cruza quincenas, cada día se cobra a su precio."
        actions={isAdmin ? <Button variant="secondary" onClick={() => setCopyOpen(true)}>Copiar tarifas</Button> : undefined}
      />
      <SyncNotice error={q.error} stale={q.stale} updatedAt={q.updatedAt} onRetry={q.reload} />
      {!isAdmin && <Alert tone="info" className="mb-4">Solo los administradores pueden modificar precios.</Alert>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card
          tour="tarifas"
          title="Precios por mes"
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
          <p className="mb-3 text-xs text-muted">
            {fixedMode
              ? "Poné el precio por día de cada mes. Tocá el mes para cambiarlo por quincena y cargar los precios por 7, 10, 15 o 30 días: el día que pasa del paquete se suma al precio normal (7 días + 1 día)."
              : "Poné el precio por día de cada mes. Tocá el mes para cambiarlo por quincena. Los descuentos por cantidad de días están en %, en Descuentos y convenios."}
          </p>
          <div className="flex flex-col gap-2">
            {seasonMonths(season, allMonths).map(({ year, month }) => (
              <MonthBlock key={`${year}-${month}`} year={year} month={month} kinds={kinds} rateMap={rateMap} pkgMap={pkgMap}
                fixedMode={fixedMode} editable={isAdmin} onSaved={q.reload} />
            ))}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="Descuentos y convenios">
            <p className="text-sm text-muted">Si se cobra con precio fijo o con % por cantidad de días, el porcentaje por efectivo y los convenios se eligen en <Link className="text-accent underline" href="/convenios">Descuentos y convenios</Link>.</p>
          </Card>
          <Card title="Cómo se calcula el precio">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
              {fixedMode && <li>Si la estadía llega a un paquete de la quincena de entrada (7, 10, 15… días), se cobra el paquete más largo que entra y cada día de más al precio normal.</li>}
              <li>Si no, precio base: cada día al precio de su quincena.</li>
              <li>Descuentos que correspondan ({fixedMode ? "" : "paquete en % por días, "}convenio, pago en efectivo), combinados como elegiste en <Link className="text-accent underline" href="/convenios">Descuentos y convenios</Link>: en cascada, sumados o no acumulables.</li>
              <li>Descuento manual (solo administradores, con motivo), al final.</li>
            </ol>
            <p className="mt-2 text-xs text-muted">Cada descuento se redondea hacia abajo al peso entero. Las reservas ya hechas conservan el precio con el que se contrataron.</p>
          </Card>
        </div>
      </div>

      <Card title="Historial de cambios de tarifas" className="mt-4">
        <p className="mb-3 text-xs text-muted">Cada precio que se cargó o cambió, con el valor anterior y el nuevo, quién lo hizo y cuándo. Las reservas ya hechas no cambian aunque cambie la tarifa.</p>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Field label="Desde"><DateInput value={histFrom} max={today} onChange={setHistFrom} label="Desde" /></Field>
          <Field label="Hasta"><DateInput value={histTo} min={histFrom} onChange={setHistTo} label="Hasta" /></Field>
        </div>
        <HistoryFeed from={histFrom} to={histTo} tables={["rates", "package_discounts", "package_prices"]} includePayments={false} emptyText="No hubo cambios de tarifas en esas fechas." />
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

/** Un mes del tarifario: precio por día (para todo el mes) y, adentro, cada quincena con sus paquetes. */
function MonthBlock({ year, month, kinds, rateMap, pkgMap, fixedMode, editable, onSaved }: {
  year: number; month: number; kinds: SpaceKind[]; rateMap: Map<string, Rate>; pkgMap: Map<string, FixedPkg>;
  fixedMode: boolean; editable: boolean; onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [extraDays, setExtraDays] = useState<number[]>([]);
  const [newDays, setNewDays] = useState("");
  const bounds = { 1: halfBounds(year, month, 1), 2: halfBounds(year, month, 2) } as const;
  const monthPkgs = [...pkgMap.values()].filter((p) => p.valid_from === bounds[1][0] || p.valid_from === bounds[2][0]);
  const days = [...new Set([...DEFAULT_PACKAGE_DAYS, ...monthPkgs.map((p) => p.days), ...extraDays])].sort((a, b) => a - b);
  const loaded = monthPkgs.filter((p) => (p.valid_from === bounds[1][0] && p.valid_to === bounds[1][1]) || (p.valid_from === bounds[2][0] && p.valid_to === bounds[2][1])).length;

  return (
    <div className="rounded-xl border border-line">
      <div className="flex flex-wrap items-center gap-3 p-2">
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-36 items-center gap-2 text-left font-medium" aria-expanded={open}>
          <span className={`inline-block text-muted transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
          {MONTHS[month - 1]} {year}
        </button>
        <div className="flex flex-1 flex-wrap items-end gap-3">
          {kinds.map((kind) => (
            <label key={kind} className="flex flex-col gap-0.5 text-xs text-muted">
              {KindName(kind)} $/día
              <MonthPriceCell
                key={`${rateMap.get(`${kind}-${year}-${month}-1`)?.version ?? 0}-${rateMap.get(`${kind}-${year}-${month}-2`)?.version ?? 0}`}
                r1={rateMap.get(`${kind}-${year}-${month}-1`) ?? null} r2={rateMap.get(`${kind}-${year}-${month}-2`) ?? null}
                kind={kind} year={year} month={month} editable={editable} onSaved={onSaved} />
            </label>
          ))}
        </div>
        <button type="button" onClick={() => setOpen(!open)} className="text-xs text-accent hover:underline">
          {open ? "Cerrar" : fixedMode ? `Quincenas y paquetes${loaded ? ` (${loaded})` : ""}` : "Por quincena"}
        </button>
      </div>
      {open && (
        <div className="grid gap-3 border-t border-line p-3 lg:grid-cols-2">
          {([1, 2] as const).map((half) => (
            <div key={half}>
              <div className="mb-1 text-sm font-medium">{half === 1 ? "1ª quincena" : "2ª quincena"} <span className="text-xs font-normal text-muted">· {half === 1 ? "1 al 15" : `16 al ${lastDay(year, month)}`}</span></div>
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted"><tr><th className="py-1 pr-2" />{kinds.map((k) => <th key={k} className="pr-2 font-normal">{KindName(k)}</th>)}</tr></thead>
                <tbody className="divide-y divide-line">
                  <tr>
                    <td className="py-1 pr-2 text-xs text-muted">Por día</td>
                    {kinds.map((kind) => (
                      <td key={kind} className="py-1 pr-2">
                        <PriceCell key={rateMap.get(`${kind}-${year}-${month}-${half}`)?.version ?? 0}
                          rate={rateMap.get(`${kind}-${year}-${month}-${half}`) ?? null} kind={kind} year={year} month={month} half={half} editable={editable} onSaved={onSaved} />
                      </td>
                    ))}
                  </tr>
                  {fixedMode && days.map((d) => (
                    <tr key={d}>
                      <td className="py-1 pr-2 text-xs text-muted whitespace-nowrap">{d} días</td>
                      {kinds.map((kind) => {
                        const pkg = pkgMap.get(`${kind}-${bounds[half][0]}-${bounds[half][1]}-${d}`) ?? null;
                        return (
                          <td key={kind} className="py-1 pr-2">
                            <PackageCell key={pkg ? `${pkg.id}-${pkg.version}` : "nuevo"} pkg={pkg} days={d} kind={kind} year={year} month={month} half={half}
                              daily={rateMap.get(`${kind}-${year}-${month}-${half}`)?.daily_price ?? null} editable={editable} onSaved={onSaved} />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {fixedMode && editable && (
            <form className="flex flex-wrap items-center gap-2 text-xs text-muted lg:col-span-2"
              onSubmit={(e) => { e.preventDefault(); const n = Number(newDays); if (Number.isInteger(n) && n >= 2 && n <= 366) { setExtraDays([...extraDays, n]); setNewDays(""); } }}>
              Otra cantidad de días:
              <Input inputMode="numeric" value={newDays} onChange={(e) => setNewDays(e.target.value.replace(/\D/g, ""))} placeholder="ej. 20" className="w-20" aria-label="Otra cantidad de días" />
              <Button type="submit" variant="secondary">Agregar fila</Button>
              <span>Dejá vacío un paquete para no usarlo. Se elige por el día de entrada.</span>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

/** Precio por día de todo el mes: guarda las dos quincenas. Si son distintas, se ven adentro del mes. */
function MonthPriceCell({ r1, r2, kind, year, month, editable, onSaved }: { r1: Rate | null; r2: Rate | null; kind: string; year: number; month: number; editable: boolean; onSaved: () => void }) {
  const { ws } = useWorkspace();
  const same = r1 && r2 && Number(r1.daily_price) === Number(r2.daily_price);
  const initial = same ? String(Number(r1.daily_price)).replace(".", ",") : "";
  const placeholder = !r1 && !r2 ? "Sin cargar" : same ? "" : "Varía";
  const [value, setValue] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (value === initial || value.trim() === "") { setValue(initial); return; }
    const n = parseMoney(value);
    if (n === null || n < 0) { setState("error"); setError("Precio inválido"); return; }
    setState("saving");
    setError(null);
    for (const [half, rate] of [[1, r1], [2, r2]] as const) {
      const { error } = await getSupabase().rpc("set_rate", {
        p_workspace_id: ws.id, p_space_kind: kind, p_year: year, p_month: month, p_half: half,
        p_daily_price: n, p_expected_version: rate?.version ?? null,
      });
      if (error) { setState("error"); setError(friendlyError(error)); onSaved(); return; }
    }
    setState("saved");
    onSaved();
  }

  if (!editable) return <span className="tabular text-fg">{same ? formatMoney(r1.daily_price) : <span className="text-muted">{placeholder || "—"}</span>}</span>;
  return (
    <span className="inline-flex flex-col">
      <Input inputMode="decimal" value={value} placeholder={placeholder}
        onChange={(e) => { setValue(e.target.value); setState("idle"); }}
        onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className={`tabular w-28! py-1 ${state === "error" ? "border-danger" : ""}`}
        aria-label={`Precio por día ${kind} ${MONTHS[month - 1]} ${year}`} disabled={state === "saving"} />
      {state === "saved" && <span className="text-xs text-ok">Guardado</span>}
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}

/** Precio fijo de un paquete de N días en una quincena. Vacío = sin paquete. Muestra qué % de descuento es. */
function PackageCell({ pkg, days, kind, year, month, half, daily, editable, onSaved }: {
  pkg: FixedPkg | null; days: number; kind: string; year: number; month: number; half: 1 | 2; daily: number | null; editable: boolean; onSaved: () => void;
}) {
  const { ws } = useWorkspace();
  const initial = pkg ? String(Number(pkg.price)).replace(".", ",") : "";
  const [value, setValue] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const n = value.trim() === "" ? null : parseMoney(value);
  const normal = daily !== null ? Number(daily) * days : null;
  const pct = n !== null && normal ? Math.round((1 - n / normal) * 1000) / 10 : null;

  async function save() {
    if (value === initial) return;
    if (value.trim() !== "" && (n === null || n < 0)) { setState("error"); setError("Precio inválido"); return; }
    if (!pkg && value.trim() === "") return;
    setState("saving");
    setError(null);
    const { error } = await getSupabase().rpc("set_package_price", {
      p_workspace_id: ws.id, p_space_kind: kind, p_year: year, p_month: month, p_half: half,
      p_days: days, p_price: value.trim() === "" ? null : n, p_expected_version: pkg?.version ?? null,
    });
    if (error) { setState("error"); setError(friendlyError(error)); return; }
    setState("saved");
    onSaved();
  }

  const hint = pct === null ? null : pct >= 0 ? <span className="text-xs text-ok">{pct.toLocaleString("es-AR")}% menos</span> : <span className="text-xs text-danger">{Math.abs(pct).toLocaleString("es-AR")}% más caro</span>;
  if (!editable) return <span className="tabular">{pkg ? <>{formatMoney(pkg.price)} {hint}</> : <span className="text-muted">—</span>}</span>;
  return (
    <span className="inline-flex flex-col">
      <Input inputMode="decimal" value={value} placeholder="—" title={normal ? `${days} días al precio normal: ${formatMoney(normal)}` : undefined}
        onChange={(e) => { setValue(e.target.value); setState("idle"); }}
        onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className={`tabular min-w-20 py-1 ${state === "error" ? "border-danger" : ""} ${!pkg && value === "" ? "opacity-70" : ""}`}
        aria-label={`Paquete ${days} días ${kind} ${MONTHS[month - 1]} ${year} quincena ${half}`} disabled={state === "saving"} />
      {hint}
      {state === "saved" && <span className="text-xs text-ok">Guardado</span>}
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}
