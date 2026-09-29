import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

/**
 * Convierte la env var `CAMERA_ENC_KEY` en una clave de 32 bytes.
 * Acepta 64 caracteres hex o base64 que decodifique a 32 bytes.
 */
export function keyFromEnv(raw: string | undefined): Buffer {
  if (!raw) throw new Error("CAMERA_ENC_KEY no definida");
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    throw new Error("CAMERA_ENC_KEY debe ser 32 bytes (64 hex o base64 valido)");
  }
  return decoded;
}

/** Cifra texto con AES-256-GCM. Formato: `v1.<iv>.<tag>.<cifrado>` (base64url). */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Descifra un valor producido por `encryptSecret`. */
export function decryptSecret(payload: string, key: Buffer): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Formato de secreto invalido");
  const [, ivRaw, tagRaw, dataRaw] = parts as [string, string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataRaw, "base64url")), decipher.final()]).toString("utf8");
}
