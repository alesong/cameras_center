import { Router } from "express";
import { CreateCameraSchema } from "@cameras/protocol";
import { store, toPublicCamera } from "../store";
import { requireAuth } from "../middleware/auth";
import { captureThumb, latestThumbnails } from "../thumbs";
import { frameCache } from "../ws/frames";

/**
 * Registro de cámaras.
 *  - Lectura: pública (la UI y los viewers la necesitan sin token).
 *  - Escritura: requiere JWT (F2).
 *  - Persistencia: Supabase si está configurado, si no memoria.
 */
export const camerasRouter = Router();

function handleError(res: import("express").Response, error: unknown, context: string) {
  console.error(`[cameras] ${context}:`, error);
  return res.status(500).json({ error: error instanceof Error ? error.message : "Error interno" });
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
 * Último frame (JPEG) recibido por relay — F3.
 *
 * Sirve de API pública / fallback para quien no pueda abrir WebSocket: no es
 * vídeo, es una foto en el instante de la petición. Requiere JWT porque expone
 * la imagen de la cámara fuera de la LAN.
 */
camerasRouter.get("/:id/frame.jpg", requireAuth, async (req, res) => {
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
 * Se usa como póster estático en la UI; requiere JWT igual que `frame.jpg`.
 */
camerasRouter.get("/thumbnails", requireAuth, async (_req, res) => {
  try {
    res.json({ thumbnails: await latestThumbnails() });
  } catch (error) {
    handleError(res, error, "thumbnails");
  }
});

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
