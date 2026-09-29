export interface ParsedRtspUrl {
  protocol: "rtsp" | "rtsps";
  username?: string;
  password?: string;
  host: string;
  port: number;
  path: string;
}

/**
 * Parsea una URL RTSP sin usar `new URL()` (Node no soporta el esquema rtsp).
 * Ej: rtsp://admin:pass@192.168.1.10:554/Streaming/Channels/101
 */
export function parseRtspUrl(url: string): ParsedRtspUrl {
  const match = /^(rtsps?):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?(\/.*)?$/i.exec(url.trim());
  if (!match) throw new Error("URL RTSP invalida");
  const [, protocol, username, password, host, port, path] = match;
  const proto = (protocol ?? "rtsp").toLowerCase() as "rtsp" | "rtsps";
  return {
    protocol: proto,
    username: username || undefined,
    password: password || undefined,
    host: host ?? "",
    port: port ? Number(port) : proto === "rtsps" ? 322 : 554,
    path: path || "/",
  };
}

/** Devuelve la URL con la password enmascarada, seguro para logs. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:***@");
}

/**
 * Igual que `redactUrl`, pero para texto libre (los mensajes de error de
 * FFmpeg contienen la URL de entrada con las credenciales).
 *   "rtsp://admin:secreto@1.2.3.4 ..." → "rtsp://admin:***@1.2.3.4 ..."
 */
export function redactSecrets(text: string): string {
  return text.replace(/\/\/([^:@/\s]+):([^@\s]+)@/g, "//$1:***@");
}

/** Extrae el host de cualquier URL de cámara para mostrarlo en la UI. */
export function extractHost(url: string): string {
  try {
    const parsed = parseRtspUrl(url);
    return parsed.host;
  } catch {
    try {
      return new URL(url).hostname;
    } catch {
      return "desconocido";
    }
  }
}
