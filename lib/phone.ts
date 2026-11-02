// Teléfonos con código de país. Argentina es el país por defecto; en Argentina los
// celulares llevan un 9 entre el código de país y el código de área (+54 9 11 …).

export type Country = { code: string; name: string; dial: string };

export const COUNTRIES: Country[] = [
  { code: "AR", name: "Argentina", dial: "54" },
  { code: "UY", name: "Uruguay", dial: "598" },
  { code: "BR", name: "Brasil", dial: "55" },
  { code: "CL", name: "Chile", dial: "56" },
  { code: "PY", name: "Paraguay", dial: "595" },
  { code: "BO", name: "Bolivia", dial: "591" },
  { code: "PE", name: "Perú", dial: "51" },
  { code: "CO", name: "Colombia", dial: "57" },
  { code: "MX", name: "México", dial: "52" },
  { code: "ES", name: "España", dial: "34" },
  { code: "IT", name: "Italia", dial: "39" },
  { code: "US", name: "Estados Unidos / Canadá", dial: "1" },
];

export type PhoneParts = { dial: string; mobile: boolean; area: string; number: string };

export const EMPTY_PHONE: PhoneParts = { dial: "54", mobile: true, area: "", number: "" };

const digits = (t: string) => t.replace(/\D/g, "");

/** Limpia lo que la gente suele escribir en Argentina: 0 adelante del área y 15 adelante del número. */
export function cleanArgentine(area: string, number: string): { area: string; number: string } {
  let a = digits(area).replace(/^0+/, "");
  let n = digits(number);
  if (n.startsWith("15") && a.length + n.length === 12) n = n.slice(2);
  // Si escribieron todo junto en el número (ej. 1145554165) y el área quedó vacía, no se adivina el área.
  if (a.startsWith("549")) a = a.slice(3);
  return { area: a, number: n };
}

/** Arma el teléfono para guardar: "+54 9 11 4555-4165". */
export function formatPhone(p: PhoneParts): string | null {
  let area = digits(p.area);
  let number = digits(p.number);
  if (p.dial === "54") ({ area, number } = cleanArgentine(area, number));
  if (!number) return null;
  const n = number.length >= 6 ? `${number.slice(0, number.length - 4)}-${number.slice(-4)}` : number;
  const mobile = p.dial === "54" && p.mobile ? " 9" : "";
  return `+${p.dial}${mobile}${area ? ` ${area}` : ""} ${n}`;
}

/** Problema a corregir (o null). En Argentina, área + número suman 10 dígitos. */
export function phoneProblem(p: PhoneParts): string | null {
  const area = digits(p.area);
  const number = digits(p.number);
  if (!area && !number) return null;
  if (!number) return "Falta el número.";
  if (p.dial === "54") {
    const c = cleanArgentine(area, number);
    if (!c.area) return "Falta el código de área (ej: 11, 223, 2255).";
    if (c.area.length < 2 || c.area.length > 4) return "El código de área tiene entre 2 y 4 dígitos (sin el 0).";
    if (c.area.length + c.number.length !== 10) return `En Argentina el código de área y el número suman 10 dígitos (ahora hay ${c.area.length + c.number.length}).`;
    return null;
  }
  if (area.length + number.length < 6) return "El número parece incompleto.";
  return null;
}

/** Separa un teléfono guardado en sus partes, para poder editarlo. */
export function parsePhone(stored: string | null | undefined): PhoneParts {
  if (!stored) return { ...EMPTY_PHONE };
  const t = stored.trim();
  if (t.startsWith("+")) {
    const tokens = t.slice(1).split(/\s+/);
    const dial = tokens.shift() ?? "54";
    const known = COUNTRIES.some((c) => c.dial === dial);
    if (known) {
      let mobile = false;
      if (dial === "54" && tokens[0] === "9") { mobile = true; tokens.shift(); }
      if (tokens.length >= 2) return { dial, mobile, area: tokens[0], number: digits(tokens.slice(1).join("")) };
      return { dial, mobile, area: "", number: digits(tokens.join("")) };
    }
  }
  // Teléfonos anteriores, escritos libremente: se toman como argentinos.
  const parts = t.split(/\s+/);
  if (parts.length >= 2) {
    const c = cleanArgentine(parts[0], parts.slice(1).join(""));
    return { dial: "54", mobile: true, area: c.area, number: c.number };
  }
  return { dial: "54", mobile: true, area: "", number: digits(t) };
}
