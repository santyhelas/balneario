# Revisión de https://balneario-beta.vercel.app
Demo recorrida en: http://localhost:3000
Fecha: 2026-11-07T16:18:24.898Z

## Parte pública
- pc / → 200 (/) ✅
- pc /login → 200 (/login) ✅
- pc /terminos → 200 (/terminos) ✅
- pc /privacidad → 200 (/privacidad) ✅
- pc /mapa → 200 (/) ✅
- pc /caja → 200 (/) ✅
- pc /admin → 200 (/) ✅
- pc /no-existe-esta-pagina → 200 (/) ✅
- cel / → 200 (/) ✅
- cel /login → 200 (/login) ✅
- cel /terminos → 200 (/terminos) ✅
- cel /privacidad → 200 (/privacidad) ✅
- cel /mapa → 200 (/) ✅
- cel /caja → 200 (/) ✅
- cel /admin → 200 (/) ✅
- cel /no-existe-esta-pagina → 200 (/) ✅

## Demo
- pc / → 200 (/) ✅
- pc /mapa → 200 (/mapa) ✅
- pc /disponibilidad → 200 (/disponibilidad) ✅
- pc /reservas → 200 (/reservas) ✅
- pc /reservas/nueva → 200 (/reservas/nueva) ✅
- pc /tarifas → 200 (/tarifas) ✅
- pc /convenios → 200 (/convenios) ✅
- pc /clientes → 200 (/clientes) ✅
- pc /renovacion → 200 (/renovacion) ✅
- pc /cobros → 200 (/cobros) ✅
- pc /caja → 200 (/caja) ✅
- pc /caja/tarjetas → 200 (/caja/tarjetas) ✅
- pc /gastos → 200 (/gastos) ✅
- pc /reportes → 200 (/reportes) ✅
- pc /historial → 200 (/historial) ✅
- pc /copias → 200 (/copias) ✅
- pc /configuracion → 200 (/configuracion) ✅
- cel / → 200 (/) ✅
- cel /mapa → 200 (/mapa) ✅
- cel /disponibilidad → 200 (/disponibilidad) ✅
- cel /reservas → 200 (/reservas) ✅
- cel /reservas/nueva → 200 (/reservas/nueva) ✅
- cel /tarifas → 200 (/tarifas) ✅
- cel /convenios → 200 (/convenios) ✅
- cel /clientes → 200 (/clientes) ✅
- cel /renovacion → 200 (/renovacion) ✅
- cel /cobros → 200 (/cobros) ✅
- cel /caja → 200 (/caja) ✅
- cel /caja/tarjetas → 200 (/caja/tarjetas) ✅
- cel /gastos → 200 (/gastos) ✅
- cel /reportes → 200 (/reportes) ✅
- cel /historial → 200 (/historial) ✅
- cel /copias → 200 (/copias) ✅
- cel /configuracion → 200 (/configuracion) ✅

## Flujos
- Portada: animaciones al bajar: OK [elementos animados: 20 → escondidos al entrar: 20 → escondidos al llegar abajo: 0]
- Portada en modo oscuro (pc): OK []
- Casilla de Cloudflare en el ingreso: no apareció
- Ingreso con clave incorrecta: Usuario o contraseña incorrectos. | 
- Portada en modo oscuro (cel): OK []
- Casilla de Cloudflare en la demo: no apareció
- Entrar a la demo (pc): OK
- Extras: crear «Reposera» y agregarla a la reserva: OK [extra creado] · avisos: 
- Crear una reserva (cliente nuevo, 5 días, carpa libre, pagada): OK [cliente creado y elegido → carpa elegida → revisó → guardada]
- Caja: abrir (si está cerrada) y cargar un gasto en efectivo: OK [la caja ya estaba abierta] · avisos: 
- Límite de efectivo y depósito: OK [límite guardado → aviso visible] · avisos: 
- Vista de impresión (reportes y caja): captura tomada
- Agrandar el plano: OK []
- Plano: varias a la vez, mover y copiar/pegar: OK [recuadro: 2 elegidas (2 carpas o sombrillas, 0 elementos) → se movió la primera y la segunda junto con ella → pegar: 36 → 38 espacios]
- Tutorial de novedades: OK [1. Novedades de Mi Balneario (sin resaltar) → 2. Plano: varias cosas a la vez → 3. Cómo se eligen y se copian → 4. Cómo se combinan los descuentos → 5. Extras → 6. Límite de efectivo y tope de descuento → 7. Depósitos de caja → 8. Mensajes con más datos, y por mail → 9. Recordatorio por mail → 10. Contactar clientes → 11. Gastos en Excel → 12. Comparar temporadas → 13. Números de reserva propios → 14. ¡Eso es todo! (sin resaltar)]
- Ubicación: mapa para marcar el punto: OK [mosaicos cargados: 6 → ubicación: (-37.25957, -56.99347)]
- Casilla de Cloudflare en la demo: no apareció
- Entrar a la demo (cel): OK

## API
- GET /api/clima → 401 {"error":"Tenés que iniciar sesión."}
- GET /api/cron/planes → 200 {"ok":false,"motivo":"sin configurar"}
- POST /api/mp/webhook → 503 {"ok":false,"motivo":"sin configurar"}
- POST /api/plan/suscribir → 401 {"error":"Tenés que iniciar sesión."}
- POST /api/plan/cancelar → 401 {"error":"Tenés que iniciar sesión."}
- GET /api/lugar?q=Pinamar → 401 {"error":"Tenés que iniciar sesión."}
- POST /auth/registrar → 403 {"error":"Por ahora no se pueden crear cuentas desde acá. Pedí tu presupuesto en la página principal o escribinos.","pla
- GET /robots.txt → 200 User-Agent: * Allow: / Allow: /inicio Disallow: /api/ Disallow: /auth/ Sitemap: https://balneario-beta.vercel.app/sitema
- GET /sitemap.xml → 200 <?xml version="1.0" encoding="UTF-8"?> <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"> <url> <loc>https://b

## Cabeceras
- content-security-policy: frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
- strict-transport-security: max-age=63072000; includeSubDomains
- x-frame-options: DENY
- x-content-type-options: nosniff
- referrer-policy: strict-origin-when-cross-origin
- permissions-policy: camera=(), microphone=(), geolocation=(self), payment=(), usb=()

## Enlaces de la portada
- /#arriba → 200
- /#un-dia → 200
- /#funciones → 200
- /#planes → 200
- /#preguntas → 200
- /login → 200
- https://wa.me/5492645857461?text=%C2%A1Hola!%20Quiero%20un%20presupuesto%20del%20sistema%20Mi%20Balneario. → externo (no se prueba)
- https://www.instagram.com/mibalneario/ → externo (no se prueba)
- /terminos → 200
- /privacidad → 200