import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { CameraStatus } from "@cameras/protocol";
import { redactSecrets, redactUrl } from "@cameras/core";
import { config } from "../config";
import { buildFfmpegArgs, type SourceSpec } from "./args";
import { resolveFfmpegPath } from "./ffmpeg";

type FfmpegProcess = ChildProcessByStdio<null, Readable, Readable>;

const SOI = Buffer.from([0xff, 0xd8, 0xff]);
const EOI = Buffer.from([0xff, 0xd9]);
const MAX_BUFFER = 8 * 1024 * 1024;

export type PipelineState = "stopped" | "starting" | "running" | "restarting" | "error";

export interface PipelineStatus {
  cameraId: string;
  state: PipelineState;
  online: boolean;
  fps: number;
  bitrateKbps: number;
  lastFrameAt: number | null;
  viewers: number;
  frames: number;
  error?: string;
}

type FrameListener = (frame: Buffer) => void;

/**
 * Transcodificación de una cámara a MJPEG, arrancada on-demand.
 *
 * Ciclo de vida:
 *   subscribe()  -> arranca FFmpeg si no estaba corriendo
 *   unsubscribe() -> al llegar a 0 espectadores, se apaga tras `noViewerStopMs`
 *   watchdog      -> sin frames durante `frameWatchdogMs` => reinicio con backoff
 */
export class MjpegPipeline {
  private proc: FfmpegProcess | null = null;
  private spec: SourceSpec;
  private state: PipelineState = "stopped";
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private latestFrame: Buffer<ArrayBufferLike> | null = null;
  private listeners = new Set<FrameListener>();
  private viewerCount = 0;
  private stopTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private metricsTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private lastFrameAt: number | null = null;
  private frames = 0;
  private fps = 0;
  private bitrateKbps = 0;
  private framesInWindow = 0;
  private bytesInWindow = 0;
  private restartAttempts = 0;
  private lastError?: string;
  private stopped = false;

  constructor(spec: SourceSpec) {
    this.spec = spec;
  }

  get id() {
    return this.spec.cameraId;
  }

  updateSpec(spec: SourceSpec) {
    const changed = spec.connection !== this.spec.connection || spec.sourceType !== this.spec.sourceType;
    this.spec = spec;
    if (changed && (this.state === "running" || this.state === "starting")) {
      // Reiniciar para aplicar la nueva URL (p.ej. credenciales corregidas)
      this.restart();
    }
  }

  // ---------------------------------------------------------------------------
  // Espectadores (on-demand)
  // ---------------------------------------------------------------------------

