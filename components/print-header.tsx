"use client";
import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";

/**
 * Encabezado que aparece solo al imprimir (o guardar en PDF): logo, nombre del balneario,
 * fecha y hora de impresión y el título de la página. Las páginas con encabezado propio
 * (comprobante, ticket de tarjetas) lo ocultan con la clase "own-print-header".
 */
export function PrintHeader() {
  const { ws } = useWorkspace();
  const [now, setNow] = useState(() => new Date().toISOString());
  const [title, setTitle] = useState("");
  useEffect(() => {
    const before = () => {
      setNow(new Date().toISOString());
      setTitle(document.querySelector("main h1")?.textContent?.trim() ?? "");
    };
    before();
    window.addEventListener("beforeprint", before);
    return () => window.removeEventListener("beforeprint", before);
  }, []);
  return (
    <div className="print-header mb-4 hidden items-center gap-3 border-b border-black pb-2 text-black print:flex">
      {ws.logo_data && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={ws.logo_data} alt="" className="h-14 w-14 object-contain" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-lg font-bold leading-tight">{ws.name}</div>
        {ws.subtitle && <div className="text-xs">{ws.subtitle}</div>}
      </div>
      <div className="text-right text-xs">
        {title && <div className="font-semibold">{title}</div>}
        <div>Impreso el {formatDateTime(now, ws.timezone)}</div>
      </div>
    </div>
  );
}
