// Clima actual de OpenWeather (plan gratis: uso comercial permitido, datos cada ~10 minutos,
// hay que mostrar "Weather data © OpenWeather"). Necesita la clave OPENWEATHER_API_KEY (solo en el servidor).

export type OwCurrent = {
  dt: number;
  name?: string;
  main?: { temp?: number; feels_like?: number; humidity?: number; pressure?: number };
  wind?: { speed?: number; deg?: number; gust?: number };
  weather?: { id: number; description: string; icon: string }[];
};

export type Ahora = {
  hora: string;
  lugar: string | null;
  temperatura: number | null;
  sensacion: number | null;
  humedad: number | null;
  viento_kmh: number | null;
  rafagas_kmh: number | null;
  viento_desde: number | null;
  simbolo: string | null;
  cielo: string | null;
};

/** Código de condición de OpenWeather → código de ícono (mismo formato que MET Norway). */
export function owSymbol(id: number, icon: string): string | null {
  const dn = icon.endsWith("n") ? "_night" : "_day";
  if (id >= 200 && id < 300) return "rainandthunder";
  if (id >= 300 && id < 400) return "lightrain";
  if (id === 500) return "lightrain";
  if (id === 501) return "rain";
  if (id >= 502 && id <= 504) return "heavyrain";
  if (id === 511) return "sleet";
  if (id >= 520 && id < 600) return "rainshowers" + dn;
  if (id >= 600 && id < 700) return "snow";
  if (id >= 700 && id < 800) return "fog";
  if (id === 800) return "clearsky" + dn;
  if (id === 801) return "fair" + dn;
  if (id === 802) return "partlycloudy" + dn;
  if (id === 803 || id === 804) return "cloudy";
  return null;
}

export function parseOw(b: OwCurrent): Ahora | null {
  if (!b || typeof b.dt !== "number" || typeof b.main?.temp !== "number") return null;
  const kmh = (ms: number | undefined) => (typeof ms === "number" ? Math.round(ms * 3.6) : null);
  const w = b.weather?.[0];
  const desc = w?.description ?? null;
  return {
    hora: new Date(b.dt * 1000).toISOString(),
    lugar: b.name || null,
    temperatura: Math.round(b.main.temp * 10) / 10,
    sensacion: typeof b.main.feels_like === "number" ? Math.round(b.main.feels_like * 10) / 10 : null,
    humedad: b.main.humidity ?? null,
    viento_kmh: kmh(b.wind?.speed),
    rafagas_kmh: kmh(b.wind?.gust),
    viento_desde: typeof b.wind?.deg === "number" ? b.wind.deg : null,
    simbolo: w ? owSymbol(w.id, w.icon) : null,
    cielo: desc ? desc.charAt(0).toUpperCase() + desc.slice(1) : null,
  };
}
