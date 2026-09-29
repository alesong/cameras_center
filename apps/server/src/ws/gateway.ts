import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import {
  CHANNELS,
  safeParseFrameHeader,
  safeParseViewerMessage,
  type StreamProfile,
} from "@cameras/protocol";
import { verifyToken } from "../auth/jwt";
import { config } from "../config";
import { frameCache } from "./frames";

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

/** Frames enviados a un espectador que aún no ha confirmado (antimancha). */
const MAX_INFLIGHT = 4;
/** Si un espectador no confirma en este tiempo, se le vuelve a permitir. */
const INFLIGHT_STALE_MS = 5000;

/**
 * Gateway WebSocket — F3 (relay de video).
 *
 *   agent ──stream:frame──► server ──stream:frame──► viewers (sala cam:<id>)
 *
 * - El plano de **control** (subscribe/startStream) es JSON y se valida con Zod.
 * - El plano de **medios** binario NO se valida: sólo se comprueba el header.
 * - Autenticación en el handshake: `auth.token` = AGENT_TOKEN (agent) o JWT (viewer).
 * - Si no hay espectadores no se reenvía nada (el caché sólo guarda 1 JPEG).
 */
export function createGateway(httpServer: HttpServer): Gateway {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
    maxHttpBufferSize: 2e6, // un JPEG de 1280px anda por 60-150 KB
  });

  const streamRequestCbs: Array<(request: StreamRequest) => void> = [];
  const streamReleaseCbs: Array<(cameraId: string) => void> = [];

  const viewerCount = (cameraId: string) => io.sockets.adapter.rooms.get(cameraRoom(cameraId))?.size ?? 0;

  const requestStream = (cameraId: string, profile: StreamProfile = "remote") => {
    const viewers = [...(io.sockets.adapter.rooms.get(cameraRoom(cameraId)) ?? [])];
    if (viewers.length === 0) return;
    io.to(AGENT_ROOM).emit(CHANNELS.serverStartStream, {
      type: "server:startStream",
      cameraId,
      profile,
      viewers,
    });
    for (const cb of streamRequestCbs) cb({ cameraId, profile, viewers });
  };

  const releaseStream = (cameraId: string, reason: "no-viewers" | "disabled" | "shutdown" = "no-viewers") => {
    io.to(AGENT_ROOM).emit(CHANNELS.serverStopStream, { type: "server:stopStream", cameraId, reason });
    for (const cb of streamReleaseCbs) cb(cameraId);
  };

  /** Repetir el pedido a un agent que (re)conecta: si hay espectadores, que arranque. */
  const rearmStreams = () => {
    for (const [room, sockets] of io.sockets.adapter.rooms) {
      if (!room.startsWith("cam:") || sockets.size === 0) continue;
      requestStream(room.slice("cam:".length));
    }
  };

  // --- Autenticación en el handshake ---------------------------------------
  io.use(async (socket, next) => {
    const token = String(socket.handshake.auth?.token ?? "");
    if (config.agentToken && token === config.agentToken) {
      socket.data.role = "agent";
      return next();
    }
    if (!config.agentToken && !token) {
      socket.data.role = "agent"; // sólo desarrollo sin AGENT_TOKEN
      return next();
    }
    try {
      const payload = await verifyToken(token);
      socket.data.role = "viewer";
      socket.data.userId = payload.sub;
      return next();
    } catch {
      return next(new Error("no-autorizado"));
    }
  });

  io.on("connection", (socket) => {
    // --- Agentes ------------------------------------------------------------
    socket.on(CHANNELS.agentHello, (payload) => {
      socket.join(AGENT_ROOM);
      socket.data.agentId = payload?.agentId ?? "unknown";
      socket.data.role = "agent";
      io.emit(CHANNELS.agentHello, payload);
      // Si alguien ya está mirando cuando (re)conecta el agent, pedirle el stream
      rearmStreams();
    });

    socket.on(CHANNELS.agentStatus, (payload) => {
      socket.to(AGENT_ROOM).emit(CHANNELS.agentStatus, payload);
      if (payload?.report?.cameraId) {
        io.to(cameraRoom(payload.report.cameraId)).emit(CHANNELS.agentStatus, payload);
      }
    });

    // --- Plano de medios: agent -> server -> viewers ------------------------
    socket.on(CHANNELS.streamFrame, (rawHeader: unknown, rawPayload: unknown) => {
      if (socket.data.role !== "agent") return;

      const header = safeParseFrameHeader(rawHeader);
      if (!header.success) return;

      const data = toBuffer(rawPayload);
      if (!data || data.length === 0) return;

      const { cameraId } = header.data;
      frameCache.set(cameraId, header.data, data);

      const room = io.sockets.adapter.rooms.get(cameraRoom(cameraId));
      if (!room || room.size === 0) return; // sin espectadores: no reenviar

      const now = Date.now();
      for (const viewerId of room) {
        const viewer = io.sockets.sockets.get(viewerId);
        if (!viewer) continue;

        // Control de backpressure: si el espectador va lento, saltamos frames
        // en vez de encolarlos (una cámara a 6 fps recupera sin problemas).
        const pending = Number(viewer.data.pendingFrames ?? 0);
        const lastAck = Number(viewer.data.lastFrameAck ?? 0);
        if (pending >= MAX_INFLIGHT) {
          if (now - lastAck < INFLIGHT_STALE_MS) continue;
          viewer.data.pendingFrames = 0; // cliente atascado: liberar
        }
        viewer.data.pendingFrames = Number(viewer.data.pendingFrames ?? 0) + 1;
        viewer.data.lastFrameAck = now;
        viewer.emit(CHANNELS.streamFrame, header.data, data, () => {
          viewer.data.pendingFrames = Math.max(0, Number(viewer.data.pendingFrames ?? 1) - 1);
          viewer.data.lastFrameAck = Date.now();
        });
      }
    });

    // --- Viewers ------------------------------------------------------------
    socket.on(CHANNELS.viewerSubscribe, (raw, ack?: (r: { ok: boolean }) => void) => {
      if (socket.data.role !== "viewer") return ack?.({ ok: false });
      const parsed = safeParseViewerMessage({ ...(raw as object), type: "viewer:subscribe" });
      if (!parsed.success) return ack?.({ ok: false });

      const { cameraId } = parsed.data;
      const wasEmpty = viewerCount(cameraId) === 0;
      socket.join(cameraRoom(cameraId));
      socket.data.subscriptions = [...new Set([...(socket.data.subscriptions ?? []), cameraId])];

      if (wasEmpty) requestStream(cameraId, "remote");
      // devolver el último frame cacheado para que no haya pantalla negra.
      // seq=-1 marca que es una imagen de "puesta al día" y no un frame en vivo.
      const cached = frameCache.get(cameraId);
      if (cached) socket.emit(CHANNELS.streamFrame, { ...cached.header, seq: -1 }, cached.data);
      ack?.({ ok: true });
    });

    socket.on(CHANNELS.viewerUnsubscribe, (raw, ack?: (r: { ok: boolean }) => void) => {
      const parsed = safeParseViewerMessage({ ...(raw as object), type: "viewer:unsubscribe" });
      if (!parsed.success) return ack?.({ ok: false });

      const { cameraId } = parsed.data;
      socket.leave(cameraRoom(cameraId));
      socket.data.subscriptions = (socket.data.subscriptions ?? []).filter((id: string) => id !== cameraId);
      if (viewerCount(cameraId) === 0) releaseStream(cameraId);
      ack?.({ ok: true });
    });

    socket.on("disconnect", () => {
      for (const cameraId of socket.data.subscriptions ?? []) {
        if (viewerCount(cameraId) === 0) releaseStream(cameraId);
      }
      socket.data.subscriptions = [];
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

function toBuffer(payload: unknown): Buffer | null {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (ArrayBuffer.isView(payload)) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (Array.isArray(payload)) return Buffer.from(payload);
  return null;
}
