import type { Metadata } from "next";

export const metadata: Metadata = { title: "Página no encontrada · Mi Balneario", robots: { index: false, follow: true } };

// Dirección inexistente: responde 404 (no lleva al inicio, así Google no la toma como copia).
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg px-4 text-center text-fg">
      <img src="/logo-96.png" alt="" className="h-16 w-16" />
      <h1 className="text-2xl font-bold">Esta página no existe</h1>
      <p className="max-w-sm text-muted">Puede que la dirección esté mal escrita o que la página ya no esté.</p>
      <a href="/" className="rounded-lg bg-accent px-4 py-2 font-semibold text-accent-fg hover:opacity-90">Ir al inicio</a>
    </main>
  );
}
