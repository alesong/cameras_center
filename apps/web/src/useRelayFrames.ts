import { useEffect, useState } from "react";
import { subscribeFrame } from "./relay";

/** Cuántos object URLs vivos mantenemos por cámara (evita parpadeos y GC). */
const POOL_SIZE = 8;

/**
 * Recibe frames JPEG del relay del server (F3) y devuelve la última imagen
 * como object URL, lista para un `<img src>`.
 *
 * Sólo se suscribe a las cámaras de `cameraIds`: al vaciar la lista se manda
 * `viewer:unsubscribe` y el server deja de reenviar.
 */
export function useRelayFrames(cameraIds: string[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  // clave estable para el efecto (evita re-suscribirse en cada render)
  const key = [...cameraIds].sort().join(",");

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) {
      setUrls({});
      return;
    }

    const pools = new Map<string, string[]>();
    const cleanups: Array<() => void> = [];

    for (const cameraId of ids) {
      const pool: string[] = [];
      pools.set(cameraId, pool);

      cleanups.push(
        subscribeFrame(cameraId, (blob) => {
          const objectUrl = URL.createObjectURL(blob);
          pool.push(objectUrl);
          while (pool.length > POOL_SIZE) {
            const old = pool.shift();
            if (old) URL.revokeObjectURL(old);
          }
          setUrls((prev) => ({ ...prev, [cameraId]: objectUrl }));
        }),
      );
    }

    return () => {
      for (const cleanup of cleanups) cleanup();
      for (const pool of pools.values()) {
        for (const objectUrl of pool) URL.revokeObjectURL(objectUrl);
      }
      setUrls({});
    };
  }, [key]);

  return urls;
}
