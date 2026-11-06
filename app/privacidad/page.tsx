import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";
import { SITE_EMAIL } from "@/lib/site";

export const metadata: Metadata = { title: "Política de privacidad · Mi Balneario" };

export default function PrivacidadPage() {
  return (
    <LegalPage title="Política de privacidad" updated="06/11/2026">
      <p>
        Esta política explica qué datos trata Mi Balneario (el &quot;Servicio&quot;), para qué y cómo podés ejercer tus derechos,
        conforme a la Ley 25.326 de Protección de los Datos Personales de la República Argentina y sus normas complementarias.
      </p>

      <h2>1. Quién es quién</h2>
      <p>
        Cada balneario que usa el Servicio es el <strong>responsable</strong> de los datos de sus propios clientes (nombre, teléfono,
        correo, reservas, pagos). Mi Balneario actúa como <strong>prestador del servicio</strong>: guarda y procesa esos datos solo para
        que el balneario pueda usar el sistema, y no los usa para otros fines ni los vende.
      </p>
      <p>Para los datos de las cuentas de usuario (dueños y empleados de los balnearios), Mi Balneario es el responsable.</p>

      <h2>2. Qué datos tratamos</h2>
      <ul>
        <li><strong>Cuenta:</strong> nombre de usuario, correo electrónico y, si ingresás con Google, el nombre y la foto de esa cuenta.</li>
        <li><strong>Datos que carga el balneario:</strong> clientes (nombre, apellido, teléfono, correo, observaciones), reservas, pagos, caja, gastos, tarifas y notas.</li>
        <li><strong>Ubicación del balneario:</strong> la que se carga en Configuración, para mostrar el clima. No guardamos la ubicación de las personas.</li>
        <li><strong>Datos técnicos:</strong> registros de seguridad (por ejemplo, intentos de ingreso) y estadísticas de visitas de la página de presentación, anónimas y sin cookies.</li>
      </ul>

      <h2>3. Para qué los usamos</h2>
      <ul>
        <li>Prestar el Servicio: reservas, cobros, caja, informes, avisos y copias de seguridad.</li>
        <li>Proteger las cuentas y prevenir abusos (límite de intentos de ingreso, verificación contra robots).</li>
        <li>Responder consultas y avisar cambios importantes del Servicio.</li>
      </ul>

      <h2>4. Con quién se comparten</h2>
      <p>
        Usamos proveedores que alojan o procesan información por cuenta nuestra, algunos con servidores fuera de la Argentina:
        Supabase (base de datos e ingreso), Vercel (alojamiento de la página y estadísticas anónimas), Google (ingreso con Google y,
        si el balneario lo activa, copias de seguridad en su propio Google Drive), Cloudflare (verificación contra robots),
        OpenWeather y MET Norway (clima, solo con la ubicación del balneario) y OpenStreetMap (búsqueda de lugares).
        Los mensajes de WhatsApp los envía el propio usuario desde su teléfono; el Servicio solo prepara el texto.
      </p>
      <p>No vendemos ni cedemos datos personales a terceros con fines comerciales.</p>

      <h2>5. Cuánto tiempo los guardamos</h2>
      <p>
        Mientras el balneario use el Servicio. Si da de baja su cuenta, los datos se eliminan dentro de un plazo razonable, salvo lo que
        deba conservarse por obligación legal. Los datos cargados en la demo se borran al salir o, como máximo, a las 6 horas.
      </p>

      <h2>6. Seguridad</h2>
      <p>
        La información viaja cifrada, cada balneario solo puede ver sus propios datos, los movimientos de dinero no se pueden borrar
        y queda un historial de cambios. Ningún sistema es infalible, pero aplicamos medidas razonables para proteger los datos.
      </p>

      <h2>7. Tus derechos</h2>
      <p>
        Podés pedir acceso, rectificación, actualización o supresión de tus datos escribiendo a{" "}
        <a className="text-accent hover:underline" href={`mailto:${SITE_EMAIL}`}>{SITE_EMAIL}</a>. Si sos cliente de un balneario,
        también podés pedírselo directamente al balneario. El derecho de acceso se puede ejercer en forma gratuita a intervalos no
        inferiores a seis meses, salvo que se acredite un interés legítimo (art. 14, inc. 3, Ley 25.326).
      </p>
      <p>
        LA AGENCIA DE ACCESO A LA INFORMACIÓN PÚBLICA, en su carácter de Órgano de Control de la Ley N° 25.326, tiene la atribución de
        atender las denuncias y reclamos que interpongan quienes resulten afectados en sus derechos por incumplimiento de las normas
        vigentes en materia de protección de datos personales.
      </p>

      <h2>8. Cookies</h2>
      <p>Usamos solo las cookies necesarias para mantener la sesión iniciada y recordar tus preferencias. No usamos cookies de publicidad.</p>

      <h2>9. Cambios</h2>
      <p>Si cambiamos esta política, lo publicaremos en esta página con la nueva fecha de actualización.</p>
    </LegalPage>
  );
}
