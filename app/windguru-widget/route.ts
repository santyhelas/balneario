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
<style>html,body{margin:0;padding:0;width:100%;background:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}</style>
<script>
(function () {
  // En un recuadro aislado el navegador bloquea el almacenamiento: se reemplaza por uno en memoria
  // para que el widget no falle (no guarda nada del sistema).
  function mem() { var d = {}; return { getItem: function (k) { return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; }, setItem: function (k, v) { d[k] = String(v); }, removeItem: function (k) { delete d[k]; }, clear: function () { d = {}; }, key: function (i) { return Object.keys(d)[i] || null; }, get length() { return Object.keys(d).length; } }; }
  ["localStorage", "sessionStorage"].forEach(function (n) { try { window[n].getItem("x"); } catch (e) { try { Object.defineProperty(window, n, { value: mem(), configurable: true }); } catch (_) {} } });
  try { void document.cookie; } catch (e) { try { var c = ""; Object.defineProperty(document, "cookie", { get: function () { return c; }, set: function () {}, configurable: true }); } catch (_) {} }

  function send(type, detail) { try { parent.postMessage({ wg: type, detail: detail == null ? "" : String(detail) }, "*"); } catch (_) {} }
  window.addEventListener("error", function (e) { send("error", (e.message || "Error") + (e.filename ? " (" + e.filename.split("?")[0] + ")" : "")); }, true);
  var done = false;
  function check() {
    var h = document.documentElement.scrollHeight;
    send("height", h);
    if (!done && document.body && document.body.querySelectorAll("table, canvas").length > 0) { done = true; send("ok"); }
  }
  setInterval(check, 1000);
  setTimeout(function () { if (!done) send("timeout"); }, 12000);
})();
</script>
</head>
<body>
<script id="${uid}">
(function () {
  var arg = ${args};
  var s = document.createElement("script");
  s.src = "https://www.windguru.cz/js/widget.php?" + arg.join("&");
  s.onerror = function () { parent.postMessage({ wg: "error", detail: "No se pudo descargar el widget de windguru.cz" }, "*"); };
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
