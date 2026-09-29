import http from "node:http";
import type { MjpegPipeline } from "../pipeline/mjpeg";
import type { PipelineRegistry } from "../pipeline/registry";
import { resolveFfmpegPath } from "../pipeline/ffmpeg";

const BOUNDARY = "ffcamerasboundary";

/**
 * Servidor HTTP local del agent (por defecto :4100).
 *
 *   GET /stream/:id.mjpg   MJPEG multipart/x-mixed-replace (lo consume el navegador)
 *   GET /snapshot/:id.jpg  último frame JPEG
 *   GET /api/status        estado de todos los pipelines
 *   GET /api/health        healthcheck
 *
 * Acceso directo desde la LAN (baja latencia). El acceso remoto pasa por el
 * server en F3, que relaya este mismo flujo.
 */
export function createStreamServer(registry: PipelineRegistry, port: number): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }

    if (url.pathname === "/api/health") {
      json(res, 200, { status: "ok", service: "cameras-center-agent", port, ffmpeg: resolveFfmpegPath() ?? null }, cors);
      return;
    }

    if (url.pathname === "/api/status") {
      json(res, 200, { cameras: registry.statuses() }, cors);
      return;
    }

    const streamMatch = /^\/stream\/([^/]+)\.mjpg$/.exec(url.pathname);
    if (streamMatch) {
      streamMjpeg(res, registry.get(streamMatch[1] as string), cors, req);
      return;
    }

    const snapshotMatch = /^\/snapshot\/([^/]+)\.jpg$/.exec(url.pathname);
    if (snapshotMatch) {
      void sendSnapshot(res, registry.get(snapshotMatch[1] as string), cors);
      return;
    }

    json(res, 404, { error: "Ruta no encontrada", path: url.pathname }, cors);
  });

  return server;
}

function json(res: http.ServerResponse, code: number, body: unknown, cors: Record<string, string>) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors });
  res.end(payload);
}

function streamMjpeg(
  res: http.ServerResponse,
  pipeline: MjpegPipeline | undefined,
  cors: Record<string, string>,
  req: http.IncomingMessage,
) {
  if (!pipeline) {
    json(res, 404, { error: "Camara no encontrada en este agent" }, cors);
    return;
  }

  res.writeHead(200, {
    "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    ...cors,
  });

  const send = (frame: Buffer) => {
    if (res.writableEnded) return;
    res.write(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
    );
    res.write(frame);
    res.write("\r\n");
  };

  const unsubscribe = pipeline.subscribe(send);

  const cleanup = () => {
    unsubscribe();
    if (!res.writableEnded) res.end();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

async function sendSnapshot(
  res: http.ServerResponse,
  pipeline: MjpegPipeline | undefined,
  cors: Record<string, string>,
) {
  if (!pipeline) {
    json(res, 404, { error: "Camara no encontrada en este agent" }, cors);
    return;
  }

  // esperar hasta 4 s a que FFmpeg produzca el primer frame
  if (!pipeline.snapshot()) {
    pipeline.ensureRunning();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !pipeline.snapshot()) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const frame = pipeline.snapshot();
  if (!frame) {
    json(res, 503, { error: "Sin frame disponible", cameraId: pipeline.id, detail: pipeline.status() }, cors);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": frame.length,
    "Cache-Control": "no-store",
    ...cors,
  });
  res.end(frame);
}
