// Página mínima que carga el widget oficial de Windguru.
// Se muestra dentro de un iframe aislado (sandbox sin acceso al origen): el código de Windguru
// no puede leer la sesión ni los datos del sistema. Avisa a la página principal si cargó, su alto y errores.

const SAFE_PARAM = /^[a-z]+=[A-Za-z0-9,._%-]+$/i;

export function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("p") ?? "";
  const kv = raw.split("&").filter((p) => SAFE_PARAM.test(p) && !p.startsWith("uid="));
  const spot = kv.find((p) => p.startsWith("s="))?.slice(2);
  if (!spot || !/^\d{2,9}$/.test(spot)) {
    return new Response("Spot de Windguru inválido.", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const model = kv.find((p) => p.startsWith("m="))?.slice(2) ?? "3";
  const uid = `wg_fwdg_${spot}_${model}_${Date.now()}`;
  const args = JSON.stringify([...kv, `uid=${uid}`]);

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<title>Windguru</title>
<style>html,body{margin:0;padding:0;width:100%;background:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
#wg-status{padding:16px;color:#56666f;font-size:14px}#wg-status.err{color:#b42318}#wg-status ul{margin:6px 0 0;padding-left:18px;font-size:12px}</style>
<script>
(function () {
  // En un recuadro aislado el navegador bloquea el almacenamiento: se reemplaza por uno en memoria
  // para que el widget no falle (no guarda nada del sistema).
  function mem() { var d = {}; return { getItem: function (k) { return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; }, setItem: function (k, v) { d[k] = String(v); }, removeItem: function (k) { delete d[k]; }, clear: function () { d = {}; }, key: function (i) { return Object.keys(d)[i] || null; }, get length() { return Object.keys(d).length; } }; }
  ["localStorage", "sessionStorage"].forEach(function (n) { try { window[n].getItem("x"); } catch (e) { try { Object.defineProperty(window, n, { value: mem(), configurable: true }); } catch (_) {} } });
  try { void document.cookie; } catch (e) { try { var c = ""; Object.defineProperty(document, "cookie", { get: function () { return c; }, set: function () {}, configurable: true }); } catch (_) {} }

  var log = [];
  function show(msg, isErr) {
    var el = document.getElementById("wg-status");
    if (!el) return;
    if (isErr) { el.className = "err"; log.push(msg); el.innerHTML = "No se pudo mostrar el pronóstico de Windguru:<ul>" + log.map(function (l) { return "<li>" + String(l).replace(/[<>&]/g, "") + "</li>"; }).join("") + "</ul>"; }
    else if (!log.length) el.textContent = msg;
  }
  function send(type, detail) {
    try { parent.postMessage({ wg: type, detail: detail == null ? "" : String(detail) }, "*"); } catch (_) {}
    if (type === "error") show(detail, true);
    if (type === "timeout") show("Windguru no respondió en 12 segundos (" + location.hostname + ", aislado: " + (self.origin === "null" ? "sí" : "no") + ").", true);
  }
  window.addEventListener("error", function (e) {
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) { send("error", "No cargó el recurso " + String(t.src || t.href).split("?")[0]); return; }
    send("error", (e.message || "Error") + (e.filename ? " (" + e.filename.split("?")[0] + ":" + e.lineno + ")" : ""));
  }, true);
  window.addEventListener("unhandledrejection", function (e) { send("error", "Promesa rechazada: " + (e.reason && e.reason.message || e.reason)); });
  var _fetch = window.fetch;
  if (_fetch) window.fetch = function () { return _fetch.apply(this, arguments).catch(function (err) { send("error", "Consulta bloqueada: " + (arguments[0] && arguments[0].url || "") + " " + err); throw err; }); };
  var done = false;
  function check() {
    var h = document.documentElement.scrollHeight;
    send("height", h);
    if (!done && document.body && document.body.querySelectorAll("table, canvas").length > 0) { done = true; send("ok"); var st = document.getElementById("wg-status"); if (st) st.remove(); }
  }
  setInterval(check, 1000);
  setTimeout(function () { if (!done) send("timeout"); }, 12000);
})();
</script>
</head>
<body>
<div id="wg-status">Cargando el pronóstico de Windguru (spot ${spot})…</div>
<script id="${uid}">
(function () {
  var arg = ${args};
  var s = document.createElement("script");
  s.src = "https://www.windguru.cz/js/widget.php?" + arg.join("&");
  s.onerror = function () { parent.postMessage({ wg: "error", detail: "No se pudo descargar el widget de windguru.cz" }, "*"); var el = document.getElementById("wg-status"); if (el) { el.className = "err"; el.textContent = "No se pudo descargar el widget de windguru.cz (¿bloqueado por el navegador o un bloqueador de anuncios?)."; } };
  s.onload = function () { var el = document.getElementById("wg-status"); if (el && el.className !== "err") el.textContent = "Widget descargado, esperando la tabla…"; };
  var t = document.getElementsByTagName("script")[0];
  t.parentNode.insertBefore(s, t);
})();
</script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      // Solo se puede mostrar dentro del propio sistema.
      "Content-Security-Policy": "frame-ancestors 'self'",
    },
  });
}
