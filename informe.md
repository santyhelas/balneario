# Revisión de https://mibalneario.com.ar
Demo recorrida en: http://localhost:3000
Fecha: 2026-11-21T10:43:01.455Z

## Parte pública
- pc / → 200 (/) ✅
- pc /login → 200 (/login) ✅
- pc /terminos → 200 (/terminos) ✅
- pc /privacidad → 200 (/privacidad) ✅
- pc /mapa → 200 (/) ✅
- pc /caja → 200 (/) ✅
- pc /admin → 200 (/) ✅
- pc /dueno → 200 (/) ✅
- pc /presupuesto → 200 (/#planes) ✅
- pc /sistema-para-balnearios/mar-del-plata → 200 (/sistema-para-balnearios/mar-del-plata) ✅
- pc /no-existe-esta-pagina → 404 (/no-existe-esta-pagina) ⚠️
  - consola: Failed to load resource: the server responded with a status of 404 ()
  - pedido: 404 GET https://mibalneario.com.ar/no-existe-esta-pagina
- cel / → 200 (/) ✅
- cel /login → 200 (/login) ✅
- cel /terminos → 200 (/terminos) ✅
- cel /privacidad → 200 (/privacidad) ✅
- cel /mapa → 200 (/) ✅
- cel /caja → 200 (/) ✅
- cel /admin → 200 (/) ✅
- cel /dueno → 200 (/) ✅
- cel /presupuesto → 200 (/#planes) ✅
- cel /sistema-para-balnearios/mar-del-plata → 200 (/sistema-para-balnearios/mar-del-plata) ✅
- cel /no-existe-esta-pagina → 404 (/no-existe-esta-pagina) ⚠️
  - consola: Failed to load resource: the server responded with a status of 404 ()
  - pedido: 404 GET https://mibalneario.com.ar/no-existe-esta-pagina

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
- cel / → 200 (/) ⚠️
  - aviso: Atención: 3 clientes terminan hoy con deuda: Rodrigo Romero (84) $ 61.000 · Rocío Juárez (88) $ 58.000 · Federico Herrera (C8) $ 5.500
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
- Panel del dueño (pc): OK [sesión: ok → Cobros: ok → Interesados: ok → Gastos: ok → Renovación: ok → Instagram: ok → Precios: ok → soporte: no hay otro balneario para mirar → fichas: 1 → entra en la pantalla]
- Portada: animaciones al bajar: OK [elementos animados: 28 → escondidos al entrar: 28 → escondidos al llegar abajo: 0]
- Portada en modo oscuro (pc): OK []
- Casilla de Cloudflare en el ingreso: no apareció
- Ingreso con clave incorrecta: Usuario o contraseña incorrectos. | 
- Panel del dueño (cel): OK [sesión: ok → Cobros: ok → Interesados: ok → Gastos: ok → Renovación: ok → Instagram: ok → Precios: ok → soporte: no hay otro balneario para mirar → fichas: 1 → entra en la pantalla]
- Portada en modo oscuro (cel): OK []
- Casilla de Cloudflare en la demo: no apareció
- Entrar a la demo (pc): OK
- Extras: crear «Reposera» y agregarla a la reserva: OK [extra creado] · avisos: 
- Crear una reserva (cliente nuevo, 5 días, carpa libre, pagada): OK [cliente creado y elegido → carpa elegida → revisó → guardada]
- Caja: abrir (si está cerrada) y cargar un gasto en efectivo: OK [la caja ya estaba abierta] · avisos: 
- Límite de efectivo y depósito: OK [límite guardado → aviso visible] · avisos: 
- Vista de impresión (reportes y caja): captura tomada
- Agrandar el plano: OK []
- Plano: varias a la vez, mover y copiar/pegar: OK [elegidas para probar: Carpa 18 y Carpa 19 → Ctrl + clic: 2 elegidas (2 carpas o sombrillas, 0 elementos) → se movió la primera y la segunda junto con ella → Ctrl+C/V con carpas: 101 → 101 espacios → límite visible (o aviso de que no se puede achicar) → deshacer: volvió a su lugar]
- Mapa: ficha centrada, cambiar de lugar y traer a alguien: OK [pantalla completa → ventana centrada → cambiar de lugar: sí · girar fuera de edición: no está → destino ya elegido → cambio registrado]
- Tutorial de la demo (un día): OK [1. Un día en el balneario (sin resaltar) → 2. 8:00 · Mirás el día → 3. 8:10 · Abrís la caja → 4. 8:30 · El menú → 5. El mapa de la playa → 6. El clima en la playa → 7. 10:00 · Llega un cliente → 8. Elegís el lugar → 9. Precio y cobro → 10. 15:00 · Quién debe → 11. Cobros y deudas → 12. 20:00 · Cierre del día → 13. Cerrar la caja → 14. ¡Listo! Ahora probalo vos]
- Cocheras: carpa + cochera en la misma reserva: OK [cocheras en el mapa: 12 → cochera elegida: C2 → guardó la carpa y la cochera unidas → ofrece mandar la bienvenida por WhatsApp → disponibilidad: 12 cocheras → tarifario: columna de cocheras → tarifario: paquetes por quincena (7 días)]
- Nueva reserva: estadías largas (30 y 200 días): OK [30 días: 79 carpas en la grilla → 200 días: 79 carpas en la grilla]
- Reportes: ir a Comparar temporadas: OK []
- Menú: pestañas de cada sección: OK [/mapa: (sin pestañas) → /reservas: (sin pestañas) → /clientes: /clientes /renovacion → /caja: /caja /gastos → /reportes: (sin pestañas) → /configuracion: /configuracion /copias /historial]
- Tutorial de novedades: OK [1. Novedades de Mi Balneario (sin resaltar) → 2. Plano: varias cosas a la vez → 3. Cómo se eligen y se copian → 4. Cómo se combinan los descuentos → 5. Extras → 6. Límite de efectivo y tope de descuento → 7. Depósitos de caja → 8. Mensajes con más datos, y por mail → 9. Recordatorio por mail → 10. Contactar clientes → 11. Gastos en Excel → 12. Comparar temporadas → 13. Números de reserva propios → 14. ¡Eso es todo! (sin resaltar)]
- Ubicación: mapa para marcar el punto: OK [mosaicos cargados: 10 → ubicación: (-38.00523, -57.5444) → al marcar el punto, el mapa se cerró]
- Consultas: escribir la consulta: OK [texto: «Hola, esto es una prueba de consulta» → mail a mibalnearioarg]
- Panel: atajos F# y listas de a 5: OK [sin botones de accesos rápidos → F4 → mapa → F2 → nueva reserva → ítems por lista: 5, 5 → con páginas]
- Avisos: abrir apaga el número y se pueden eliminar: OK [antes: Avisos (7 nuevos) → avisos: 18 → 17 → después: Avisos]
- Configuración: ubicación del balneario: OK [búsqueda: 200 · 2 lugares → guardado → al recargar sigue Pinamar → nombre del punto: 200 {"nombre":"Centro, Mar del Plata, Buenos Aires"}]
- Configuración: apartados desplegables: OK [apartados: 4 → perfil abierto con «Tema»]
- Caja: cerrar y reabrir: OK [cerrada → reabierta]
- Casilla de Cloudflare en la demo: no apareció
- Entrar a la demo (cel): OK
- Ingreso: aviso tras 3 contraseñas incorrectas: OK [aviso visible]
- Bienvenida sin invitación válida: OK [¡Bienvenido a Mi Balneario! El enlace venció o ya fue usado. Pedí que te lo manden de nuevo. Ir a ingresar]

## API
- GET /api/clima → 401 {"error":"Tenés que iniciar sesión."}
- GET /api/cron/planes → 200 {"ok":false,"motivo":"sin configurar"}
- POST /api/mp/webhook → 503 {"ok":false,"motivo":"sin configurar"}
- POST /api/plan/suscribir → 401 {"error":"Tenés que iniciar sesión."}
- POST /api/plan/cancelar → 401 {"error":"Tenés que iniciar sesión."}
- GET /api/lugar?q=Pinamar → 401 {"error":"Tenés que iniciar sesión."}
- POST /auth/registrar → 403 {"error":"Por ahora no se pueden crear cuentas desde acá. Pedí tu presupuesto en la página principal o escribinos.","pla
- GET /robots.txt → 200 User-Agent: * Allow: / Allow: /inicio Disallow: /api/ Disallow: /auth/ Sitemap: https://mibalneario.com.ar/sitemap.xml 
- GET /sitemap.xml → 200 <?xml version="1.0" encoding="UTF-8"?> <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"> <url> <loc>https://m

## Cabeceras
- content-security-policy: frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
- strict-transport-security: max-age=63072000; includeSubDomains
- x-frame-options: DENY
- x-content-type-options: nosniff
- referrer-policy: strict-origin-when-cross-origin
- permissions-policy: camera=(), microphone=(), geolocation=(self), payment=(), usb=()

## Enlaces de la portada
- /#contenido → 200
- /#arriba → 200
- /#un-dia → 200
- /#funciones → 200
- /#planes → 200
- /#preguntas → 200
- /login → 200
- https://wa.me/5492645857461?text=%C2%A1Hola!%20Quiero%20un%20presupuesto%20del%20sistema%20Mi%20Balneario. → externo (no se prueba)
- https://www.instagram.com/mibalneario/ → externo (no se prueba)
- /guias → 200
- /quienes-somos → 200
- /sistema-para-balnearios/mar-del-plata → 200
- /sistema-para-balnearios/pinamar → 200
- /sistema-para-balnearios/villa-gesell → 200
- /sistema-para-balnearios/costa-atlantica → 200
- /sistema-para-balnearios/necochea → 200
- /sistema-para-balnearios/miramar → 200
- /sistema-para-balnearios/monte-hermoso → 200
- /sistema-para-balnearios/las-grutas → 200
- /terminos → 200
- /privacidad → 200