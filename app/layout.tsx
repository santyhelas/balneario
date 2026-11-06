import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mi Balneario",
  description: "Mi Balneario: gestión integral de balnearios — reservas, mapa, caja y clientes.",
  applicationName: "Mi Balneario",
  icons: {
    icon: [{ url: "/favicon.ico", sizes: "any" }, { url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  // iPhone: al agregarla a la pantalla de inicio se abre a pantalla completa, como una app.
  appleWebApp: { capable: true, title: "Mi Balneario", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // usa toda la pantalla (muesca del iPhone incluida); los márgenes los da safe-area
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#162027" },
  ],
};

// Aplica el tema guardado antes de pintar, para evitar el destello de color.
// La preferencia real vive en la base (user_preferences); esto es solo una copia para el primer pintado.
const themeScript = `
try {
  var t = localStorage.getItem('balneario-tema') || 'sistema';
  var dark = t === 'oscuro' || (t === 'sistema' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
} catch (e) { document.documentElement.setAttribute('data-theme', 'light'); }
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
}
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
