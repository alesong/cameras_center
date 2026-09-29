import { randomUUID } from "node:crypto";
import type { Camera, CreateCameraPayload } from "@cameras/protocol";
import { extractHost } from "@cameras/core";
import { config } from "./config";

/**
 * ALMACÉN EN MEMORIA (F0).
 *
 * Sustituir por Supabase en F2 (`apps/server/src/db/`). La interfaz pública de este
 * módulo no cambia: sólo se reemplaza la implementación interna.
 */
export interface StoredCamera extends Camera {
  /** URL RTSP/MJPEG con credenciales. Se servirá SIEMPRE cifrada en F2. */
  connection: string;
}

const cameras = new Map<string, StoredCamera>();

/** Devuelve el DTO público (sin credenciales). */
export function toPublic(camera: StoredCamera): Camera {
  const { connection: _connection, ...rest } = camera;
  return rest;
}

export const store = {
  list(): StoredCamera[] {
    return [...cameras.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  },

  get(id: string): StoredCamera | undefined {
    return cameras.get(id);
  },

  create(input: CreateCameraPayload): StoredCamera {
    const camera: StoredCamera = {
      id: randomUUID(),
      name: input.name,
      brand: input.brand,
      sourceType: input.sourceType,
      host: input.host || extractHost(input.connection),
      order: input.order,
      active: input.active,
      createdAt: new Date().toISOString(),
      connection: input.connection,
    };
    cameras.set(camera.id, camera);
    return camera;
  },

  remove(id: string): boolean {
    return cameras.delete(id);
  },
};

/** Semilla opcional para desarrollar la UI sin hardware real. */
export function seedDemo(): void {
  if (!config.seedDemo || cameras.size > 0) return;
  store.create({
    name: "Cámara demo",
    brand: "Demo",
    sourceType: "rtsp",
    host: "192.168.1.10",
    connection: "rtsp://admin:demo@192.168.1.10:554/Streaming/Channels/101",
    order: 0,
    active: true,
  });
}
