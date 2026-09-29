import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { CHANNELS, safeParseViewerMessage, type StreamProfile } from "@cameras/protocol";
import { config } from "../config";

export interface StreamRequest {
  cameraId: string;
  profile: StreamProfile;
  viewers: string[];
}

export interface Gateway {
  io: Server;
  /** Nº de espectadores suscritos a una cámara. */
  viewerCount(cameraId: string): number;
  /** Se dispara cuando alguien empieza a mirar una cámara. */
  onStreamRequest(cb: (request: StreamRequest) => void): void;
  onStreamRelease(cb: (cameraId: string) => void): void;
  /** Difunda el estado de una cámara a todos los espectadores. */
  broadcastStatus(cameraId: string, status: string): void;
}

const AGENT_ROOM = "agents";
const cameraRoom = (cameraId: string) => `cam:${cameraId}`;

/**
 * Gateway WebSocket.
 *
 * F0: maneja suscripciones de viewers y expone los contadores de espectadores.
 * F3: añadir relay de frames (agent -> server -> viewers) y auth por token/API key.
 */
export function createGateway(httpServer: HttpServer): Gateway {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
    maxHttpBufferSize: 1e6,
  });

  const streamRequestCbs: Array<(request: StreamRequest) => void> = [];
  const streamReleaseCbs: Array<(cameraId: string) => void> = [];

  const viewerCount = (cameraId: string) => io.sockets.adapter.rooms.get(cameraRoom(cameraId))?.size ?? 0;

  const emitStreamRequest = (socket: Socket, cameraId: string, profile: StreamProfile) => {
    const viewers = [...(io.sockets.adapter.rooms.get(cameraRoom(cameraId)) ?? [])];
    for (const cb of streamRequestCbs) cb({ cameraId, profile, viewers });
    void socket;
  };

  io.on("connection", (socket) => {
    // --- Agentes (F2: validar AGENT_TOKEN en `auth`) -----------------------
    socket.on(CHANNELS.agentHello, (payload) => {
      socket.join(AGENT_ROOM);
      socket.data.agentId = payload?.agentId ?? "unknown";
      io.emit(CHANNELS.agentHello, payload);
    });

    socket.on(CHANNELS.agentStatus, (payload) => {
      socket.to(AGENT_ROOM).emit(CHANNELS.agentStatus, payload);
      // Reenviar también a los espectadores de esa cámara
      if (payload?.report?.cameraId) {
        io.to(cameraRoom(payload.report.cameraId)).emit(CHANNELS.agentStatus, payload);
      }
    });

    // --- Viewers -----------------------------------------------------------
    socket.on(CHANNELS.viewerSubscribe, (raw, ack?: (r: { ok: boolean }) => void) => {
      const parsed = safeParseViewerMessage({ ...(raw as object), type: "viewer:subscribe" });
      if (!parsed.success) return ack?.({ ok: false });

      const { cameraId } = parsed.data;
      const wasEmpty = viewerCount(cameraId) === 0;
      socket.join(cameraRoom(cameraId));
      socket.data.subscriptions = [...new Set([...(socket.data.subscriptions ?? []), cameraId])];

      if (wasEmpty) emitStreamRequest(socket, cameraId, "remote");
      ack?.({ ok: true });
    });

    socket.on(CHANNELS.viewerUnsubscribe, (raw, ack?: (r: { ok: boolean }) => void) => {
      const parsed = safeParseViewerMessage({ ...(raw as object), type: "viewer:unsubscribe" });
      if (!parsed.success) return ack?.({ ok: false });

      const { cameraId } = parsed.data;
      socket.leave(cameraRoom(cameraId));
      if (viewerCount(cameraId) === 0) {
        for (const cb of streamReleaseCbs) cb(cameraId);
      }
      ack?.({ ok: true });
    });

    socket.on("disconnect", () => {
      for (const cameraId of socket.data.subscriptions ?? []) {
        if (viewerCount(cameraId) === 0) {
          for (const cb of streamReleaseCbs) cb(cameraId);
        }
      }
    });
  });

  return {
    io,
    viewerCount,
    onStreamRequest: (cb) => streamRequestCbs.push(cb),
    onStreamRelease: (cb) => streamReleaseCbs.push(cb),
    broadcastStatus: (cameraId, status) => {
      io.to(cameraRoom(cameraId)).emit(CHANNELS.agentStatus, { report: { cameraId, status } });
    },
  };
}
