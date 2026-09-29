import { z } from "zod";
import { CameraSchema, CameraStatusReportSchema, StreamProfileSchema } from "./camera";

/**
 * Protocolo de control (JSON) entre agent <-> server <-> viewer.
 *
 * El plano de MEDIOS (frames de video) NO pasa por aquí: viaja en eventos binarios
 * separados (`stream:frame`) con un header mínimo, para no validar con Zod cada
 * frame que pesa cientos de KB.
 */

// ---------------------------------------------------------------------------
// AGENT -> SERVER
// ---------------------------------------------------------------------------

export const AgentHelloSchema = z.object({
  type: z.literal("agent:hello"),
  agentId: z.string().min(1),
  version: z.string().min(1),
  cameras: z.array(CameraSchema),
  capabilities: z
    .array(z.enum(["rtsp", "onvif", "mjpeg", "record", "test"]))
    .default([]),
});
export type AgentHello = z.infer<typeof AgentHelloSchema>;

export const AgentStatusSchema = z.object({
  type: z.literal("agent:status"),
  report: CameraStatusReportSchema,
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentThumbSchema = z.object({
  type: z.literal("agent:thumb"),
  cameraId: z.string(),
  /** JPEG en base64. El server lo sube a Cloudinary y guarda la URL. */
  jpegBase64: z.string().min(1),
  ts: z.number(),
});
export type AgentThumb = z.infer<typeof AgentThumbSchema>;

export const AgentErrorSchema = z.object({
  type: z.literal("agent:error"),
  cameraId: z.string().optional(),
  message: z.string(),
});
export type AgentError = z.infer<typeof AgentErrorSchema>;

export const AgentMessageSchema = z.discriminatedUnion("type", [
  AgentHelloSchema,
  AgentStatusSchema,
  AgentThumbSchema,
  AgentErrorSchema,
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

// ---------------------------------------------------------------------------
// SERVER -> AGENT
// ---------------------------------------------------------------------------

export const StartStreamSchema = z.object({
  type: z.literal("server:startStream"),
  cameraId: z.string(),
  /** `local` = sin recodificar si es posible; `remote` = 720p/1.5Mbps para Render */
  profile: StreamProfileSchema.default("remote"),
  /** Ids de los espectadores interesados (para referencias / debugging). */
  viewers: z.array(z.string()).default([]),
});
export type StartStream = z.infer<typeof StartStreamSchema>;

export const StopStreamSchema = z.object({
  type: z.literal("server:stopStream"),
  cameraId: z.string(),
  reason: z.enum(["no-viewers", "disabled", "shutdown"]).default("no-viewers"),
});
export type StopStream = z.infer<typeof StopStreamSchema>;

export const ConfigSyncSchema = z.object({
  type: z.literal("server:configSync"),
  cameras: z.array(CameraSchema),
});
export type ConfigSync = z.infer<typeof ConfigSyncSchema>;

export const ServerToAgentMessageSchema = z.discriminatedUnion("type", [
  StartStreamSchema,
  StopStreamSchema,
  ConfigSyncSchema,
]);
export type ServerToAgentMessage = z.infer<typeof ServerToAgentMessageSchema>;

// ---------------------------------------------------------------------------
// VIEWER <-> SERVER
// ---------------------------------------------------------------------------

export const ViewerSubscribeSchema = z.object({
  type: z.literal("viewer:subscribe"),
  cameraId: z.string(),
});
export type ViewerSubscribe = z.infer<typeof ViewerSubscribeSchema>;

export const ViewerUnsubscribeSchema = z.object({
  type: z.literal("viewer:unsubscribe"),
  cameraId: z.string(),
});
export type ViewerUnsubscribe = z.infer<typeof ViewerUnsubscribeSchema>;

export const ViewerMessageSchema = z.discriminatedUnion("type", [
  ViewerSubscribeSchema,
  ViewerUnsubscribeSchema,
]);
export type ViewerMessage = z.infer<typeof ViewerMessageSchema>;

export const StreamMetaSchema = z.object({
  type: z.literal("stream:meta"),
  cameraId: z.string(),
  encoding: z.enum(["mjpeg", "fmp4"]),
  width: z.number().int(),
  height: z.number().int(),
  fps: z.number(),
  contentType: z.string(),
});
export type StreamMeta = z.infer<typeof StreamMetaSchema>;

// ---------------------------------------------------------------------------
// CANALES DE EVENTOS (nombres compartidos)
// ---------------------------------------------------------------------------

export const CHANNELS = {
  agentHello: "agent:hello",
  agentStatus: "agent:status",
  agentThumb: "agent:thumb",
  serverStartStream: "server:startStream",
  serverStopStream: "server:stopStream",
  serverConfigSync: "server:configSync",
  viewerSubscribe: "viewer:subscribe",
  viewerUnsubscribe: "viewer:unsubscribe",
  streamMeta: "stream:meta",
  /** Evento binario: header JSON + payload de video. */
  streamFrame: "stream:frame",
} as const;

/** Header que viaja junto a cada frame binario. */
export const FrameHeaderSchema = z.object({
  cameraId: z.string(),
  seq: z.number().int(),
  ts: z.number(),
  encoding: z.enum(["mjpeg", "fmp4"]),
  /** true si este chunk cierra un frame completo (MJPEG: fin de imagen). */
  keyframe: z.boolean().default(false),
});
export type FrameHeader = z.infer<typeof FrameHeaderSchema>;

// ---------------------------------------------------------------------------
// Helpers de parsing
// ---------------------------------------------------------------------------

export function parseAgentMessage(raw: unknown): AgentMessage {
  return AgentMessageSchema.parse(raw);
}

export function safeParseAgentMessage(raw: unknown) {
  return AgentMessageSchema.safeParse(raw);
}

export function parseServerToAgentMessage(raw: unknown): ServerToAgentMessage {
  return ServerToAgentMessageSchema.parse(raw);
}

export function parseViewerMessage(raw: unknown): ViewerMessage {
  return ViewerMessageSchema.parse(raw);
}

export function safeParseViewerMessage(raw: unknown) {
  return ViewerMessageSchema.safeParse(raw);
}

export function parseStreamMeta(raw: unknown): StreamMeta {
  return StreamMetaSchema.parse(raw);
}
