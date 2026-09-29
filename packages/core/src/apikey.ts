import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "cc_live";

/** Genera un API key tipo `cc_live_<40 hex>`. Guarda sólo el hash. */
export function generateApiKey(): { key: string; hash: string } {
  const key = `${PREFIX}_${randomBytes(20).toString("hex")}`;
  return { key, hash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Comparación en tiempo constante de dos hashes. */
export function apiKeyMatches(providedKey: string, storedHash: string): boolean {
  const a = Buffer.from(hashApiKey(providedKey), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isApiKeyLike(value: string): boolean {
  return new RegExp(`^${PREFIX}_[0-9a-f]{40}$`).test(value);
}

/** Hash de contraseñas/agent tokens (SHA-256; migrar a argon2 en F2). */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
