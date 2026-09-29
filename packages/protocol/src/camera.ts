import { z } from "zod";

/** Tipos de origen soportados por una cámara. */
export const CameraSourceTypeSchema = z.enum([
  "rtsp",
  "mjpeg",
  "onvif",
  /** Fuente sintética (lavfi `testsrc`) para desarrollo sin cámara real. */
  "test",
]);
export type CameraSourceType = z.infer<typeof CameraSourceTypeSchema>;

export const CameraStatusSchema = z.enum(["unknown", "starting", "online", "offline", "error"]);
export type CameraStatus = z.infer<typeof CameraStatusSchema>;

/**
 * DTO público de una cámara. Nunca incluye `connection`
 * (la URL RTSP lleva credenciales y se guarda cifrada).
 */
export const CameraSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  brand: z.string().max(40).nullable(),
  sourceType: CameraSourceTypeSchema,
  host: z.string().min(1).max(255),
  order: z.number().int().min(0),
  active: z.boolean(),
  createdAt: z.string().datetime(),
});
export type Camera = z.infer<typeof CameraSchema>;

/** Payload para crear una cámara. `connection` es la URL RTSP/MJPEG en claro. */
export const CreateCameraSchema = z.object({
  name: z.string().min(1).max(80),
  brand: z.string().max(40).nullable().default(null),
  sourceType: CameraSourceTypeSchema.default("rtsp"),
  /** Si se omite se deriva de la URL de conexión. */
  host: z.string().max(255).default(""),
  connection: z.string().min(8).max(1024),
  order: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});
export type CreateCameraInput = z.input<typeof CreateCameraSchema>;
export type CreateCameraPayload = z.output<typeof CreateCameraSchema>;

/** Reporte de salud que emite el agent para cada cámara. */
export const CameraStatusReportSchema = z.object({
  cameraId: z.string(),
  status: CameraStatusSchema,
  online: z.boolean(),
  fps: z.number().nullable(),
  bitrateKbps: z.number().nullable(),
  lastSeen: z.number(),
});
export type CameraStatusReport = z.infer<typeof CameraStatusReportSchema>;

/** Perfil de transcodificación solicitado. */
export const StreamProfileSchema = z.enum(["local", "remote"]);
export type StreamProfile = z.infer<typeof StreamProfileSchema>;

export const API = {
  health: "/api/health",
  cameras: "/api/v1/cameras",
  camera: (id: string) => `/api/v1/cameras/${id}`,
  stream: (id: string) => `/api/v1/streams/${id}.mjpg`,
} as const;
