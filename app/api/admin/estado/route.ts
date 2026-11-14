import { getServerSupabase } from "@/lib/supabase/server";
import { json } from "@/lib/auth-server";
import { driveConfig } from "@/lib/drive";

export const dynamic = "force-dynamic";

type Check = { id: string; nombre: string; estado: "ok" | "aviso" | "error"; detalle: string };

async function timed(url: string, init?: RequestInit): Promise<{ ok: boolean; ms: number; status: number }> {
  const t = Date.now();
  try {
    const r = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(6000) });
    return { ok: r.ok, ms: Date.now() - t, status: r.status };
  } catch {
    return { ok: false, ms: Date.now() - t, status: 0 };
  }
}
async function txt(name: string, type = "TXT"): Promise<string[]> {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" }, cache: "no-store", signal: AbortSignal.timeout(5000) });
    const d = (await r.json()) as { Answer?: { data: string }[] };
    return (d.Answer ?? []).map((a) => a.data.replace(/"\s*"/g, "").replace(/^"|"$/g, ""));
  } catch {
    return [];
  }
}

/** Estado del sistema para el panel del dueño: servicios externos, configuración y correo. */
export async function GET() {
  const sb = await getServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user || user.is_anonymous) return json({ error: "Tu sesión venció. Volvé a ingresar." }, 401);
  const { data: isAdmin } = await sb.rpc("is_platform_admin");
  if (isAdmin !== true) return json({ error: "Solo para el dueño de Mi Balneario." }, 403);

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "https://mibalneario.com.ar";
  const domain = new URL(site).hostname.replace(/^www\./, "");
  const t0 = Date.now();
  const db = await sb.rpc("is_platform_admin");
  const dbMs = Date.now() - t0;
  const [metno, ow, dolar, dmarc, spfRoot, dkim, spfSend] = await Promise.all([
    timed("https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=-34.6&lon=-58.4", { headers: { "User-Agent": `MiBalneario/1.0 ${site}` } }),
    process.env.OPENWEATHER_API_KEY ? timed(`https://api.openweathermap.org/data/2.5/weather?lat=-34.6&lon=-58.4&appid=${encodeURIComponent(process.env.OPENWEATHER_API_KEY)}`) : Promise.resolve(null),
    timed("https://dolarapi.com/v1/dolares/oficial"),
    txt(`_dmarc.${domain}`),
    txt(domain),
    txt(`resend._domainkey.${domain}`),
    txt(`send.${domain}`),
  ]);

  const c: Check[] = [];
  c.push({ id: "base", nombre: "Base de datos", estado: db.error ? "error" : dbMs > 1500 ? "aviso" : "ok", detalle: db.error ? db.error.message : `responde en ${dbMs} ms` });
  c.push({ id: "clave", nombre: "Clave del servidor", estado: process.env.SUPABASE_SECRET_KEY ? "ok" : "error", detalle: process.env.SUPABASE_SECRET_KEY ? "configurada (crear usuarios, invitaciones, Drive)" : "falta SUPABASE_SECRET_KEY en Vercel" });
  c.push({ id: "clima", nombre: "Clima (met.no)", estado: metno.ok ? "ok" : "error", detalle: metno.ok ? `responde en ${metno.ms} ms` : `no responde (${metno.status || "sin conexión"})` });
  if (ow) c.push({ id: "openweather", nombre: "Clima (OpenWeather)", estado: ow.ok ? "ok" : "aviso", detalle: ow.ok ? `responde en ${ow.ms} ms` : `no responde (${ow.status || "sin conexión"})` });
  c.push({ id: "dolar", nombre: "Cotización del dólar", estado: dolar.ok ? "ok" : "aviso", detalle: dolar.ok ? `responde en ${dolar.ms} ms` : "no responde (se puede poner la cotización a mano)" });
  c.push({ id: "drive", nombre: "Google Drive (copias)", estado: driveConfig() ? "ok" : "aviso", detalle: driveConfig() ? "configurado" : "faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en Vercel" });
  const hasDmarc = dmarc.some((t) => t.toLowerCase().startsWith("v=dmarc1"));
  const hasDkim = dkim.some((t) => t.includes("p="));
  const hasSpf = [...spfRoot, ...spfSend].some((t) => t.toLowerCase().startsWith("v=spf1"));
  c.push({ id: "correo", nombre: `Correo (${domain})`, estado: hasDkim && hasSpf && hasDmarc ? "ok" : hasDkim ? "aviso" : "error",
    detalle: [`DKIM ${hasDkim ? "✓" : "falta"}`, `SPF ${hasSpf ? "✓" : "falta"}`, `DMARC ${hasDmarc ? "✓" : "falta (por eso puede caer en no deseado)"}`].join(" · ") });
  return json({ revisado: new Date().toISOString(), checks: c });
}
