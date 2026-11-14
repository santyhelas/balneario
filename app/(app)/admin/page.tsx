import { redirect } from "next/navigation";

/** El panel del dueño se mudó a /dueno (no necesita tener un balneario). */
export default function AdminRedirect() {
  redirect("/dueno");
}
