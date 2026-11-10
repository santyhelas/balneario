/** Atajos de teclado de todo el sistema (reemplazan los botones de «Accesos rápidos» del panel). */
export const HOTKEYS: { key: string; href: string; label: string }[] = [
  { key: "F2", href: "/reservas/nueva", label: "Nueva reserva" },
  { key: "F3", href: "/clientes", label: "Buscar cliente" },
  { key: "F4", href: "/mapa", label: "Mapa" },
  { key: "F6", href: "/disponibilidad", label: "Disponibilidad" },
  { key: "F7", href: "/reservas", label: "Reservas (cambiar de carpa)" },
  { key: "F8", href: "/gastos?nuevo=1", label: "Nuevo gasto" },
  { key: "F9", href: "/caja", label: "Caja diaria" },
  { key: "F10", href: "/reportes", label: "Reportes" },
];
