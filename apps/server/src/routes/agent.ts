import { Router } from "express";
import { config } from "../config";
import { store } from "../store";

/**
 * Endpoint interno para el agent (F1).
 *
 * Devuelve las cámaras INCLUYENDO la URL de conexión (credenciales), que es lo
 * que FFmpeg necesita. Por eso vive en una ruta separada de `/api/v1/cameras`.
 *
 * F2: sustituir la comprobación simple de token por autenticación firmada
 * (JWT de agent + rotación) y servir `connection` descifrada desde CAMERA_ENC_KEY.
 */
export const agentRouter = Router();

agentRouter.get("/cameras", (req, res) => {
  const token = req.get("x-agent-token") ?? "";
  if (config.agentToken && token !== config.agentToken) {
    return res.status(401).json({ error: "Token de agent invalido" });
  }

  res.json({
    agentId: "server",
    cameras: store.list().map((camera) => ({ ...camera })),
  });
});
