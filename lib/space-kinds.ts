/** Tipos de espacio que se alquilan: carpas, sombrillas y cocheras. */
export type SpaceKind = "carpa" | "sombrilla" | "cochera";

export const SPACE_KINDS: SpaceKind[] = ["carpa", "sombrilla", "cochera"];

const NAMES: Record<SpaceKind, [string, string]> = {
  carpa: ["carpa", "carpas"],
  sombrilla: ["sombrilla", "sombrillas"],
  cochera: ["cochera", "cocheras"],
};

/** "carpa" / "carpas" (en minúscula), según la cantidad. */
export function kindName(kind: SpaceKind | string | null | undefined, n = 1): string {
  const k = (kind && kind in NAMES ? kind : "carpa") as SpaceKind;
  return NAMES[k][n === 1 ? 0 : 1];
}

/** "Carpa" / "Carpas" (con mayúscula), según la cantidad. */
export function KindName(kind: SpaceKind | string | null | undefined, n = 1): string {
  const s = kindName(kind, n);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Carpa 12", "Sombrilla 80", "Cochera C3". */
export function placeName(kind: SpaceKind | string | null | undefined, code: string | null | undefined): string {
  return `${KindName(kind)} ${code ?? "?"}`;
}
