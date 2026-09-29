import { Router } from "express";
import { API } from "@cameras/protocol";
import { config, hasSupabase } from "../config";
import { store } from "../store";
import { authInfo } from "../db/users";
import { getSchemaStatus } from "../db/supabase";
import { cloudinaryStatus, thumbCount, thumbStats } from "../thumbs";
import { frameCache } from "../ws/frames";
import type { GatewayStats } from "../ws/gateway";

export const healthRouter = Router();

healthRouter.get(API.health, async (req, res) => {
  const gateway = req.app.locals.gateway as { stats?: () => GatewayStats } | undefined;
  const gw = gateway?.stats?.();

  res.json({
    status: "ok",
    service: "cameras-center-server",
    version: config.version,
    env: config.nodeEnv,
    time: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    storage: {
      cameras: store.backend,
      supabase: hasSupabase ? "configured" : "pending (pega SUPABASE_SERVICE_KEY)",
      schema: hasSupabase
        ? (getSchemaStatus()?.ok === false
            ? `faltan: ${getSchemaStatus()?.missing.join(", ")}`
            : getSchemaStatus()?.ok
              ? "ok"
              : "sin verificar")
        : "n/a (memoria)",
    },
    auth: authInfo(),
    // F3: conexiones WebSocket vivas
    ws: gw ?? { connected: 0, agents: 0, viewers: 0, cameras: [] },
    // F3: últimas imágenes recibidas (1 por cámara, sirve /frame.jpg)
    frames: { cachedCameras: frameCache.size() },
    // F4: miniaturas en Cloudinary
    cloudinary: {
      ...cloudinaryStatus(),
      status: thumbStats.uploads > 0 || (await thumbCount()) > 0 ? "ok" : "sin subidas aún",
      uploads: thumbStats.uploads,
      failures: thumbStats.failures,
      thumbnails: await thumbCount(),
      lastOkAt: thumbStats.lastOkAt ? new Date(thumbStats.lastOkAt).toISOString() : null,
      lastError: thumbStats.lastError,
    },
    integrations: {
      cloudinary: cloudinaryStatus().configured ? "configured" : "pending (define CLOUDINARY_URL)",
    },
  });
});
