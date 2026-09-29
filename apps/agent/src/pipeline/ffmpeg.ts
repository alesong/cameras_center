import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config";

const execFileAsync = promisify(execFile);

const EXE = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

/**
 * Localiza el binario de FFmpeg.
 * Orden: `FFMPEG_PATH` → PATH del sistema → instalaciones de winget.
 * (En este equipo FFmpeg está en winget pero fuera del PATH.)
 */
export function resolveFfmpegPath(): string | undefined {
  const explicit = config.ffmpegPath;
  if (explicit && existsSync(explicit)) return explicit;

  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir.trim(), EXE);
    if (existsSync(candidate)) return candidate;
  }

  const wingetRoot = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages");
  if (existsSync(wingetRoot)) {
    for (const entry of safeReaddir(wingetRoot)) {
      if (!/ffmpeg/i.test(entry)) continue;
      const hit = findFile(path.join(wingetRoot, entry), EXE, 4);
      if (hit) return hit;
    }
  }

  return undefined;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function findFile(dir: string, filename: string, depth: number): string | undefined {
  if (depth < 0) return undefined;
  for (const entry of safeReaddir(dir)) {
    const full = path.join(dir, entry);
    if (entry === filename) return full;
    try {
      if (statSync(full).isDirectory()) {
        const hit = findFile(full, filename, depth - 1);
        if (hit) return hit;
      }
    } catch {
      // carpeta inaccesible: ignorar
    }
  }
  return undefined;
}

/** Verifica que FFmpeg esté disponible y devuelve su versión. */
export async function checkFfmpeg(): Promise<{ ok: boolean; path?: string; version?: string; error?: string }> {
  const bin = resolveFfmpegPath();
  if (!bin) return { ok: false, error: "FFmpeg no encontrado (define FFMPEG_PATH)" };
  try {
    const { stdout } = await execFileAsync(bin, ["-version"], { timeout: 5000 });
    return { ok: true, path: bin, version: stdout.split("\n")[0]?.trim() };
  } catch (error) {
    return { ok: false, path: bin, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Crea la carpeta de datos local (snapshots/grabaciones). */
export function ensureDataDir(): string {
  const dir = path.resolve(config.dataDir);
  if (!existsSync(dir)) {
    console.log(`[agent] creando carpeta de datos: ${dir}`);
  }
  return dir;
}
