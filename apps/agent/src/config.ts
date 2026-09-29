import { config as loadDotenv } from "dotenv";
import { findUpEnvFile } from "@cameras/core";

const envFile = findUpEnvFile(process.cwd());
if (envFile) loadDotenv({ path: envFile });

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  agentId: process.env.AGENT_ID ?? "agent-01",
  version: "0.1.0",
  /** URL pública del server (Render en producción). */
  serverUrl: process.env.SERVER_WSS_URL ?? "http://localhost:4000",
  agentToken: process.env.AGENT_TOKEN ?? "",
  /** Token que el agent envía al server (debe coincidir con AGENT_TOKEN del server). */
  agentTokenOut: process.env.AGENT_TOKEN ?? "",
  /** Carpeta local para snapshots / grabaciones (F6-F7). */
  dataDir: process.env.AGENT_DATA_DIR ?? "./data",

  // --- Streaming local (F1) ---
  /** Puerto del servidor MJPEG local (visión desde la LAN). */
  streamPort: toInt(process.env.AGENT_STREAM_PORT, 4100),
  /** Ruta explícita a FFmpeg; si se omite se busca en PATH y winget. */
  ffmpegPath: process.env.FFMPEG_PATH ?? "",
  /** ms entre sincronizaciones de cámara con el server. */
  syncIntervalMs: toInt(process.env.AGENT_SYNC_MS, 15000),
  /** ms sin espectadores antes de apagar una transcodificación. */
  noViewerStopMs: toInt(process.env.AGENT_NO_VIEWER_STOP_MS, 60000),
  /** ms sin frames antes de reiniciar FFmpeg. */
  frameWatchdogMs: toInt(process.env.AGENT_WATCHDOG_MS, 15000),
  /** fps máximos reenviados al server por relay (F3). */
  relayFps: toInt(process.env.RELAY_FPS, 6),
} as const;
