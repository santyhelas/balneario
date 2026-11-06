"use client";
// Verificación "no soy un robot" (Cloudflare Turnstile) para ingresar, recuperar la contraseña y abrir la demo.
// Se activa sola cuando está cargada la clave NEXT_PUBLIC_TURNSTILE_SITE_KEY en Vercel.
// Casi siempre es invisible; si Cloudflare necesita que toquen la casilla, aparece en el centro con un mensaje.

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
    // Casi siempre se resuelve sola y no se ve nada. Si Cloudflare pide tocar la casilla,
    // se muestra en el centro, con un mensaje, para que no pase desapercibida (sobre todo en el celular).
    const box = document.createElement("div");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Verificación");
    // Mientras no haga falta tocar nada, no se ve (el recuadro de Cloudflare queda vacío y sin fondo).
    box.style.cssText = "position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:16px;pointer-events:none";
    const card = document.createElement("div");
    card.style.cssText = "border-radius:16px;padding:18px 18px 14px;font:500 15px system-ui,sans-serif;text-align:center;max-width:340px";
    const msg = document.createElement("p");
    msg.textContent = "Tocá la casilla para confirmar que no sos un robot.";
    msg.style.cssText = "margin:0 0 12px;display:none";
    const slot = document.createElement("div");
    card.append(msg, slot);
    box.appendChild(card);
    document.body.appendChild(box);
    const show = () => {
      box.style.background = "rgba(15,30,40,.45)";
      box.style.pointerEvents = "auto";
      card.style.background = "#fff";
      card.style.color = "#16323f";
      card.style.boxShadow = "0 10px 40px rgba(0,0,0,.25)";
      msg.style.display = "block";
    };
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
    id = ts.render(slot, {
      sitekey: SITE_KEY,
      appearance: "interaction-only",
      "before-interactive-callback": show,
      language: "es",
      callback: (t: string) => finish(() => resolve(t)),
      "error-callback": fail,
      "expired-callback": fail,
      "timeout-callback": fail,
    });
  });
}
