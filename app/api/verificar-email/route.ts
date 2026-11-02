import { resolveMx, resolve4 } from "node:dns/promises";
import { json } from "@/lib/auth-server";
import { EMAIL_RE } from "@/lib/email";

export const runtime = "nodejs";

// Comprueba que el dominio del correo exista y pueda recibir mensajes (registros MX).
// No se envía ningún correo ni se consulta el buzón: eso no se puede verificar sin escribirle.
export async function GET(req: Request) {
  const email = new URL(req.url).searchParams.get("email")?.trim() ?? "";
  if (!EMAIL_RE.test(email) || email.length > 150) return json({ ok: false, reason: "formato" });
  const domain = email.split("@")[1].toLowerCase();
  try {
    const mx = await resolveMx(domain);
    if (mx.some((r) => r.exchange && r.exchange !== ".")) return json({ ok: true });
    return json({ ok: false, reason: "sin_correo", domain });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      // Algunos dominios reciben correo sin MX (usan su dirección principal).
      try {
        if ((await resolve4(domain)).length) return json({ ok: true });
      } catch { /* sigue */ }
      return json({ ok: false, reason: "no_existe", domain });
    }
    return json({ ok: null, reason: "no_verificado" });
  }
}
