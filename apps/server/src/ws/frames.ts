import type { FrameHeader } from "@cameras/protocol";

export interface CachedFrame {
  header: FrameHeader;
  data: Buffer;
  receivedAt: number;
}

/**
 * Último frame recibido de cada cámara.
 *
 * No es vídeo: es un caché de UNA imagen JPEG para
 *   - `GET /api/v1/cameras/:id/frame.jpg` (API pública / fallback sin WS)
 *   - miniaturas y tests
 * El video en vivo pasa por el relay WS y no se almacena nunca aquí.
 */
class FrameCache {
  private frames = new Map<string, CachedFrame>();
  /** Máx. cámaras cacheadas (una foto por cámara, ~100 KB c/u). */
  private limit = 64;

  set(cameraId: string, header: FrameHeader, data: Buffer): void {
    if (this.frames.size >= this.limit && !this.frames.has(cameraId)) {
      // descartar la más vieja
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [key, frame] of this.frames) {
        if (frame.receivedAt < oldest) {
          oldest = frame.receivedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) this.frames.delete(oldestKey);
    }
    this.frames.set(cameraId, { header, data, receivedAt: Date.now() });
  }

  get(cameraId: string): CachedFrame | undefined {
    return this.frames.get(cameraId);
  }

  /** Nº de cámaras con frame cacheado (para el health). */
  size(): number {
    return this.frames.size;
  }

  delete(cameraId: string): void {
    this.frames.delete(cameraId);
  }

  /** ms desde el último frame, o null si no hay. */
  age(cameraId: string): number | null {
    const frame = this.frames.get(cameraId);
    return frame ? Date.now() - frame.receivedAt : null;
  }

  clear(): void {
    this.frames.clear();
  }
}

export const frameCache = new FrameCache();
