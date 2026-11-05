# Tu Balneario — sistema de gestión de balnearios

Aplicación web para administrar carpas, sombrillas, reservas, pagos, caja y gastos.

## Arquitectura

- **Base de datos:** PostgreSQL en Supabase. Es la única fuente de información.
- **Reglas críticas dentro de la base:** superposición de reservas, pagos sin duplicar, caja, permisos e historial. No dependen de la pantalla, así que valen igual desde cualquier dispositivo.
- **Frontend:** Next.js + TypeScript + Tailwind (siguiente etapa), publicado en Vercel.
- **Autenticación:** Supabase Auth con Google.

## Instalación y ejecución

1. Base de datos: en Supabase → SQL Editor, pegar y ejecutar `supabase/instalar.sql` (una sola vez).
   Las migraciones nuevas se agregan en `supabase/migrations/` y se aplican en orden.
2. Variables: copiar `.env.example` a `.env.local` con la URL y la clave pública (publishable) del proyecto.
3. `npm install` y `npm run dev` → http://localhost:3000
4. Publicación: Vercel importa este repositorio; cargar las dos variables en Settings → Environment Variables.

Entornos: usar un proyecto de Supabase distinto para pruebas y otro para producción, para no mezclar
datos de prueba con datos reales. La verificación automática (GitHub Actions) usa una base temporal propia.

## Estructura

```
supabase/
  migrations/      Migraciones numeradas (fuente de verdad del esquema)
  instalar.sql     Todas las migraciones juntas, para pegar en Supabase la primera vez
  actualizaciones/ Cambios para pegar en una base ya instalada
  tests/           Pruebas automáticas de la base
```

## Decisiones de diseño

| Tema | Cómo se resuelve |
|---|---|
| Reservas superpuestas | Restricción de exclusión `segments_no_double_booking` + bloqueo por espacio. Probado con dos sesiones simultáneas. |
| Varias carpas en una estadía | `reservations` (1) → `reservation_segments` (N). Los tramos deben cubrir la estadía sin huecos. |
| Cambios de carpa | Los tramos nunca se editan: se finalizan y se crean nuevos, vinculados a un `reservation_changes`. |
| Deshacer / revertir | `revert_change` restaura el estado anterior solo si es seguro; nunca borra el evento original. |
| Pagos | Inmutables. Correcciones con `anulacion`; devoluciones con `devolucion`. Clave de idempotencia para evitar duplicados. |
| Saldo | Vista `reservation_balances`, calculada con los pagos reales. |
| Caja | Una sola caja abierta por vez; el efectivo esperado solo cuenta movimientos en efectivo. |
| Edición desde dos dispositivos | Columna `version`: toda modificación debe enviar `version + 1`; si otro la cambió antes, se rechaza. |
| Permisos | RLS en todas las tablas. Roles: propietario, administrador, operador. Sin acceso anónimo. |
| Precios | Se guarda una fotografía (`reservation_charges`, `reservation_discounts`); cambiar tarifas no altera reservas pasadas. |

## Pendiente de definir con el administrador

1. **Cálculo de tarifas:** si cada quincena tiene un precio por día o precios por paquete (5, 7, 15, 30 días).
2. **Combinación de descuentos:** si se pueden sumar (por ejemplo, efectivo 10% y Parque Bonito 30%) y en qué orden.
3. **Dinero de una reserva cancelada:** por ahora queda como saldo a favor hasta registrar una devolución.
4. **Cobros con la caja cerrada:** por ahora todo cobro o gasto requiere la caja del día abierta.
5. **Cliente frecuente:** criterio provisorio en pantalla (3+ alquileres o 2+ temporadas).
6. **Caja anterior sin cerrar:** por ahora hay que cerrarla antes de abrir la del día.

## Respaldo (pendiente de implementar en la aplicación)

Mientras tanto: Supabase → Database → Backups (plan pago) o exportar con `pg_dump` usando la cadena de
conexión del proyecto. Nunca guardar la contraseña de la base en el repositorio.

## Pruebas locales

```bash
./supabase/tests/run.sh   # requiere PostgreSQL 15+ local
```
