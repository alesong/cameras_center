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

/**
 * Conexión saliente (outbound) hacia el server.
 *
 * El agent nunca abre puertos: sólo sale hacia `SERVER_WSS_URL`.
 * F2: se añade `auth: { token }` y el server valida en el handshake.
 */
export function connectToServer(getHello: () => Omit<AgentHello, "type">): ServerTransport {
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

  socket.on("disconnect", (reason) => {
    console.warn(`[agent] desconectado (${reason}). Reintentando...`);
  });

  socket.on(CHANNELS.serverConfigSync, (raw) => {
    // F2: aplicar la configuración de cámaras que viene desde Supabase.
    const message = raw as ServerToAgentMessage;
    if (message.type === "server:configSync") {
      console.log(`[agent] configSync recibido: ${message.cameras.length} camara(s)`);
    }
  });

  socket.on(CHANNELS.serverStartStream, (raw) => {
    const parsed = parseServerToAgentMessage(raw);
    if (parsed.type !== "server:startStream") return;
    // F3: relay hacia el server. En F1 el stream lo sirve el propio agent.
    console.log(`[agent] startStream ${parsed.cameraId} (${parsed.profile})`);
  });

  socket.on(CHANNELS.serverStopStream, (raw) => {
    const parsed = parseServerToAgentMessage(raw);
    if (parsed.type !== "server:stopStream") return;
    console.log(`[agent] stopStream ${parsed.cameraId} (${parsed.reason})`);
  });

  return {
    socket,
    emitStatus: (report) => socket.emit(CHANNELS.agentStatus, { type: "agent:status", report }),
  };
}
