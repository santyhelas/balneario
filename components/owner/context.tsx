"use client";
import { createContext, useContext } from "react";

export type OwnerCtx = { userId: string; email: string | null; mineId: string | null; mineName: string | null };
export const OwnerContext = createContext<OwnerCtx | null>(null);
export function useOwner(): OwnerCtx {
  const c = useContext(OwnerContext);
  if (!c) throw new Error("useOwner fuera del panel del dueño");
  return c;
}
