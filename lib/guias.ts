// Guías públicas para dueños y encargados de balnearios (páginas /guias/[slug]).
// Contenido propio, sin datos inventados: los números que aparecen son ejemplos y lo dicen.
// Al cambiar una guía, actualizá «actualizado» (lo usan la página, el mapa del sitio y Google).

export type Bloque =
  | { t: "p"; texto: string }
  | { t: "lista"; items: string[]; ordenada?: boolean }
  | { t: "tabla"; cabecera: string[]; filas: string[][]; nota?: string };

export type Seccion = { titulo: string; bloques: Bloque[] };

export type Guia = {
  slug: string;
  titulo: string;
  /** Una o dos frases: se usan como descripción para Google y como resumen arriba de la guía. */
  resumen: string;
  actualizado: string; // AAAA-MM-DD
  secciones: Seccion[];
  preguntas: { q: string; a: string }[];
};

export const GUIAS_AUTOR = "Santiago Helas";

export const GUIAS: Guia[] = [
  {
    slug: "como-organizar-reservas-de-carpas",
    titulo: "Cómo organizar las reservas de carpas y sombrillas de un balneario",
    resumen:
      "Para organizar las reservas de un balneario hay que mirar la disponibilidad día por día, no carpa por carpa: una carpa puede estar libre hoy y ocupada desde el sábado. Esta guía explica cómo llevarlo sin superponer reservas, con cuaderno, planilla o sistema.",
    actualizado: "2026-11-20",
    secciones: [
      {
        titulo: "La regla de oro: la disponibilidad es por día",
        bloques: [
          { t: "p", texto: "El error más común es pensar en cada carpa como «libre» u «ocupada». En la práctica, una carpa puede estar libre del 1 al 3 de enero y reservada desde el 4. Si alguien pide la carpa del 1 al 5, la respuesta no es «no», sino «del 1 al 3 sí, y del 4 al 5 te ofrezco otra»." },
          { t: "p", texto: "Por eso la pregunta que hay que poder contestar rápido es: para estas fechas, ¿qué carpas están libres todos los días? Las fechas cuentan completas: el día que llega y el día que se va están ocupados." },
        ],
      },
      {
        titulo: "Qué anotar en cada reserva",
        bloques: [
          { t: "lista", items: [
            "Cliente: nombre, apellido y teléfono. No hace falta el DNI.",
            "Fecha de entrada y fecha de salida (las dos inclusive).",
            "Carpa o sombrilla asignada y, si hay cambio en el medio, desde qué día pasa a otra.",
            "Precio total acordado, con el descuento aplicado y el motivo.",
            "Lo que pagó: cuánto, cuándo y cómo (efectivo, transferencia o tarjeta).",
            "Saldo pendiente.",
          ] },
          { t: "p", texto: "Si una de estas cosas falta, más adelante aparece el problema: dos personas con la misma carpa, un cliente que dice que ya pagó, o una seña que nadie recuerda." },
        ],
      },
      {
        titulo: "Paso a paso para tomar una reserva sin errores",
        bloques: [
          { t: "lista", ordenada: true, items: [
            "Preguntá las fechas exactas de entrada y salida.",
            "Revisá qué carpas están libres todos esos días, no solo el primero.",
            "Si la carpa que quiere tiene días ocupados, ofrecé otra para esos días y dejalo por escrito.",
            "Calculá el precio con la tarifa de cada día (si la estadía cruza de una quincena a otra, cada tramo va con su precio).",
            "Anotá lo que paga en el momento: todo, una seña o nada.",
            "Mandale al cliente un resumen por WhatsApp con fechas, carpa, total y saldo.",
          ] },
        ],
      },
      {
        titulo: "Cambios de carpa en medio de la estadía",
        bloques: [
          { t: "p", texto: "Hay dos tipos de cambio y conviene tratarlos distinto. Por un solo día: el cliente pasa a otra carpa mañana y al día siguiente vuelve a la suya. Por el resto de la estadía: se muda desde una fecha hasta el final. En los dos casos sigue siendo la misma reserva, con los mismos pagos: no hay que crear otra ni mover plata." },
        ],
      },
      {
        titulo: "Cuaderno, planilla o sistema",
        bloques: [
          { t: "p", texto: "Con pocas carpas y una sola persona anotando, un cuaderno puede alcanzar. El problema aparece cuando anotan dos o más personas, cuando hay estadías largas que se cruzan, o cuando hay que saber al instante quién debe plata. Ahí conviene un sistema que no deje reservar dos veces la misma carpa y que calcule los saldos solo. Lo comparamos en detalle en la guía «Cuaderno, Excel o sistema para un balneario»." },
        ],
      },
    ],
    preguntas: [
      { q: "¿El día de salida cuenta como ocupado?", a: "Sí. En los balnearios la carpa se usa el día que el cliente llega y también el día que se va, así que las dos fechas cuentan como ocupadas." },
      { q: "¿Qué hago si la carpa que quiere el cliente está ocupada solo algunos días?", a: "No hace falta rechazar la reserva: ofrecé la carpa para los días libres y otra carpa para los días ocupados, dentro de la misma reserva." },
      { q: "¿Hace falta pedir el DNI para reservar?", a: "No. Con nombre, apellido y teléfono alcanza para identificar al cliente y contactarlo." },
    ],
  },
  {
    slug: "cuaderno-excel-o-sistema-para-balneario",
    titulo: "Cuaderno, Excel o sistema: cómo llevar un balneario",
    resumen:
      "El cuaderno y la planilla de Excel sirven para empezar, pero no avisan cuando una carpa ya está reservada ni separan lo cobrado de lo adeudado. Un sistema de gestión hace esos controles solo. Esta comparación ayuda a decidir qué conviene según el tamaño del balneario.",
    actualizado: "2026-11-20",
    secciones: [
      {
        titulo: "Comparación rápida",
        bloques: [
          { t: "tabla", cabecera: ["", "Cuaderno", "Planilla (Excel)", "Sistema de gestión"], filas: [
            ["Evita reservar dos veces la misma carpa", "No", "Solo si alguien lo revisa", "Sí, lo bloquea"],
            ["Disponibilidad por fecha", "Hojeando páginas", "Con fórmulas o filtros", "Al instante, en un mapa"],
            ["Señas y saldos", "A mano", "Con fórmulas que se rompen", "Calculados con cada pago"],
            ["Varias personas a la vez", "Un solo cuaderno", "Se pisan los cambios", "Todos ven lo mismo"],
            ["Desde el celular", "No", "Incómodo", "Sí"],
            ["Historial de cambios", "Tachones", "Se pierde", "Queda registrado"],
            ["Costo", "Casi nada", "Casi nada", "Abono por temporada"],
          ] },
        ],
      },
      {
        titulo: "Cuándo alcanza con el cuaderno",
        bloques: [
          { t: "p", texto: "Un balneario chico, con una sola persona tomando reservas y pocas estadías largas, puede funcionar con cuaderno. La condición es que siempre lo lleve la misma persona y que la caja se cuente todos los días." },
        ],
      },
      {
        titulo: "Los problemas de la planilla",
        bloques: [
          { t: "p", texto: "La planilla parece el paso natural, pero tiene trampas: una fórmula borrada sin querer cambia todos los saldos, dos personas editando a la vez se pisan, y nada impide escribir dos nombres en la misma carpa el mismo día. Además, para ver qué está libre en otra fecha hay que armar vistas a mano." },
        ],
      },
      {
        titulo: "Cuándo conviene un sistema",
        bloques: [
          { t: "lista", items: [
            "Cuando reservan o cobran dos o más personas.",
            "Cuando hay estadías de 15 o 30 días que se cruzan entre sí.",
            "Cuando cobrás con varios medios (efectivo, transferencia, tarjeta) y la caja no te cierra.",
            "Cuando querés saber al instante quién te debe y cuánto.",
            "Cuando querés responder por WhatsApp sin estar en el balneario.",
          ] },
          { t: "p", texto: "Mi Balneario es un sistema pensado para esto: mapa de carpas y sombrillas, reservas por fecha, señas y deudas, caja diaria y tarifas por quincena. Tiene una demo gratuita con datos inventados para probarlo sin registrarse." },
        ],
      },
    ],
    preguntas: [
      { q: "¿Puedo pasar mis reservas del cuaderno a un sistema en plena temporada?", a: "Sí. Lo más práctico es cargar primero las reservas futuras y las que tienen saldo pendiente; el resto se puede cargar después." },
      { q: "¿Un sistema reemplaza contar la caja?", a: "No. El sistema calcula cuánto efectivo debería haber; contar la plata al cierre sigue siendo necesario para detectar diferencias." },
    ],
  },
  {
    slug: "precio-de-carpas-por-quincena",
    titulo: "Cómo armar el tarifario de carpas por quincena y por paquete de días",
    resumen:
      "La mayoría de los balnearios cobra por día, por paquetes (7, 10, 15 o 30 días) y por quincena, con precios distintos en enero y febrero. Esta guía explica cómo armar el tarifario y cómo calcular una estadía que cruza de una quincena a otra.",
    actualizado: "2026-11-20",
    secciones: [
      {
        titulo: "Las tres formas de cobrar",
        bloques: [
          { t: "lista", items: [
            "Por día: el precio base, para quien viene uno o pocos días.",
            "Por paquete de días: un precio fijo para 7, 10, 15 o 30 días, más barato que sumar los días sueltos.",
            "Por quincena o temporada: del 1 al 15, del 16 al último día del mes, el mes entero o toda la temporada.",
          ] },
          { t: "p", texto: "Las quincenas se cortan siempre igual: del día 1 al 15 y del 16 hasta el último día del mes (28, 29, 30 o 31)." },
        ],
      },
      {
        titulo: "Ejemplo de tarifario",
        bloques: [
          { t: "tabla", cabecera: ["Concepto", "Enero", "Febrero"], filas: [
            ["Día, primera quincena", "$50.000", "$48.000"],
            ["Día, segunda quincena", "$55.000", "$45.000"],
            ["Paquete 7 días", "$300.000", "$270.000"],
            ["Primera quincena", "$600.000", "$560.000"],
            ["Segunda quincena", "$640.000", "$520.000"],
          ], nota: "Precios de ejemplo para mostrar la estructura; no son precios reales de ningún balneario." },
          { t: "p", texto: "Las sombrillas suelen cobrarse con la misma estructura y un porcentaje menos que la carpa." },
        ],
      },
      {
        titulo: "Estadías que cruzan dos quincenas",
        bloques: [
          { t: "p", texto: "Si alguien viene del 13 al 18 de enero, la estadía tiene 3 días en la primera quincena (13, 14 y 15) y 3 en la segunda (16, 17 y 18). Lo correcto es calcular cada tramo con el precio de su quincena y sumar. Con el tarifario de ejemplo: 3 × $50.000 + 3 × $55.000 = $315.000." },
          { t: "p", texto: "Si la estadía alcanza un paquete (por ejemplo, 7 días), se aplica el paquete desde el día de llegada y los días que sobran se cobran a la tarifa normal." },
        ],
      },
      {
        titulo: "Descuentos y precio en efectivo",
        bloques: [
          { t: "p", texto: "Muchos balnearios tienen un precio menor pagando en efectivo. Conviene definir si es un porcentaje o una diferencia fija, y aplicarlo solo cuando el pago en efectivo cancela el total. Los descuentos manuales (convenios, clientes de muchos años) conviene anotarlos siempre con el motivo, para que después cierre la cuenta." },
        ],
      },
      {
        titulo: "Guardar el precio de cada reserva",
        bloques: [
          { t: "p", texto: "Si cambiás el tarifario a mitad de temporada, las reservas ya hechas tienen que mantener el precio que se acordó. Por eso el total de cada reserva se guarda en el momento de hacerla y no se recalcula después." },
        ],
      },
    ],
    preguntas: [
      { q: "¿Cómo se cobran los días que sobran de un paquete?", a: "Se aplica el paquete más grande que entra en la estadía, desde el día de llegada, y los días restantes se cobran al precio por día de la quincena que corresponde." },
      { q: "¿Si cambio los precios, se modifican las reservas ya hechas?", a: "No deberían: cada reserva conserva el precio que se acordó cuando se hizo." },
    ],
  },
  {
    slug: "como-cerrar-la-caja-de-un-balneario",
    titulo: "Cómo abrir y cerrar la caja diaria de un balneario",
    resumen:
      "Para cerrar la caja de un balneario se compara el efectivo contado con el efectivo esperado: lo que había al abrir, más lo cobrado en efectivo, menos los gastos pagados en efectivo. Las transferencias y la tarjeta se controlan aparte.",
    actualizado: "2026-11-20",
    secciones: [
      {
        titulo: "La fórmula",
        bloques: [
          { t: "p", texto: "Efectivo esperado = efectivo al abrir + cobros en efectivo − gastos pagados en efectivo." },
          { t: "tabla", cabecera: ["Movimiento", "Importe"], filas: [
            ["Efectivo al abrir", "$50.000"],
            ["Cobros en efectivo del día", "+ $200.000"],
            ["Gastos pagados en efectivo", "− $30.000"],
            ["Efectivo esperado al cerrar", "$220.000"],
          ], nota: "Importes de ejemplo." },
          { t: "p", texto: "Si al contar hay $215.000, la diferencia es de $5.000 menos. Esa diferencia se anota tal cual, con una observación: no se corrigen los movimientos para que «cierre»." },
        ],
      },
      {
        titulo: "Apertura",
        bloques: [
          { t: "lista", ordenada: true, items: [
            "Contá el efectivo con el que arrancás y anotalo, con fecha, hora y quién abrió.",
            "Ese efectivo inicial no es un ingreso: es el cambio para el día.",
            "Si la caja del día anterior quedó sin cerrar, cerrala primero.",
          ] },
        ],
      },
      {
        titulo: "Durante el día",
        bloques: [
          { t: "lista", items: [
            "Cada cobro se anota con su medio de pago: efectivo, transferencia o tarjeta.",
            "Cada gasto pagado (insumos, limpieza, reparaciones) se anota con el concepto y el medio de pago.",
            "Las transferencias y la tarjeta no suman ni restan al efectivo de la caja.",
          ] },
        ],
      },
      {
        titulo: "Cierre",
        bloques: [
          { t: "lista", ordenada: true, items: [
            "Contá el efectivo físico.",
            "Comparalo con el efectivo esperado.",
            "Anotá la diferencia y una observación si la hay.",
            "Revisá los cobros con tarjeta contra el cierre del posnet y las transferencias contra el banco.",
          ] },
        ],
      },
    ],
    preguntas: [
      { q: "¿El dinero con el que abro la caja es un ingreso?", a: "No. Es el efectivo inicial para dar cambio; no se suma a los ingresos del día." },
      { q: "¿Las transferencias se cuentan en la caja?", a: "No en el efectivo. Se registran como cobros del día, pero se controlan contra el banco, no contando billetes." },
    ],
  },
];

export const guiaBySlug = (slug: string) => GUIAS.find((g) => g.slug === slug);

/** Fecha AAAA-MM-DD → DD/MM/AAAA. */
export const fechaAR = (iso: string) => iso.split("-").reverse().join("/");
