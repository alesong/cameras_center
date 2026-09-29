import { Router } from "express";
import { CreateCameraSchema } from "@cameras/protocol";
import { store, toPublicCamera } from "../store";
import { requireAuth, requirePrincipal } from "../middleware/auth";
import { principalRateLimit } from "../middleware/rateLimit";
import { captureThumb, latestThumbnails } from "../thumbs";
import { frameCache, type CachedFrame } from "../ws/frames";

/**
 * Registro de cámaras.
 *  - Lectura: pública (la UI y los viewers la necesitan sin token), salvo las
 *    de imagen (frame.jpg / thumbnails / stream), que sí aceptan JWT o API key.
 *  - Escritura: requiere JWT (F2).
 *  - Persistencia: Supabase si está configurado, si no memoria.
 */
export const camerasRouter = Router();

function handleError(res: import("express").Response, error: unknown, context: string) {
  console.error(`[cameras] ${context}:`, error);
  const message = error instanceof Error ? error.message : "Error interno";
  if (res.headersSent) return res.end(); // p.ej. fallo a mitad del stream MJPEG
  return res.status(500).json({ error: message });
}

camerasRouter.get("/", async (_req, res) => {
  try {
    const cameras = await store.list();
    res.json({ cameras: cameras.map(toPublicCamera), backend: store.backend });
  } catch (error) {
    handleError(res, error, "list");
  }
});

/**
 * Último frame (JPEG) recibido por relay — F3/F5.
 *
 * Sirve de API pública / fallback para quien no pueda abrir WebSocket: no es
 * vídeo, es una foto en el instante de la petición. Acepta JWT de usuario o
 * API key con scope `read` porque expone la imagen fuera de la LAN.
 */
camerasRouter.get("/:id/frame.jpg", requirePrincipal, principalRateLimit, async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: "Falta el id" });
  try {
    const camera = await store.get(id);
    if (!camera) return res.status(404).json({ error: "Camara no encontrada" });

    const frame = frameCache.get(id);
    if (!frame) {
      return res.status(404).json({
        error: "Sin frames recientes: abre la camara en la app para que el agent arranque",
      });
    }
    const ageMs = Date.now() - frame.receivedAt;
    res
      .set("Content-Type", "image/jpeg")
      .set("Cache-Control", "no-store")
      .set("X-Frame-Age-Ms", String(ageMs))
      .send(frame.data);
  } catch (error) {
    handleError(res, error, "frame");
  }
});

/**
 * Última thumbnail (Cloudinary) de cada cámara — F4.
 * Se usa como póster estático en la UI; acepta JWT o API key igual que `frame.jpg`.
 */
camerasRouter.get("/thumbnails", requirePrincipal, principalRateLimit, async (_req, res) => {
  try {
    res.json({ thumbnails: await latestThumbnails() });
  } catch (error) {
    handleError(res, error, "thumbnails");
  }
});

/**
 * Stream MJPEG continuo — F5.
 *
 * `GET /api/v1/streams/:id.mjpg` (alias `GET /api/v1/cameras/:id/stream.mjpg`)
 * → `multipart/x-mixed-replace`. Es la forma más simple de que un tercero vea
 * vídeo: `<img src=…>`, VLC, ffmpeg o cualquier visor de MJPEG. Sin WebSocket
 * ni SDK.
 *
 * Al abrirlo el server se registra como espectador (gateway.acquire) y eso pide
 * al agent que arranque FFmpeg; al cerrarse la conexión lo suelta y, si no queda
 * nadie, el agent se apaga (AGENT_NO_VIEWER_STOP_MS).
 */
