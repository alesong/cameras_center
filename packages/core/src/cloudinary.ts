import { createHash } from "node:crypto";

/**
 * Subida de imágenes a Cloudinary (F4) — sin SDK, sólo `fetch` + la firma.
 *
 * La URL completa `cloudinary://api_key:api_secret@cloud_name` se guarda en
 * `.env` (gitignored) y jamás sale del server. La firma es el SHA-1 de los
 * parámetros ordenados alfabéticamente + `api_secret`.
 */

export interface CloudinaryCreds {
  cloud: string;
  apiKey: string;
  apiSecret: string;
}

/** `cloudinary://api_key:api_secret@cloud_name` → credenciales (o null). */
export function parseCloudinaryUrl(url: string | undefined | null): CloudinaryCreds | null {
  if (!url) return null;
  const match = /^\s*cloudinary:\/\/([^:/\s]+):([^@\s]+)@([A-Za-z0-9_-]+)\s*$/.exec(url);
  if (!match) return null;
  const [, apiKey, apiSecret, cloud] = match;
  if (!apiKey || !apiSecret || !cloud) return null;
  return { apiKey, apiSecret, cloud };
}

export function cloudinarySignature(params: Record<string, string | number>, apiSecret: string): string {
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return createHash("sha1").update(query + apiSecret).digest("hex");
}

export interface CloudinaryUpload {
  url: string;
  publicId: string;
  bytes: number;
  format: string;
  width?: number;
  height?: number;
}

/** Respuesta literal de Cloudinary (snake_case) mapeada a nuestro tipo. */
interface CloudinaryApiResponse {
  secure_url?: string;
  public_id?: string;
  bytes?: number;
  format?: string;
  width?: number;
  height?: number;
  error?: { message?: string };
}

/**
 * Sube un JPEG. Con `publicId` fijo la imagen se sobrescribe en cada subida:
 * una sola foto por cámara y sin acumular assets.
 */
export async function uploadJpeg(
  image: Buffer,
  creds: CloudinaryCreds,
  options: { folder?: string; publicId?: string; overwrite?: boolean; timeoutMs?: number } = {},
): Promise<CloudinaryUpload> {
  const { folder, publicId, overwrite = true, timeoutMs = 20000 } = options;

  const timestamp = Math.floor(Date.now() / 1000);
  const signed: Record<string, string | number> = { timestamp };
  if (folder) signed.folder = folder;
  if (publicId) signed.public_id = publicId;
  if (overwrite) signed.overwrite = "true";

  const form = new URLSearchParams();
  form.set("file", `data:image/jpeg;base64,${image.toString("base64")}`);
  form.set("api_key", creds.apiKey);
  form.set("timestamp", String(timestamp));
  form.set("signature", cloudinarySignature(signed, creds.apiSecret));
  if (folder) form.set("folder", folder);
  if (publicId) form.set("public_id", publicId);
  if (overwrite) form.set("overwrite", "true");

  const endpoint = `https://api.cloudinary.com/v1_1/${creds.cloud}/image/upload`;
  const response = await fetch(endpoint, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const json = (await response.json().catch(() => ({}))) as CloudinaryApiResponse;
  if (!response.ok) {
    throw new Error(`Cloudinary ${response.status}: ${json.error?.message ?? "fallo desconocido"}`);
  }
  if (!json.secure_url || !json.public_id) throw new Error("Cloudinary no devolvió secure_url");

  return {
    url: json.secure_url,
    publicId: json.public_id,
    bytes: json.bytes ?? image.byteLength,
    format: json.format ?? "jpg",
    width: json.width,
    height: json.height,
  };
}

/** Borra un asset (útil para limpiar las pruebas de `npm run cloud:ping`). */
export async function deleteAsset(
  creds: CloudinaryCreds,
  publicId: string,
  timeoutMs = 15000,
): Promise<boolean> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = cloudinarySignature({ public_id: publicId, timestamp }, creds.apiSecret);
  const form = new URLSearchParams({
    public_id: publicId,
    api_key: creds.apiKey,
    timestamp: String(timestamp),
    signature,
  });
  const response = await fetch(`https://api.cloudinary.com/v1_1/${creds.cloud}/image/destroy`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await response.json().catch(() => ({}))) as { result?: string };
  return json.result === "ok";
}
