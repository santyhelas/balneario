import type { Metadata } from "next";
import { QuoteForm } from "@/components/quote-form";

export const metadata: Metadata = {
  title: "Calculá el precio para tu balneario · Mi Balneario",
  description: "Poné cuántas carpas y sombrillas tenés y mirá el precio de Mi Balneario al instante.",
};

export default function PresupuestoPage() {
  return (
    <div className="min-h-dvh bg-gradient-to-b from-[#e6f4f8] via-[#fbf7ee] to-[#f3e3bd] text-[#1f2a30]">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <a href="/" className="flex items-center gap-2 font-bold"><img src="/logo.png" alt="" className="h-9 w-9 rounded-xl" />Mi Balneario</a>
        <a href="/" className="text-sm font-medium text-[#0b6a87] hover:underline">Volver al inicio</a>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-16 pt-4">
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">¿Cuánto sale para tu balneario?</h1>
        <p className="mt-2 max-w-xl text-[#4a565c]">Poné cuántas carpas y sombrillas tenés y mirá el precio al instante. Si querés, dejanos tus datos y te escribimos.</p>
        <QuoteForm />
      </main>
    </div>
  );
}
