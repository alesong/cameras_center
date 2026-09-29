import { CHANNELS, type FrameHeader } from "@cameras/protocol";
import type { Socket } from "socket.io-client";
import { config } from "./config";
import type { PipelineRegistry } from "./pipeline/registry";

/**
 * Relay de video agent → server (F3).
 *
 * El server nos dice `server:startStream` cuando alguien se suscribe desde
 * fuera; nosotros nos suscribimos al pipeline (eso arranca FFmpeg on-demand) y
 * reenviamos cada JPEG por el canal binario `stream:frame`.
 *
 * Reglas:
 *  - sólo hay relay mientras el server tenga espectadores;
 *  - se limita la tasa (`RELAY_FPS`) para no saturar la subida de la LAN ni
 *    el ancho de banda de Render;
 *  - si no hay conexión, se descarta el frame (no se acumula memoria);
 *  - las credenciales jamás se loguean.
 */
export class RelayController {
  private attached = new Map<string, () => void>();
  private seq = new Map<string, number>();
  private lastSentAt = new Map<string, number>();
  private sentFrames = 0;
  private droppedFrames = 0;

  constructor(
    private registry: PipelineRegistry,
    private getSocket: () => Socket | null,
  ) {}

  attach(cameraId: string): void {
    if (this.attached.has(cameraId)) return;

    const pipeline = this.registry.get(cameraId);
    if (!pipeline) {
      console.warn(`[relay] ✗ cámara desconocida para este agent: ${cameraId}`);
      return;
    }

    const unsubscribe = pipeline.subscribe((frame) => this.onFrame(cameraId, frame));
    this.attached.set(cameraId, unsubscribe);
    console.log(`[relay] ▶ ${cameraId} → server (${config.relayFps} fps máx.)`);
  }

  detach(cameraId: string, reason = "no-viewers"): void {
    const unsubscribe = this.attached.get(cameraId);
    if (!unsubscribe) return;
    unsubscribe();
    this.attached.delete(cameraId);
    this.seq.delete(cameraId);
    this.lastSentAt.delete(cameraId);
    console.log(`[relay] ⏹ ${cameraId} (${reason})`);
  }

  detachAll(reason: string): void {
    for (const cameraId of [...this.attached.keys()]) this.detach(cameraId, reason);
  }

  attachedIds(): string[] {
    return [...this.attached.keys()];
  }

  stats() {
    return {
      cameras: this.attachedIds().length,
      sent: this.sentFrames,
      dropped: this.droppedFrames,
    };
  }

  private onFrame(cameraId: string, frame: Buffer): void {
    const socket = this.getSocket();
    if (!socket?.connected) {
      this.droppedFrames += 1;
      return;
    }

    const now = Date.now();
    const interval = 1000 / config.relayFps;
    if (now - (this.lastSentAt.get(cameraId) ?? 0) < interval) {
      this.droppedFrames += 1;
      return;
    }

    const seq = (this.seq.get(cameraId) ?? 0) + 1;
    this.seq.set(cameraId, seq);
    this.lastSentAt.set(cameraId, now);

    const header: FrameHeader = {
      cameraId,
      seq,
      ts: now,
      encoding: "mjpeg",
      keyframe: true,
    };

    socket.volatile.emit(CHANNELS.streamFrame, header, frame);
    this.sentFrames += 1;
  }
}
