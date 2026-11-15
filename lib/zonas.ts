/** Páginas por zona para que los dueños de balnearios encuentren Mi Balneario en Google. */
export type Zona = { slug: string; nombre: string; provincia: string; donde: string; detalle: string };

export const ZONAS: Zona[] = [
  { slug: "mar-del-plata", nombre: "Mar del Plata", provincia: "Buenos Aires", donde: "en Mar del Plata", detalle: "desde los balnearios de Punta Mogotes hasta las playas del norte" },
  { slug: "pinamar", nombre: "Pinamar", provincia: "Buenos Aires", donde: "en Pinamar", detalle: "de Ostende a Cariló" },
  { slug: "villa-gesell", nombre: "Villa Gesell", provincia: "Buenos Aires", donde: "en Villa Gesell", detalle: "de Gesell a Mar de las Pampas y Mar Azul" },
  { slug: "costa-atlantica", nombre: "Partido de la Costa", provincia: "Buenos Aires", donde: "en el Partido de la Costa", detalle: "San Clemente, Santa Teresita, Mar de Ajó y toda la Costa" },
  { slug: "necochea", nombre: "Necochea", provincia: "Buenos Aires", donde: "en Necochea", detalle: "Necochea y Quequén" },
  { slug: "miramar", nombre: "Miramar", provincia: "Buenos Aires", donde: "en Miramar", detalle: "Miramar y sus alrededores" },
  { slug: "monte-hermoso", nombre: "Monte Hermoso", provincia: "Buenos Aires", donde: "en Monte Hermoso", detalle: "Monte Hermoso y Sauce Grande" },
  { slug: "las-grutas", nombre: "Las Grutas", provincia: "Río Negro", donde: "en Las Grutas", detalle: "Las Grutas y la costa rionegrina" },
];
export const zonaBySlug = (slug: string) => ZONAS.find((z) => z.slug === slug);
