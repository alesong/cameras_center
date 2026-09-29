import type { Camera } from "@cameras/protocol";
import { MjpegPipeline, type PipelineStatus } from "./mjpeg";
import type { SourceSpec } from "./args";

/** Cámara tal y como la entrega el server al agent (incluye la URL de conexión). */
export interface AgentCamera extends Camera {
  connection: string;
}

/**
 * Conjunto de pipelines activos. Sincronizado con el server (`/api/agent/cameras`).
 * Una cámara eliminada o desactivada se apaga y se descarta.
 */
export class PipelineRegistry {
  private pipelines = new Map<string, MjpegPipeline>();
  private cameras: AgentCamera[] = [];

  sync(cameras: AgentCamera[]): void {
    this.cameras = cameras;
    const wanted = new Set(cameras.filter((c) => c.active).map((c) => c.id));

    // eliminar las que ya no existen
    for (const [id, pipeline] of this.pipelines) {
      if (!wanted.has(id)) {
        pipeline.stop();
        this.pipelines.delete(id);
      }
    }

    for (const camera of cameras) {
      if (!camera.active) continue;
      const spec: SourceSpec = {
        cameraId: camera.id,
        sourceType: camera.sourceType,
        connection: camera.connection,
      };
      const existing = this.pipelines.get(camera.id);
      if (existing) {
        existing.updateSpec(spec);
      } else {
        this.pipelines.set(camera.id, new MjpegPipeline(spec));
      }
    }
  }

  get(cameraId: string): MjpegPipeline | undefined {
    return this.pipelines.get(cameraId);
  }

  all(): MjpegPipeline[] {
    return [...this.pipelines.values()];
  }

  listCameras(): AgentCamera[] {
    return this.cameras;
  }

  statuses(): PipelineStatus[] {
    return this.all().map((p) => p.status());
  }

  stopAll(): void {
    for (const pipeline of this.pipelines.values()) pipeline.stop();
    this.pipelines.clear();
  }
}
