/** Páginas por zona para que los dueños de balnearios encuentren Mi Balneario en Google. */
/** cliente: balneario de la zona que ya usa el sistema (con su permiso). Sin cliente, la página no se ofrece a Google
 *  (noindex): ocho páginas iguales con otro nombre de ciudad Google las toma como relleno y le baja la confianza al sitio. */
export type Cliente = { nombre: string; logo: string; plano?: string; texto: string[] };
export type Zona = { slug: string; nombre: string; provincia: string; donde: string; detalle: string; cliente?: Cliente };

export const ZONAS: Zona[] = [
  { slug: "mar-del-plata", nombre: "Mar del Plata", provincia: "Buenos Aires", donde: "en Mar del Plata", detalle: "desde los balnearios de Punta Mogotes hasta las playas del norte" },
  { slug: "pinamar", nombre: "Pinamar", provincia: "Buenos Aires", donde: "en Pinamar", detalle: "de Ostende a Cariló" },
  { slug: "villa-gesell", nombre: "Villa Gesell", provincia: "Buenos Aires", donde: "en Villa Gesell", detalle: "de Gesell a Mar de las Pampas y Mar Azul",
    cliente: {
      nombre: "Eólico", logo: "/clientes/eolico.svg", plano: "/clientes/plano-eolico.webp",
      texto: [
        "El Eólico, de Villa Gesell, maneja su temporada con Mi Balneario: armamos el plano de su playa tal cual es —el parador, los pasillos, los juegos, las carpas en fila hasta el mar y las sombrillas— y pasamos al sistema las reservas que tenía anotadas en el cuaderno.",
        "Como muchos balnearios de Gesell, trabaja por quincenas de enero y febrero, toma señas por transferencia y tiene un precio con tarjeta o transferencia y otro en efectivo. El sistema guarda los dos precios y, si el cliente paga una parte con cada medio, el saldo da justo.",
      ],
    } },
  { slug: "costa-atlantica", nombre: "Partido de la Costa", provincia: "Buenos Aires", donde: "en el Partido de la Costa", detalle: "San Clemente, Santa Teresita, Mar de Ajó y toda la Costa" },
  { slug: "necochea", nombre: "Necochea", provincia: "Buenos Aires", donde: "en Necochea", detalle: "Necochea y Quequén" },
  { slug: "miramar", nombre: "Miramar", provincia: "Buenos Aires", donde: "en Miramar", detalle: "Miramar y sus alrededores" },
  { slug: "monte-hermoso", nombre: "Monte Hermoso", provincia: "Buenos Aires", donde: "en Monte Hermoso", detalle: "Monte Hermoso y Sauce Grande" },
  { slug: "las-grutas", nombre: "Las Grutas", provincia: "Río Negro", donde: "en Las Grutas", detalle: "Las Grutas y la costa rionegrina" },
];
export const zonaBySlug = (slug: string) => ZONAS.find((z) => z.slug === slug);
/** Zonas con contenido propio: las únicas que van al mapa del sitio y se ofrecen a Google. */
export const ZONAS_INDEXABLES = ZONAS.filter((z) => z.cliente);
