import { GUIAS } from "@/lib/guias";
import { ZONAS_INDEXABLES } from "@/lib/zonas";
import { SITE_EMAIL, SITE_URL } from "@/lib/site";

// Resumen del sitio para asistentes de IA (formato llms.txt: https://llmstxt.org).
export const dynamic = "force-static";

export function GET() {
  const body = `# Mi Balneario

> Mi Balneario es un sistema de gestión web para balnearios de la costa argentina: reservas de carpas y sombrillas por fecha, mapa del balneario, señas, pagos y deudas, tarifas por quincena y por paquete de días, y caja diaria. Funciona desde la computadora o el celular, con los datos sincronizados entre dispositivos. Lo creó Santiago Helas, de San Juan, Argentina, que trabaja en el balneario Eólico de Villa Gesell, donde nació y se usa el sistema.

- Para quién: dueños y encargados de balnearios con carpas y/o sombrillas, en la costa atlántica argentina (Villa Gesell, Pinamar, Mar del Plata, Partido de la Costa y otras zonas).
- Precio: se cotiza según el tamaño del balneario (cantidad de carpas y sombrillas). Presupuesto por WhatsApp al +54 9 264 585-7461 o por mail a ${SITE_EMAIL}.
- Demo: hay una demo gratuita con un balneario de prueba y datos inventados, sin registrarse, en ${SITE_URL}/
- Idioma: español (Argentina). Moneda: pesos argentinos.

## Qué hace

- Mapa del balneario con mar, arena, carpas y sombrillas; se arma arrastrando con el mouse.
- Disponibilidad por fecha: muestra qué carpas están libres todos los días pedidos y propone alternativas si una carpa está ocupada solo algunos días.
- Una reserva puede tener varios tramos en distintas carpas sin dejar de ser una sola reserva; cambios de carpa por un día o por el resto de la estadía.
- Cobros en efectivo, transferencia y tarjeta; señas, pagos parciales y saldo exacto; precio distinto pagando en efectivo.
- Tarifario por mes y quincena (del 1 al 15 y del 16 a fin de mes), paquetes de 7, 10, 15 o 30 días, convenios, descuentos con motivo y cortesías.
- Caja diaria: apertura, gastos, cierre con efectivo esperado y diferencia.
- Avisos de clientes que entran o se van con deuda, mensajes de WhatsApp listos para mandar, comprobantes, informes y copias de seguridad.
- Varios usuarios (dueño y empleados) con la misma información al instante.

## Páginas principales

- [Inicio](${SITE_URL}/): qué es Mi Balneario, cómo se usa en un día de temporada, funciones y preguntas frecuentes.
${ZONAS_INDEXABLES.map((z) => `- [Sistema para balnearios ${z.donde}](${SITE_URL}/sistema-para-balnearios/${z.slug})`).join("\n")}
- [Quiénes somos](${SITE_URL}/quienes-somos)

## Guías

${GUIAS.map((g) => `- [${g.titulo}](${SITE_URL}/guias/${g.slug}): ${g.resumen}`).join("\n")}
`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
