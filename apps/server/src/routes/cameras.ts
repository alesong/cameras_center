import { Router } from "express";
import { CreateCameraSchema } from "@cameras/protocol";
import { store, toPublic } from "../store";

/**
 * Registro de cámaras. F0: memoria.
 * F2: Supabase (tabla `cameras`, `connection` cifrada con CAMERA_ENC_KEY).
 */
export const camerasRouter = Router();

camerasRouter.get("/", (_req, res) => {
  res.json({ cameras: store.list().map(toPublic) });
});

camerasRouter.get("/:id", (req, res) => {
  const camera = store.get(req.params.id);
  if (!camera) return res.status(404).json({ error: "Camara no encontrada" });
  res.json({ camera: toPublic(camera) });
});

camerasRouter.post("/", (req, res) => {
  const parsed = CreateCameraSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Payload invalido", issues: parsed.error.issues });
  }
  const camera = store.create(parsed.data);
  res.status(201).json({ camera: toPublic(camera) });
});

camerasRouter.delete("/:id", (req, res) => {
  if (!store.remove(req.params.id)) {
    return res.status(404).json({ error: "Camara no encontrada" });
  }
  res.status(204).end();
});
