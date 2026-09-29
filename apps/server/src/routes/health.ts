import { Router } from "express";
import { API } from "@cameras/protocol";
import { config, hasSupabase } from "../config";
import { store } from "../store";
import { authInfo } from "../db/users";

export const healthRouter = Router();

healthRouter.get(API.health, async (_req, res) => {
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
    },
    auth: authInfo(),
    integrations: {
      cloudinary: process.env.CLOUDINARY_URL ? "configured" : "pending (F4)",
    },
  });
});
