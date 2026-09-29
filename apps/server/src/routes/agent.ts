import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config";
import { store } from "../store";

/**
 * Endpoint interno para el agent (F1/F2).
 *
 * Devuelve las cámaras INCLUYENDO la URL de conexión (credenciales), que es lo
 * que FFmpeg necesita. Por eso vive en una ruta separada de `/api/v1/cameras`.
 *
 * Autenticación: cabecera `x-agent-token` comparada en tiempo constante con
 * `AGENT_TOKEN`. F3: sustituir por JWT de agent con rotación.
 */
export const agentRouter = Router();

function tokenMatches(provided: string, expected: string): boolean {
  if (!expected) return true; // sin token configurado (sólo desarrollo)
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

agentRouter.get("/cameras", async (req, res) => {
  const token = req.get("x-agent-token") ?? "";
  if (!tokenMatches(token, config.agentToken)) {
    return res.status(401).json({ error: "Token de agent invalido" });
  }

  try {
    const cameras = await store.list();
    res.json({
      agentId: "server",
      backend: store.backend,
      // el store ya devuelve `connection`; el agent la necesita para FFmpeg
      cameras,
    });
  } catch (error) {
    console.error("[agent] list:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Error interno" });
  }
});
