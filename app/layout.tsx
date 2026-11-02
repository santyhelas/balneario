import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Balneario · Gestión",
  description: "Gestión integral del balneario: reservas, mapa, caja y clientes.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// Aplica el tema guardado antes de pintar, para evitar el destello de color.
// La preferencia real vive en la base (user_preferences); esto es solo una copia para el primer pintado.
const themeScript = `
try {
  var t = localStorage.getItem('balneario-tema') || 'sistema';
  var dark = t === 'oscuro' || (t === 'sistema' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
} catch (e) { document.documentElement.setAttribute('data-theme', 'light'); }
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh bg-bg text-fg">{children}</body>
    </html>
  );
}
