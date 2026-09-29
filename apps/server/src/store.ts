import { randomUUID } from "node:crypto";
import type { Camera, CameraSourceType, CreateCameraPayload } from "@cameras/protocol";
import { decryptSecret, encryptSecret, extractHost, keyFromEnv } from "@cameras/core";
import { hasSupabase } from "./config";

/** Cámara con la URL de conexión (sólo para el agent y FFmpeg). */
export interface StoredCamera extends Camera {
  connection: string;
}

/** Devuelve el DTO público: NUNCA incluye la URL de conexión (lleva credenciales). */
export function toPublicCamera(camera: StoredCamera): Camera {
  const { connection: _connection, ...rest } = camera;
  return rest;
}

export interface CameraStore {
  readonly backend: "supabase" | "memory";
  ready(): boolean;
  list(): Promise<StoredCamera[]>;
  get(id: string): Promise<StoredCamera | undefined>;
  create(input: CreateCameraPayload, ownerId?: string): Promise<StoredCamera>;
  remove(id: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Cifrado de credenciales
// ---------------------------------------------------------------------------
let encryptionKey: Buffer | null | undefined;

function getEncryptionKey(): Buffer | null {
  if (encryptionKey !== undefined) return encryptionKey;
  try {
    encryptionKey = keyFromEnv(process.env.CAMERA_ENC_KEY);
  } catch {
    console.warn("⚠️  CAMERA_ENC_KEY no válida: las URLs de cámara se guardarán en claro (sólo desarrollo)");
    encryptionKey = null;
  }
  return encryptionKey;
}

export function protectConnection(connection: string): string {
  const key = getEncryptionKey();
  return key ? encryptSecret(connection, key) : connection;
}

export function revealConnection(value: string | null | undefined): string {
  if (!value) return "";
  if (!value.startsWith("v1.")) return value; // legado / sin cifrar
  const key = getEncryptionKey();
  if (!key) throw new Error("Cámara cifrada pero falta CAMERA_ENC_KEY");
  return decryptSecret(value, key);
}

// ---------------------------------------------------------------------------
// Backend en memoria (desarrollo sin Supabase)
// ---------------------------------------------------------------------------
const memoryMap = new Map<string, StoredCamera>();

export const memoryStore: CameraStore = {
  backend: "memory",
  ready: () => true,

  async list() {
    return [...memoryMap.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  },

  async get(id) {
    return memoryMap.get(id);
  },

  async create(input, _ownerId) {
    const camera: StoredCamera = {
      id: randomUUID(),
      name: input.name,
      brand: input.brand,
      sourceType: input.sourceType,
      host: input.host || extractHost(input.connection),
      order: input.order,
      active: input.active,
      createdAt: new Date().toISOString(),
      connection: input.connection,
    };
    memoryMap.set(camera.id, camera);
    return camera;
  },

  async remove(id) {
    return memoryMap.delete(id);
  },
};

// ---------------------------------------------------------------------------
// Backend Supabase (producción)
// ---------------------------------------------------------------------------
interface CameraRow {
  id: string;
  name: string;
  brand: string | null;
  source_type: CameraSourceType;
  host: string;
  connection_encrypted: string | null;
  sort_order: number;
  active: boolean;
  owner_id: string | null;
  created_at: string;
}

function rowToCamera(row: CameraRow): StoredCamera {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    sourceType: row.source_type,
    host: row.host,
    order: row.sort_order,
    active: row.active,
    createdAt: new Date(row.created_at).toISOString(),
    connection: revealConnection(row.connection_encrypted),
  };
}

export const supabaseStore: CameraStore = {
  backend: "supabase",
  ready: () => hasSupabase,

  async list() {
    const { getSupabase } = await import("./db/supabase");
    const { data, error } = await getSupabase()
      .from("cameras")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });
    if (error) throw new Error(`Supabase list: ${error.message}`);
    return ((data ?? []) as CameraRow[]).map(rowToCamera);
  },

  async get(id) {
    const { getSupabase } = await import("./db/supabase");
    const { data, error } = await getSupabase().from("cameras").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`Supabase get: ${error.message}`);
    return data ? rowToCamera(data as CameraRow) : undefined;
  },

  async create(input, ownerId) {
    const { getSupabase } = await import("./db/supabase");
    const row = {
      name: input.name,
      brand: input.brand,
      source_type: input.sourceType,
      host: input.host || extractHost(input.connection),
      connection_encrypted: protectConnection(input.connection),
      sort_order: input.order,
      active: input.active,
      owner_id: ownerId ?? null,
    };
    const { data, error } = await getSupabase().from("cameras").insert(row).select("*").single();
    if (error) throw new Error(`Supabase create: ${error.message}`);
    return rowToCamera(data as CameraRow);
  },

  async remove(id) {
    const { getSupabase } = await import("./db/supabase");
    const { data, error } = await getSupabase().from("cameras").delete().eq("id", id).select("id");
    if (error) throw new Error(`Supabase delete: ${error.message}`);
    return (data ?? []).length > 0;
  },
};

// ---------------------------------------------------------------------------
// Selección del backend
// ---------------------------------------------------------------------------
export const store: CameraStore = hasSupabase ? supabaseStore : memoryStore;

/** Semilla opcional para probar la UI sin hardware real. */
export async function seedDemo(): Promise<void> {
  if (process.env.SEED_DEMO !== "true") return;
  const existing = await store.list();
  if (existing.length > 0) return;
  await store.create({
    name: "Cámara demo",
    brand: "Demo",
    sourceType: "test",
    host: "127.0.0.1",
    connection: "test://testsrc",
    order: 0,
    active: true,
  });
  console.log("🌱 cámara demo creada (SEED_DEMO=true)");
}
