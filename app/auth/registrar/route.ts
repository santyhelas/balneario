import { json } from "@/lib/auth-server";

// Las altas están cerradas: las cuentas nuevas se dan cuando el cliente contrata un plan.
// Los empleados de un balneario los sigue creando su propietario desde Configuración → Usuarios.
export async function GET() {
  return json({ abierto: false, planes: "/#planes" });
}

export async function POST() {
  return json({ error: "Por ahora no se pueden crear cuentas desde acá. Pedí tu presupuesto en la página principal o escribinos.", planes: "/#planes" }, 403);
}
