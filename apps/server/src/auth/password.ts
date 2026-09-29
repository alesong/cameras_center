import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const PREFIX = "scrypt";
const KEYLEN = 64;

/**
 * Hash de contraseñas con scrypt (nativo de Node, sin dependencias).
 * Formato: `scrypt.<salta-base64>.<hash-base64>`
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN);
  return [PREFIX, salt.toString("base64"), hash.toString("base64")].join(".");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;
  const [, saltB64, hashB64] = parts as [string, string, string];
  try {
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = scryptSync(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
