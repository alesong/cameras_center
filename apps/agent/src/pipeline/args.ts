import type { CameraSourceType } from "@cameras/protocol";

export interface SourceSpec {
  cameraId: string;
  sourceType: CameraSourceType;
  /** URL de conexión (rtsp/mjpeg) o identificador de fuente sintética. */
  connection: string;
}

/** Salida común: JPEG secuencial por stdout, listo para `multipart/x-mixed-replace`. */
const OUTPUT_ARGS = [
  "-an",
  "-vf",
  "fps=6,scale='min(1280,iw)':-2",
  "-q:v",
  "6",
  "-f",
  "mjpeg",
  "pipe:1",
];

/**
 * Construye la línea de comandos de FFmpeg para una cámara.
 *
 * Nota de rendimiento (mejora pendiente): si la entrada ya es H.264 y sólo hay
 * que reenviarla, usar `-c:v copy` con salida `mpegts`/`fmp4` en vez de recodificar.
 * MJPEG siempre requiere recodificar.
 */
export function buildFfmpegArgs(spec: SourceSpec): string[] {
  const input = buildInputArgs(spec);
  return [...input, ...OUTPUT_ARGS];
}

function buildInputArgs(spec: SourceSpec): string[] {
  switch (spec.sourceType) {
    case "rtsp":
      // TCP evita el packet loss típico del UDP en wifi
      return ["-hide_banner", "-loglevel", "warning", "-rtsp_transport", "tcp", "-i", spec.connection];

    case "mjpeg":
      // Cámara que expone un MJPEG por HTTP; se recodifica para normalizar fps/tamaño
      return ["-hide_banner", "-loglevel", "warning", "-i", spec.connection];

    case "test":
      // Fuente sintética: patrón de prueba con contador. Sólo para desarrollo.
      // `-re` (input) limita la generación a tiempo real para no quemar CPU.
      return [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-re",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=1280x720:rate=6",
      ];

    case "onvif":
    default:
      // ONVIF resuelve a una URL RTSP; si llega aquí, `connection` ya es esa URL
      return ["-hide_banner", "-loglevel", "warning", "-rtsp_transport", "tcp", "-i", spec.connection];
  }
}
