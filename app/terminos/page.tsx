import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = { title: "Términos de uso · Tu Balneario" };

export default function TerminosPage() {
  return (
    <LegalPage title="Términos de uso" updated="06/11/2026">
      <p>
        Estos términos regulan el uso de Tu Balneario (el &quot;Servicio&quot;), un sistema web de gestión para balnearios.
        Al crear una cuenta o usar el Servicio aceptás estos términos.
      </p>

      <h2>1. El Servicio</h2>
      <p>
        Tu Balneario permite administrar reservas de carpas y sombrillas, clientes, cobros, deudas, caja diaria, tarifas, informes y
        copias de seguridad. Funciona por internet desde el navegador. Podemos mejorar, cambiar o agregar funciones con el tiempo.
      </p>

      <h2>2. Cuentas</h2>
      <ul>
        <li>Las cuentas de balneario se habilitan al contratar un plan. El propietario puede crear usuarios para su personal.</li>
        <li>Cada usuario es responsable de cuidar su contraseña y de lo que se haga con su cuenta.</li>
        <li>Si detectás un uso no autorizado, avisanos enseguida.</li>
      </ul>

      <h2>3. Uso correcto</h2>
      <p>
        El Servicio debe usarse para la gestión de un balneario y conforme a la ley. No está permitido intentar acceder a datos de
        otros balnearios, sobrecargar el sistema, usar programas automáticos para abrir demos o cuentas, ni cargar información ilícita.
      </p>

      <h2>4. Datos cargados</h2>
      <p>
        Los datos que carga cada balneario son suyos. El balneario es responsable de tener el consentimiento de sus clientes para
        cargar sus datos y de usarlos conforme a la Ley 25.326. El tratamiento de datos se describe en la{" "}
        <a className="text-accent hover:underline" href="/privacidad">Política de privacidad</a>.
      </p>

      <h2>5. Planes y pagos</h2>
      <p>
        Las condiciones, precios y forma de pago de cada plan se acuerdan al contratarlo. La falta de pago puede limitar el uso del
        Servicio; en ese caso el balneario podrá seguir consultando y descargando sus datos durante un plazo razonable.
      </p>

      <h2>6. Demo</h2>
      <p>La demo es un balneario de prueba con datos inventados. Todo lo que se cargue en la demo se borra al salir.</p>

      <h2>7. Disponibilidad y responsabilidad</h2>
      <p>
        Trabajamos para que el Servicio esté disponible y funcione correctamente, pero puede haber interrupciones por mantenimiento,
        fallas de internet o de los proveedores. Recomendamos mantener activadas las copias de seguridad. Los datos del clima son
        informativos y provienen de servicios externos. En la medida permitida por la ley, no somos responsables por daños indirectos
        derivados del uso del Servicio.
      </p>

      <h2>8. Baja</h2>
      <p>
        El balneario puede dejar de usar el Servicio cuando quiera y pedir una copia de sus datos. Podemos suspender cuentas que
        incumplan estos términos, avisando previamente cuando sea posible.
      </p>

      <h2>9. Cambios y ley aplicable</h2>
      <p>
        Podemos actualizar estos términos; los cambios importantes se avisarán. Se aplican las leyes de la República Argentina.
      </p>
    </LegalPage>
  );
}
