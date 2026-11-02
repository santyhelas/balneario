// Widget oficial de Windguru: a partir del número de spot, su dirección o el código que da Windguru,
// se arman los parámetros del widget (spot, modelo, unidades y datos a mostrar).

const DEFAULTS: Record<string, string> = {
  m: "3",
  wj: "kmh",
  tj: "c",
  odh: "0",
  doh: "24",
  fhours: "72",
  vt: "forecasts",
  lng: "es",
  p: "WINDSPD,GUST,SMER,TMPE,TCDC,APCP1s,RH",
};

const SAFE = /^[A-Za-z0-9,._%-]+$/;

/** Devuelve "s=…&m=…" listo para guardar, o un mensaje de error en español. */
export function parseWindguru(input: string): { params: string } | { error: string } {
  const text = input.trim();
  if (!text) return { error: "Pegá el número de spot, la dirección de Windguru o el código del widget." };

  const out: Record<string, string> = {};
  // Código del widget: var arg = ["s=485028","m=3",...]
  const argBlock = /arg\s*=\s*\[([^\]]+)\]/.exec(text);
  if (argBlock) {
    for (const m of argBlock[1].matchAll(/["']([a-z]+)=([^"']*)["']/gi)) {
      out[m[1]] = m[2];
    }
  } else {
    // Dirección (windguru.cz/123456 o …?s=123456) o número suelto
    const m = /windguru\.[a-z]+\/(?:[a-z]{2}\/)?(\d{2,9})\b/i.exec(text) ?? /[?&]s=(\d{2,9})/.exec(text) ?? /^(\d{2,9})$/.exec(text);
    if (!m) return { error: "No reconozco ese dato. Pegá el número de spot (ej. 48572), la dirección de la página del spot o el código del widget." };
    out.s = m[1];
  }
  if (!out.s || !/^\d{2,9}$/.test(out.s)) return { error: "No encontré el número de spot de Windguru en lo que pegaste." };

  const merged: Record<string, string> = { ...DEFAULTS, ...out };
  delete merged.uid; // se genera al mostrarlo
  const parts: string[] = [];
  for (const [k, v] of Object.entries(merged)) {
    if (!/^[a-z]+$/i.test(k) || !SAFE.test(v)) continue;
    parts.push(`${k}=${v}`);
  }
  return { params: parts.join("&") };
}

export function spotOf(params: string | null | undefined): string | null {
  return params ? /(?:^|&)s=(\d+)/.exec(params)?.[1] ?? null : null;
}

/** Página HTML aislada que carga el widget oficial (se muestra en un iframe sin acceso a la sesión). */
export function widgetDocument(params: string): string {
  const kv = params.split("&").filter((p) => /^[a-z]+=[A-Za-z0-9,._%-]+$/i.test(p));
  const s = spotOf(params) ?? "0";
  const m = /(?:^|&)m=(\d+)/.exec(params)?.[1] ?? "3";
  const uid = `wg_fwdg_${s}_${m}_${Date.now()}`;
  const args = JSON.stringify([...kv, `uid=${uid}`]);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank">
<style>html,body{margin:0;padding:0;background:#fff;font-family:system-ui,sans-serif}</style></head><body>
<script id="${uid}">(function(){var arg=${args};var s=document.createElement("script");s.src="https://www.windguru.cz/js/widget.php?"+arg.join("&");var t=document.getElementsByTagName("script")[0];t.parentNode.insertBefore(s,t);})();</script>
</body></html>`;
}