export async function streamMjpeg(req: import("express").Request, res: import("express").Response) {
  // acepta tanto `.../<id>.mjpg` como `.../<id>/stream.mjpg`
  const id = (req.params.id ?? req.params.file ?? "").replace(/\.mjpg$/i, "");
  if (!id) return res.status(400).json({ error: "Falta el id" });

  try {
    const camera = await store.get(id);
    if (!camera) return res.status(404).json({ error: "Camara no encontrada" });

    const gateway = req.app.locals.gateway as
      | { acquire(cameraId: string): void; release(cameraId: string): void }
      | undefined;
    if (!gateway) return res.status(503).json({ error: "Relay no disponible" });

    const BOUNDARY = "frame";
    /** Sin frame nuevo en este tiempo se cierra (el cliente puede reconectar). */
    const STALL_MS = 60_000;
    /** Si no llega nada, se reenvía la última foto para mantener viva la conexión. */
    const KEEPALIVE_MS = 10_000;

    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let closed = false;
    let lastFrameAt = Date.now();
    let lastWriteAt = Date.now();

    const write = (frame: CachedFrame): void => {
      if (closed || res.writableEnded) return;
      res.write(
        `--${BOUNDARY}\r\n` +
          `Content-Type: image/jpeg\r\n` +
          `Content-Length: ${frame.data.length}\r\n` +
          `X-Seq: ${frame.header.seq}\r\n\r\n`,
      );
      res.write(frame.data);
      res.write("\r\n");
      lastWriteAt = Date.now();
    };

    // primer pintado inmediato con lo que haya en caché (no hay que esperar al
    // siguiente frame del agent, que puede tardar mientras FFmpeg arranca).
    const initial = frameCache.get(id);
    if (initial) {
      write(initial);
      lastFrameAt = lastWriteAt;
    }

    const off = frameCache.on(id, (frame) => {
      lastFrameAt = Date.now();
      write(frame);
    });
    gateway.acquire(id);

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(watchdog);
      off();
      gateway.release(id);
    };

    const watchdog = setInterval(() => {
      const now = Date.now();
      if (now - lastFrameAt > STALL_MS) {
        cleanup();
        if (!res.writableEnded) res.end();
        return;
      }
      if (now - lastWriteAt > KEEPALIVE_MS) {
        const cached = frameCache.get(id);
        if (cached) write(cached);
      }
    }, 5_000);

    req.on("close", cleanup);
    res.on("close", cleanup);
    req.on("error", cleanup);
  } catch (error) {
    handleError(res, error, "stream.mjpg");
  }
}

camerasRouter.get("/:id/stream.mjpg", requirePrincipal, principalRateLimit, streamMjpeg);

/** Ruta canónica documentada en F5: `/api/v1/streams/<id>.mjpg`. */
export const streamsRouter = Router();
streamsRouter.get("/:file", requirePrincipal, principalRateLimit, streamMjpeg);

/**
 * Captura un thumbnail AHORA (saltándose el rate limit automático) — F4.
 * Devuelve la URL de Cloudinary o un error accionable si no hay imagen.
 */
camerasRouter.post("/:id/thumbnail", requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: "Falta el id" });
  try {
    const camera = await store.get(id);
    if (!camera) return res.status(404).json({ error: "Camara no encontrada" });

    const outcome = await captureThumb(id, true);
    if (outcome.ok) {
      return res.json({ thumbnail: { url: outcome.url, publicId: outcome.publicId, bytes: outcome.bytes, ageMs: outcome.ageMs } });
    }

    const status =
      outcome.reason === "sin-configurar" ? 503 : outcome.reason === "fallo" ? 502 : outcome.reason === "en-curso" ? 409 : 409;
    return res.status(status).json({
      error: outcome.message ?? "No se pudo generar la thumbnail",
      reason: outcome.reason,
      ageMs: outcome.ageMs,
    });
  } catch (error) {
    handleError(res, error, "capture-thumb");
  }
});

camerasRouter.get("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Falta el id" });
    const camera = await store.get(id);
    if (!camera) return res.status(404).json({ error: "Camara no encontrada" });
    res.json({ camera: toPublicCamera(camera) });
  } catch (error) {
    handleError(res, error, "get");
  }
});

camerasRouter.post("/", requireAuth, async (req, res) => {
  const parsed = CreateCameraSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Payload invalido", issues: parsed.error.issues });
  }
  try {
    const camera = await store.create(parsed.data, res.locals.userId);
    res.status(201).json({ camera: toPublicCamera(camera) });
  } catch (error) {
    handleError(res, error, "create");
  }
});

camerasRouter.delete("/:id", requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Falta el id" });
    const removed = await store.remove(id);
    if (!removed) return res.status(404).json({ error: "Camara no encontrada" });
    res.status(204).end();
  } catch (error) {
    handleError(res, error, "delete");
  }
});
