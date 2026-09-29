import { parseCloudinaryUrl, uploadJpeg, type CloudinaryUpload } from "@cameras/core";
import { hasSupabase } from "./config";
import { getSupabase } from "./db/supabase";
import { frameCache } from "./ws/frames";

/**
 * Thumbnails en Cloudinary (F4).
 *
 * El server NO habla con la cámara: aprovecha los frames que ya recibe por el
 * relay (F3) y, pasados `THUMB_INTERVAL_MS`, sube uno a Cloudinary con
 * `public_id` fijo por cámara (se sobrescribe: nunca se acumulan assets).
 *
 * Persistencia: la última URL se guarda en `events` (type='thumbnail'), que ya
 * tiene la columna `thumbnail_url` — así no hace falta ninguna migración.
 * Sin Supabase se guarda en memoria (desarrollo).
 */

const EVENT_TYPE = "thumbnail";
const intervalMs = intFromEnv("THUMB_INTERVAL_MS", 5 * 60_000);
const maxAgeMs = intFromEnv("THUMB_MAX_AGE_MS", 60_000);

const lastAttemptAt = new Map<string, number>();
const inFlight = new Set<string>();
const memoryThumbs = new Map<string, { url: string; at: number }>();

export const thumbStats = {
  uploads: 0,
  failures: 0,
  lastOkAt: null as number | null,
  lastError: null as string | null,
};

export type ThumbOutcome =
  | { ok: true; url: string; publicId: string; bytes: number; ageMs: number }
  | { ok: false; reason: "sin-configurar" | "sin-frame" | "frame-viejo" | "en-curso" | "demasiado-pronto" | "fallo"; message?: string; ageMs?: number };

export function cloudinaryStatus(): { configured: boolean; folder: string; intervalMs: number } {
  return {
    configured: Boolean(parseCloudinaryUrl(process.env.CLOUDINARY_URL)),
    folder: process.env.CLOUDINARY_FOLDER || "cameras-center",
    intervalMs,
  };
}

/**
 * Sube el último frame cacheado a Cloudinary.
 * @param force  salta el límite de `THUMB_INTERVAL_MS` (captura manual del usuario)
 */
export async function captureThumb(cameraId: string, force = false): Promise<ThumbOutcome> {
  const creds = parseCloudinaryUrl(process.env.CLOUDINARY_URL);
  if (!creds) return { ok: false, reason: "sin-configurar", message: "define CLOUDINARY_URL en .env" };

  const frame = frameCache.get(cameraId);
  if (!frame) return { ok: false, reason: "sin-frame", message: "aún no ha llegado ningún frame de esta cámara" };

  const ageMs = Date.now() - frame.receivedAt;
  if (ageMs > maxAgeMs) return { ok: false, reason: "frame-viejo", message: `el último frame tiene ${Math.round(ageMs / 1000)} s`, ageMs };

  const now = Date.now();
  if (!force && now - (lastAttemptAt.get(cameraId) ?? 0) < intervalMs) {
    return { ok: false, reason: "demasiado-pronto" };
  }
  if (inFlight.has(cameraId)) return { ok: false, reason: "en-curso" };

  inFlight.add(cameraId);
  lastAttemptAt.set(cameraId, now);

  try {
    const result: CloudinaryUpload = await uploadJpeg(frame.data, creds, {
      folder: cloudinaryStatus().folder,
      publicId: cameraId, // fijo => se sobrescribe, una foto por cámara
      overwrite: true,
    });

    thumbStats.uploads += 1;
    thumbStats.lastOkAt = Date.now();
    thumbStats.lastError = null;
    memoryThumbs.set(cameraId, { url: result.url, at: Date.now() });

    // esperamos a guardar: cuando `POST /thumbnail` responde 200, el GET
    // de `/thumbnails` ya debe devolverla (si no, hay una carrera).
    await persist(cameraId, result, ageMs);
    console.log(`[thumb] ↑ ${cameraId.slice(0, 8)} → ${result.width}×${result.height} (${result.bytes} B)`);

    return { ok: true, url: result.url, publicId: result.publicId, bytes: result.bytes, ageMs };
  } catch (error) {
    thumbStats.failures += 1;
    thumbStats.lastError = error instanceof Error ? error.message : String(error);
    // sin stack ni URL firmada: la credencial nunca debe llegar a los logs
    console.warn(`[thumb] ✗ ${cameraId.slice(0, 8)}: ${thumbStats.lastError}`);
    return { ok: false, reason: "fallo", message: thumbStats.lastError };
  } finally {
    inFlight.delete(cameraId);
  }
}

/** Última thumbnail por cámara (Supabase si hay, si no memoria). */
export async function latestThumbnails(): Promise<Record<string, string>> {
  if (hasSupabase) {
    try {
      const { data, error } = await getSupabase()
        .from("events")
        .select("camera_id, thumbnail_url, created_at")
        .eq("type", EVENT_TYPE)
        .not("thumbnail_url", "is", null)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);

      const map: Record<string, string> = {};
      for (const row of data ?? []) {
        const { camera_id, thumbnail_url } = row as { camera_id: string; thumbnail_url: string };
        if (thumbnail_url && !map[camera_id]) map[camera_id] = thumbnail_url;
      }
      return map;
    } catch (error) {
      console.warn("[thumb] no se pudieron leer las thumbnails:", error instanceof Error ? error.message : error);
    }
  }
  return Object.fromEntries([...memoryThumbs].map(([id, t]) => [id, t.url]));
}

export async function thumbCount(): Promise<number> {
  if (hasSupabase) {
    try {
      const { count, error } = await getSupabase()
        .from("events")
        .select("id", { count: "exact", head: true })
        .eq("type", EVENT_TYPE);
      if (!error && typeof count === "number") return count;
    } catch {
      // cae al contador en memoria
    }
  }
  return memoryThumbs.size;
}

async function persist(cameraId: string, result: CloudinaryUpload, frameAgeMs: number): Promise<void> {
  if (!hasSupabase) return;
  try {
    const supabase = getSupabase();
    // Mantener UNA sola fila de thumbnail por cámara: `events` es para eventos,
    // no para acumular historial de miniaturas (se borraría cada 5 min).
    const { error: deleteError } = await supabase
      .from("events")
      .delete()
      .eq("camera_id", cameraId)
      .eq("type", EVENT_TYPE);
    if (deleteError) throw new Error(deleteError.message);

    const { error } = await supabase.from("events").insert({
      camera_id: cameraId,
      type: EVENT_TYPE,
      thumbnail_url: result.url,
      payload: {
        publicId: result.publicId,
        bytes: result.bytes,
        width: result.width ?? null,
        height: result.height ?? null,
        frameAgeMs,
      },
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    console.warn("[thumb] no se pudo guardar el evento:", error instanceof Error ? error.message : error);
  }
}

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