  subscribe(listener: FrameListener): () => void {
    this.viewerCount += 1;
    this.listeners.add(listener);
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.state === "stopped" || this.state === "error") this.start();
    if (this.latestFrame) listener(this.latestFrame);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
      this.viewerCount = Math.max(0, this.viewerCount - 1);
      if (this.viewerCount === 0) this.scheduleStop();
    };
  }

  /**
   * Arranca si no está corriendo y programa el apagado si nadie lo está mirando.
   * Usado por los snapshots: no debe dejar FFmpeg encendido indefinidamente.
   */
  ensureRunning(): void {
    if (this.state === "stopped" || this.state === "error") this.start();
    this.scheduleStop();
  }

  private scheduleStop() {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (this.viewerCount === 0) this.stop();
    }, config.noViewerStopMs);
  }

  // ---------------------------------------------------------------------------
  // Proceso FFmpeg
  // ---------------------------------------------------------------------------

  start() {
    if (this.proc || this.state === "starting") return;
    const bin = resolveFfmpegPath();
    if (!bin) {
      this.state = "error";
      this.lastError = "FFmpeg no disponible";
      return;
    }

    const args = buildFfmpegArgs(this.spec);
    this.state = "starting";
    this.stopped = false;

    let proc: FfmpegProcess;
    try {
      proc = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      this.state = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      return;
    }
    this.proc = proc;

    let stderrTail = "";
    proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });

    proc.on("error", (error) => {
      this.lastError = error.message;
      this.cleanup();
      this.scheduleRestart();
    });

    proc.on("close", (code, signal) => {
      if (this.stopped) return;
      this.lastError = `FFmpeg terminó (code=${code ?? "?"} signal=${signal ?? "-"}) ${stderrTail.trim()}`.trim();
      this.cleanup();
      this.scheduleRestart();
    });

    this.startWatchdog();
    console.log(`[pipeline] ▶ ${this.spec.cameraId} ${this.spec.sourceType} (${redactUrl(this.spec.connection).slice(0, 60)})`);
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.cleanup();
    this.state = "stopped";
    this.latestFrame = null;
    console.log(`[pipeline] ⏹ ${this.spec.cameraId}`);
  }

  private restart() {
    this.stopped = true;
    this.cleanup();
    this.stopped = false;
    this.start();
  }

  private cleanup() {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.stopWatchdog();
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.metricsTimer = null;
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      proc.stdout.removeAllListeners();
      proc.stderr.removeAllListeners();
      proc.removeAllListeners();
      proc.kill("SIGKILL");
    }
    this.buffer = Buffer.alloc(0);
  }

  private scheduleRestart() {
    if (this.restartTimer || this.stopped) return;
    const delay = Math.min(30000, 500 * 2 ** Math.min(this.restartAttempts, 6));
    this.restartAttempts += 1;
    this.state = this.restartAttempts > 5 ? "error" : "restarting";
    console.warn(`[pipeline] ↻ reinicio en ${delay} ms — ${redactSecrets(this.lastError ?? "")}`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.proc = null;
      if (this.viewerCount > 0 || this.state !== "error") this.start();
    }, delay);
  }

  private startWatchdog() {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (!this.lastFrameAt) return;
      if (Date.now() - this.lastFrameAt > config.frameWatchdogMs) {
        this.lastError = "watchdog: sin frames";
        this.stopped = false;
        this.cleanup();
        this.scheduleRestart();
      }
    }, 3000);

    if (!this.metricsTimer) {
      this.metricsTimer = setInterval(() => {
        this.fps = this.framesInWindow;
        this.bitrateKbps = Math.round((this.bytesInWindow * 8) / 1000);
        this.framesInWindow = 0;
        this.bytesInWindow = 0;
      }, 1000);
    }
  }

  private stopWatchdog() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Frames
  // ---------------------------------------------------------------------------

  private onStdout(chunk: Buffer) {
    if (this.state !== "running") {
      this.state = "running";
      this.restartAttempts = 0;
    }
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;

    if (this.buffer.length > MAX_BUFFER) {
      // Sin EOI: stream corrupto, descartar y esperar al siguiente I-frame
      this.buffer = Buffer.alloc(0);
      return;
    }

    let searchFrom = 0;
    for (;;) {
      const soi = this.buffer.indexOf(SOI, searchFrom);
      if (soi === -1) {
        // conservar los últimos 2 bytes por si el marcador está partido
        this.buffer = this.buffer.length > 2 ? this.buffer.subarray(this.buffer.length - 2) : Buffer.alloc(0);
        return;
      }
      const eoi = this.buffer.indexOf(EOI, soi + 3);
      if (eoi === -1) {
        this.buffer = this.buffer.subarray(soi);
        return;
      }
      const frame = this.buffer.subarray(soi, eoi + 2);
      this.buffer = this.buffer.subarray(eoi + 2);
      searchFrom = 0;
      this.handleFrame(Buffer.from(frame));
    }
  }

  private handleFrame(frame: Buffer) {
    this.latestFrame = frame;
    this.lastFrameAt = Date.now();
    this.frames += 1;
    this.framesInWindow += 1;
    this.bytesInWindow += frame.length;
    for (const listener of this.listeners) {
      try {
        listener(frame);
      } catch {
        // un suscriptor roto no debe tumbar el pipeline
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------

  status(): PipelineStatus {
    return {
      cameraId: this.spec.cameraId,
      state: this.state,
      online: this.state === "running" && this.lastFrameAt !== null && Date.now() - this.lastFrameAt < 20000,
      fps: this.fps,
      bitrateKbps: this.bitrateKbps,
      lastFrameAt: this.lastFrameAt,
      viewers: this.viewerCount,
      frames: this.frames,
      error: redactSecrets(this.lastError ?? ""),
    };
  }

  reportStatus(): { cameraId: string; status: CameraStatus; online: boolean; fps: number; bitrateKbps: number; lastSeen: number } {
    const s = this.status();
    const status: CameraStatus =
      s.state === "error" ? "error" : s.online ? "online" : s.state === "stopped" ? "unknown" : "starting";
    return {
      cameraId: s.cameraId,
      status,
      online: s.online,
      fps: s.fps,
      bitrateKbps: s.bitrateKbps,
      lastSeen: s.lastFrameAt ?? Date.now(),
    };
  }

  /** Devuelve el último frame JPEG (o null si aún no llegó ninguno). */
  snapshot(): Buffer<ArrayBufferLike> | null {
    return this.latestFrame;
  }
}
