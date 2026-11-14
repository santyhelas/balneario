import { createClient } from "@supabase/supabase-js";

type Caso = { nombre: string; ciudad: string | null; frase: string | null; autor: string | null; numeros: { valor: number; texto: string }[] };

/** Casos de éxito de la página principal: solo los que el dueño publicó con permiso del balneario. Se actualiza cada hora. */
export async function SuccessCases() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  let casos: Caso[] = [];
  try {
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { data } = await sb.rpc("success_cases");
    casos = (data as Caso[] | null) ?? [];
  } catch {
    return null;
  }
  if (!casos.length) return null;
  return (
    <section id="clientes" className="scroll-mt-16 bg-[var(--foam)]">
      <div className="mx-auto max-w-6xl px-4 py-20">
        <h2 data-reveal className="text-4xl font-extrabold sm:text-5xl">Balnearios que ya lo usan</h2>
        <p data-reveal className="mt-3 max-w-2xl text-lg text-[var(--tinta)]/75">Números reales, con permiso de cada balneario.</p>
        <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {casos.map((c, i) => (
            <article key={i} data-reveal className="flex flex-col rounded-[28px] bg-white p-6 shadow-sm ring-1 ring-black/5">
              {c.numeros.length > 0 && (
                <div className="grid grid-cols-2 gap-3">
                  {c.numeros.map((n, j) => (
                    <div key={j} className="rounded-2xl bg-[var(--foam)] p-3">
                      <div className="text-3xl font-extrabold text-[var(--atl)]">{Number(n.valor).toLocaleString("es-AR")}</div>
                      <div className="text-sm text-[var(--tinta)]/75">{n.texto}</div>
                    </div>
                  ))}
                </div>
              )}
              {c.frase && <blockquote className="mt-5 text-lg leading-snug">“{c.frase}”</blockquote>}
              <div className="mt-auto pt-5">
                <div className="font-bold">{c.nombre}</div>
                <div className="text-sm text-[var(--tinta)]/70">{[c.autor, c.ciudad].filter(Boolean).join(" · ")}</div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
