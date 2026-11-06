// Service worker mínimo.
// NO guarda datos del balneario: reservas, pagos y caja siempre se piden al servidor,
// para no mostrar información vieja como si fuera la actual.
// Solo guarda los íconos y la pantalla de "sin conexión".
const CACHE = "balneario-v5";
const STATIC = ["/offline.html", "/logo.png", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase y otros: siempre directo a la red

  // Navegación: red; si no hay conexión, aviso claro.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
    return;
  }
  // Íconos propios: de la caché si están.
  if (STATIC.includes(url.pathname)) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req)));
  }
});
