import { io, type Socket } from "socket.io-client";
import { CHANNELS, type FrameHeader } from "@cameras/protocol";
import { getToken } from "./api";

type FrameListener = (blob: Blob) => void;

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? "http://localhost:4000";

let socket: Socket | null = null;
const listeners = new Map<string, Set<FrameListener>>();
const subscribed = new Set<string>();

function ensureSocket(): Socket {
  if (socket) return socket;

  socket = io(SERVER_URL, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 1500,
    reconnectionDelayMax: 10000,
    // JWT de F2; el server lo valida en el handshake y rechaza si no vale.
    auth: (cb) => cb({ token: getToken() ?? "" }),
  });

  socket.on("connect_error", (error) => {
    console.warn(`[relay] error de conexión: ${error.message}`);
  });

  socket.on("connect", () => {
    // al (re)conectar hay que volver a pedir las cámaras que ya estábamos mirando
    for (const cameraId of subscribed) emitSubscribe(cameraId);
  });

  socket.on(CHANNELS.streamFrame, (header: Partial<FrameHeader>, payload: unknown, ack?: () => void) => {
    const cameraId = header?.cameraId;
    const set = cameraId ? listeners.get(cameraId) : undefined;
    if (set && set.size > 0) {
      const bytes = toBytes(payload);
      if (bytes.byteLength > 0) {
        // TS 5.7 tipa `Uint8Array<ArrayBufferLike>` y `BlobPart` exige `ArrayBuffer`:
        // en runtime aquí siempre llega un ArrayBuffer normal del socket.
        const blob = new Blob([bytes as unknown as BlobPart], { type: "image/jpeg" });
        for (const listener of set) {
          try {
            listener(blob);
          } catch {
            // un suscriptor roto no debe tumbar el resto
          }
        }
      }
    }
    // confirmar al server: así sabe que vamos bien y no nos satura (backpressure)
    if (typeof ack === "function") ack();
  });

  return socket;
}

function emitSubscribe(cameraId: string): void {
  const s = ensureSocket();
  if (s.connected) {
    s.emit(CHANNELS.viewerSubscribe, { type: "viewer:subscribe", cameraId }, () => undefined);
  }
}

function emitUnsubscribe(cameraId: string): void {
  if (!socket?.connected) return;
  socket.emit(CHANNELS.viewerUnsubscribe, { type: "viewer:unsubscribe", cameraId }, () => undefined);
}

/**
 * Suscribirse al relay de una cámara.
 * Devuelve una función de baja que además envía `viewer:unsubscribe`, lo que
 * hace que el server pare de reenviar y el agent apague FFmpeg.
 */
export function subscribeFrame(cameraId: string, listener: FrameListener): () => void {
  const s = ensureSocket();
  let set = listeners.get(cameraId);
  const first = !set || set.size === 0;
  if (!set) {
    set = new Set();
    listeners.set(cameraId, set);
  }
  set.add(listener);

  if (first) {
    subscribed.add(cameraId);
    emitSubscribe(cameraId);
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = listeners.get(cameraId);
    current?.delete(listener);
    if (current && current.size === 0) {
      listeners.delete(cameraId);
      subscribed.delete(cameraId);
      emitUnsubscribe(cameraId);
    }
    void s;
  };
}

export function relayStats() {
  return { cameras: subscribed.size, connected: socket?.connected ?? false, url: SERVER_URL };
}

function toBytes(payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (Array.isArray(payload)) return Uint8Array.from(payload);
  if (payload && typeof payload === "object") {
    const maybe = payload as { type?: string; data?: number[] };
    if (maybe.type === "Buffer" && Array.isArray(maybe.data)) return Uint8Array.from(maybe.data);
  }
  return new Uint8Array(0);
}
