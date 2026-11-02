"use client";
/**
 * Achica una imagen elegida por el usuario y la devuelve como texto (data URL) para guardarla en la base.
 * Así el logo o la foto quedan disponibles en todas las computadoras y celulares.
 */
export async function resizeImage(file: File, maxSide: number, maxBytes: number): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Elegí un archivo de imagen (JPG, PNG o WebP).");
  if (file.size > 15 * 1024 * 1024) throw new Error("La imagen es demasiado grande (máximo 15 MB).");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("No se pudo leer la imagen."));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No se pudo procesar la imagen.");
    ctx.drawImage(img, 0, 0, w, h);
    // WebP si el navegador lo soporta (más liviano); si no, JPEG.
    for (const [type, quality] of [["image/webp", 0.85], ["image/webp", 0.7], ["image/jpeg", 0.8], ["image/jpeg", 0.6]] as const) {
      const data = canvas.toDataURL(type, quality);
      if (data.startsWith(`data:${type}`) && data.length <= maxBytes) return data;
    }
    throw new Error("No se pudo achicar la imagen lo suficiente. Probá con otra.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
