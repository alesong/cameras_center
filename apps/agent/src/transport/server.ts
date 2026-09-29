import { io, type Socket } from "socket.io-client";
import {
  CHANNELS,
  parseServerToAgentMessage,
  type AgentHello,
  type ServerToAgentMessage,
} from "@cameras/protocol";
import { config } from "../config";

export interface ServerTransport {
  socket: Socket;
  emitStatus: (report: unknown) => void;
}

export interface ServerTransportHandlers {
  /** El server pide empezar a reenviar una cámara (hay espectadores remotos). */
  onStartStream?: (cameraId: string, profile: string) => void;
  /** El server dice que paren (ya nadie la mira desde fuera). */
  onStopStream?: (cameraId: string, reason: string) => void;
  /** Al perder la conexión hay que soltar todo el relay. */
  onDisconnect?: () => void;
}

/**
 * Conexión saliente (outbound) hacia el server.
 *
 * El agent nunca abre puertos: sólo sale hacia `SERVER_WSS_URL`.
 * El `auth.token` (AGENT_TOKEN) se valida en el handshake del server.
 */
export function connectToServer(
  getHello: () => Omit<AgentHello, "type">,
  handlers: ServerTransportHandlers = {},
): ServerTransport {
  const socket = io(config.serverUrl, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 15000,
    auth: config.agentTokenOut ? { token: config.agentTokenOut } : undefined,
  });

  socket.on("connect", () => {
    console.log(`[agent] conectado al server ${config.serverUrl}`);
    socket.emit(CHANNELS.agentHello, { type: "agent:hello", ...getHello() } satisfies AgentHello);
  });

  socket.on("connect_error", (error) => {
    console.warn(`[agent] error de conexión: ${error.message}`);
  });

  socket.on("disconnect", (reason) => {
    console.warn(`[agent] desconectado (${reason}). Reintentando...`);
    handlers.onDisconnect?.();
  });

  socket.on(CHANNELS.serverConfigSync, (raw) => {
    const message = raw as ServerToAgentMessage;
    if (message.type === "server:configSync") {
      console.log(`[agent] configSync recibido: ${message.cameras.length} camara(s)`);
    }
  });

  socket.on(CHANNELS.serverStartStream, (raw) => {
    const parsed = parseServerToAgentMessage(raw);
    if (parsed.type !== "server:startStream") return;
    console.log(`[agent] startStream ${parsed.cameraId} (${parsed.profile})`);
    handlers.onStartStream?.(parsed.cameraId, parsed.profile);
  });

  socket.on(CHANNELS.serverStopStream, (raw) => {
    const parsed = parseServerToAgentMessage(raw);
    if (parsed.type !== "server:stopStream") return;
    console.log(`[agent] stopStream ${parsed.cameraId} (${parsed.reason})`);
    handlers.onStopStream?.(parsed.cameraId, parsed.reason);
  });

  return {
    socket,
    emitStatus: (report) => socket.emit(CHANNELS.agentStatus, { type: "agent:status", report }),
  };
}
