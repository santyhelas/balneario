/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Protecciones del navegador para todas las páginas.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Ninguna otra web puede mostrar esta página "metida adentro" (evita engaños con clics ocultos).
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
          // El navegador no adivina tipos de archivo.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Al abrir enlaces externos no se manda la dirección completa de la página.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // La página no usa cámara, micrófono ni ubicación del dispositivo.
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
          // Siempre por conexión cifrada (https).
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};
export default nextConfig;
