"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyError } from "@/lib/errors";

/** Lanza el error de Supabase si lo hay; si no, devuelve los datos. */
export function unwrap<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error;
  return res.data as T;
}

/**
 * Carga datos de la base y los mantiene actualizados:
 * - recarga al volver a la pestaña y cada `intervalMs`;
 * - si una recarga falla, conserva los datos anteriores PERO lo informa (stale + error),
 *   para no mostrar información vieja como si fuera la definitiva.
 */
export function useLoader<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 30_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const result = await fnRef.current();
      if (my !== seq.current) return;
      setData(result);
      setError(null);
      setUpdatedAt(new Date());
    } catch (err) {
      if (my !== seq.current) return;
      setError(friendlyError(err));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setData(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    const id = intervalMs > 0 ? window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, intervalMs) : undefined;
    return () => {
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
      if (id) window.clearInterval(id);
    };
  }, [reload, intervalMs]);

  return { data, error, loading, reload, updatedAt, stale: error !== null && data !== null };
}

/** Clave única para que reintentar una operación no la duplique. */
export function newKey(): string {
  return crypto.randomUUID();
}
