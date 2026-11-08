// Nombres y apellidos: al salir del campo, las palabras escritas en minúscula pasan a llevar mayúscula inicial.
// No se tocan las palabras que ya tienen alguna mayúscula (ej: "McDonald", "DNI").

const PARTICLES = new Set(["de", "del", "la", "las", "los", "y", "da", "di", "van", "von"]);

function cap(w: string): string {
  // También después de guion o apóstrofo: "garcía-lópez" → "García-López", "d'angelo" → "D'Angelo".
  return w.replace(/(^|[-'’])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toLocaleUpperCase("es-AR"));
}

export function capitalizeName(text: string): string {
  const words = text.trim().replace(/\s+/g, " ").split(" ");
  return words
    .map((w, i) => {
      if (!w || w !== w.toLocaleLowerCase("es-AR")) return w; // ya tiene mayúsculas: se respeta
      if (i > 0 && PARTICLES.has(w)) return w; // "de la Torre"
      return cap(w);
    })
    .join(" ");
}

/**
 * Mientras se escribe: la primera palabra lleva mayúscula enseguida, y cada palabra siguiente
 * apenas se termina (al poner el espacio), salvo «de», «la», «del»… Respeta los espacios
 * y lo que ya tiene mayúsculas. Al salir del campo, capitalizeName termina de acomodar.
 */
export function capitalizeTyping(text: string): string {
  const parts = text.split(/(\s+)/); // conserva los espacios tal cual
  let wordIndex = 0;
  return parts
    .map((p, k) => {
      if (!p || /^\s+$/.test(p)) return p;
      const i = wordIndex++;
      const finished = k < parts.length - 1; // le sigue un espacio
      if (p !== p.toLocaleLowerCase("es-AR")) return p;
      if (i === 0) return cap(p);
      if (!finished || PARTICLES.has(p)) return p;
      return cap(p);
    })
    .join("");
}
