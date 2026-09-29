import { Router } from "express";
import { API } from "@cameras/protocol";
import { config, hasSupabase } from "../config";

export const healthRouter = Router();

healthRouter.get(API.health, (_req, res) => {
  res.json({
    status: "ok",
    service: "cameras-center-server",
    version: config.version,
    env: config.nodeEnv,
    time: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    integrations: {
      supabase: hasSupabase ? "configured" : "pending (F2)",
      cloudinary: process.env.CLOUDINARY_URL ? "configured" : "pending (F4)",
    },
  });
});
