/** Atajos de teclado de todo el sistema. Cada usuario puede cambiarlos en Configuración → Atajos de teclado. */
export type HotkeyAction = { id: string; href: string; label: string; key: string };

export const HOTKEYS: HotkeyAction[] = [
  { id: "nueva", key: "F2", href: "/reservas/nueva", label: "Nueva reserva" },
  { id: "clientes", key: "F3", href: "/clientes", label: "Buscar cliente" },
  { id: "mapa", key: "F4", href: "/mapa", label: "Mapa" },
  { id: "disponibilidad", key: "F6", href: "/disponibilidad", label: "Disponibilidad" },
  { id: "reservas", key: "F7", href: "/reservas", label: "Reservas (cambiar de carpa)" },
  { id: "gasto", key: "F8", href: "/gastos?nuevo=1", label: "Nuevo gasto" },
  { id: "caja", key: "F9", href: "/caja", label: "Caja diaria" },
  { id: "reportes", key: "F10", href: "/reportes", label: "Reportes" },
  { id: "cobros", key: "", href: "/cobros", label: "Cobros y deudas" },
  { id: "tarifas", key: "", href: "/tarifas", label: "Tarifario" },
];

/** Teclas que maneja el navegador y no conviene pisar. */
export const RESERVED_KEYS = new Set(["F5", "F11", "F12", "Alt+F4", "Alt+D", "Alt+F"]);

/** Nombre de la tecla tal como se guarda y se muestra: «F2», «Alt+R», «Alt+3». */
export function keyName(e: { key: string; code?: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): string | null {
  if (e.ctrlKey || e.metaKey) return null;
  if (/^F([1-9]|1[0-2])$/.test(e.key)) return (e.altKey ? "Alt+" : "") + (e.shiftKey ? "Shift+" : "") + e.key;
  if (!e.altKey) return null; // letras y números sueltos no: se escriben en los formularios
  const code = e.code ?? "";
  const ch = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit[0-9]$/.test(code) ? code.slice(5) : null;
  return ch ? `Alt+${e.shiftKey ? "Shift+" : ""}${ch}` : null;
}

/** Atajos efectivos: los del usuario encima de los de fábrica. "" = sin atajo. */
export function effectiveHotkeys(custom: Record<string, string> | null | undefined): HotkeyAction[] {
  return HOTKEYS.map((h) => ({ ...h, key: custom && typeof custom[h.id] === "string" ? custom[h.id] : h.key }));
}

// ---- Estado compartido en la página (Shell lo carga; Configuración lo cambia) ----
let current: Record<string, string> | null = null;
const listeners = new Set<() => void>();
export function setHotkeyPrefs(v: Record<string, string> | null) { current = v; listeners.forEach((l) => l()); }
export function getHotkeyPrefs() { return current; }
export function subscribeHotkeys(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
