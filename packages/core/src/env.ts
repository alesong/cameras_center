import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Busca un archivo `.env` subiendo desde `startDir` hasta la raíz del monorepo.
 * Evita que cada workspace dependa de su propio `.env`.
 */
export function findUpEnvFile(startDir: string = process.cwd(), filename = ".env"): string | undefined {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
