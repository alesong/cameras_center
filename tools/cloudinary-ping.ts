#!/usr/bin/env node
/**
 * npm run cloud:ping — F4: comprueba las credenciales de Cloudinary.
 *
 *   1. consigue un JPEG (snapshot del agent, o `--file <ruta>`)
 *   2. lo sube a Cloudinary (public_id de prueba, se sobrescribe)
 *   3. lo descarga y comprueba que sigue siendo una imagen
 *   4. `--clean` borra el asset de prueba al final
 *
 * No toca las cámaras reales: sólo valida la integración.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteAsset, parseCloudinaryUrl, uploadJpeg } from "@cameras/core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readEnv(name: string, fallback = ""): string {
  const file = resolve(root, ".env");
  if (!existsSync(file)) return fallback;
  const line = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith(`${name}=`));
  if (!line) return fallback;
  return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
}

const args = process.argv.slice(2);
const fileArg = args.includes("--file") ? args[args.indexOf("--file") + 1] : null;
const clean = args.includes("--clean");

const url = process.env.CLOUDINARY_URL || readEnv("CLOUDINARY_URL");
const folder = process.env.CLOUDINARY_FOLDER || readEnv("CLOUDINARY_FOLDER", "cameras-center");

if (!url) {
  console.error("Falta CLOUDINARY_URL en .env");
  console.error("  Cloudinary → Dashboard → Product Environment Credentials → Project environment variable");
  console.error("  Formato: cloudinary://<api_key>:<api_secret>@<cloud_name>");
  process.exit(2);
}
const creds = parseCloudinaryUrl(url);
if (!creds) {
  console.error("CLOUDINARY_URL no válida: se esperaba cloudinary://api_key:api_secret@cloud_name");
  process.exit(2);
}
console.log(`☁️  cloud=${creds.cloud}  folder=${folder}`);

/** Snapshot real del agent si está levantado; si no, null. */
async function agentSnapshot(): Promise<Buffer | null> {
  const base = process.env.VITE_AGENT_URL || readEnv("VITE_AGENT_URL", "http://localhost:4100");
  try {
    const status = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(3000) });
    const data = (await status.json()) as { cameras?: Array<{ cameraId: string }> };
    const id = data.cameras?.[0]?.cameraId;
    if (!id) return null;
    const snap = await fetch(`${base}/snapshot/${id}.jpg`, { signal: AbortSignal.timeout(30000) });
    if (!snap.ok) return null;
    return Buffer.from(await snap.arrayBuffer());
  } catch {
    return null;
  }
}

let image: Buffer | null = null;
let origin = "";
if (fileArg) {
  image = readFileSync(resolve(fileArg));
  origin = `archivo ${fileArg}`;
} else {
  image = await agentSnapshot();
  origin = "snapshot del agent";
}
if (!image || image.length === 0) {
  console.error("No hay JPEG para subir:");
  console.error("  · levanta el agent (npm run dev) para usar un snapshot real, o");
  console.error("  · pasa una imagen:  npm run cloud:ping -- --file C:/ruta/imagen.jpg");
  process.exit(3);
}
console.log(`📷 origen: ${origin} (${image.length} bytes)`);

const publicId = "ping";
const uploaded = await uploadJpeg(image, creds, { folder, publicId, overwrite: true });
console.log(`✅ subida: ${uploaded.width}×${uploaded.height} ${uploaded.bytes} B`);
console.log(`   ${uploaded.url}`);

const downloaded = await fetch(uploaded.url, { signal: AbortSignal.timeout(15000) });
const bytes = Buffer.from(await downloaded.arrayBuffer());
const contentType = downloaded.headers.get("content-type") ?? "";
const isImage = contentType.startsWith("image/") && bytes[0] === 0xff && bytes[1] === 0xd8;
console.log(`⬇️  descarga: HTTP ${downloaded.status} · ${contentType} · ${bytes.length} B`);
console.log(isImage ? "✅ es un JPEG válido" : "❌ el contenido no es una imagen JPEG");

if (clean) {
  const fullId = `${folder}/${publicId}`;
  const ok = await deleteAsset(creds, fullId);
  console.log(ok ? `🗑  asset de prueba borrado (${fullId})` : `⚠️  no se pudo borrar ${fullId}`);
}

process.exit(isImage ? 0 : 1);
