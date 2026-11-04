// Piezas puras de la conexión con Google Drive (se pueden probar sin servidor).
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Clave de cifrado derivada de la clave secreta del servidor (no hace falta otra variable). */
export function deriveKey(secret: string, purpose: string): Buffer {
  return createHash("sha256").update(`${purpose}:${secret}`).digest();
}

/** Cifra un texto (AES-256-GCM). Resultado: base64 de iv | etiqueta | datos. */
export function encrypt(text: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}

export function decrypt(b64: string, key: Buffer): string | null {
  try {
    const raw = Buffer.from(b64, "base64");
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** "Sello" para el ida y vuelta con Google: evita que alguien conecte su Drive a un balneario ajeno. */
export function signState(payload: string, key: Buffer): string {
  const sig = createHmac("sha256", key).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

export function verifyState(state: string, key: Buffer): string | null {
  const [p, sig] = state.split(".");
  if (!p || !sig) return null;
  const payload = Buffer.from(p, "base64url").toString("utf8");
  const expected = createHmac("sha256", key).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? payload : null;
}

/** Cuerpo "multipart" para subir un archivo con su nombre y carpeta en una sola llamada. */
export function multipartBody(meta: object, content: string, boundary: string): string {
  return [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(meta),
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** Nombre del archivo de copia: copia_Nombre_2026-11-04_03-00.json (hora argentina). */
export function backupFileName(wsName: string, date: Date): string {
  const ar = new Date(date.getTime() - 3 * 3600_000).toISOString();
  const safe = wsName.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "balneario";
  return `copia_${safe}_${ar.slice(0, 10)}_${ar.slice(11, 13)}-${ar.slice(14, 16)}.json`;
}
