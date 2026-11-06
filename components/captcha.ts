"use client";
// Verificación "no soy un robot" (Cloudflare Turnstile) para ingresar, recuperar la contraseña y abrir la demo.
// Se activa sola cuando está cargada la clave NEXT_PUBLIC_TURNSTILE_SITE_KEY en Vercel.
// Casi siempre es invisible; solo aparece un recuadro abajo si Cloudflare necesita comprobar algo.

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
export const CAPTCHA_ON = SITE_KEY.length > 0;

type Turnstile = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global { interface Window { turnstile?: Turnstile } }

let loading: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => res();
    s.onerror = () => { loading = null; rej(new Error("No se pudo cargar la verificación. Revisá la conexión y probá de nuevo.")); };
    document.head.appendChild(s);
  });
  return loading;
}

/** Pide un comprobante de un solo uso. Sin clave configurada devuelve undefined (no hace nada). */
export async function captchaToken(): Promise<string | undefined> {
  if (!CAPTCHA_ON) return undefined;
  await loadScript();
  const ts = window.turnstile!;
  return new Promise<string>((resolve, reject) => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:200";
    document.body.appendChild(box);
    let id = "";
    let finished = false;
    const finish = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { if (id) ts.remove(id); } catch { /* ya no está */ }
      box.remove();
      fn();
    };
    const fail = () => finish(() => reject(new Error("No se pudo verificar que no sos un robot. Probá de nuevo.")));
    const timer = setTimeout(fail, 90_000);
    id = ts.render(box, {
      sitekey: SITE_KEY,
      appearance: "interaction-only",
      language: "es",
      callback: (t: string) => finish(() => resolve(t)),
      "error-callback": fail,
      "expired-callback": fail,
      "timeout-callback": fail,
    });
  });
}
