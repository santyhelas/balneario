import { redirect } from "next/navigation";

/** La calculadora pública se sacó: el presupuesto se pide por WhatsApp. Se mantiene la ruta para links viejos. */
export default function PresupuestoPage() {
  redirect("/#planes");
}
