import { timingSafeEqual } from "node:crypto";
import { generateApiKey, hashApiKey, isApiKeyLike } from "@cameras/core";
import { hasSupabase } from "./config";
import { getSupabase } from "./db/supabase";

/**
 * API keys de terceros (F5).
 *
 * Sólo se guarda el **hash** (SHA-256): la key en claro se devuelve una única
 * vez al crearla y no se puede recuperar. La comparación es en tiempo constante.
 *
 * Backends: Supabase (tabla `api_keys`) o memoria (desarrollo sin key).
 */

export type ApiScope = "read" | "stream";
export const ALL_SCOPES: ApiScope[] = ["read", "stream"];

export interface ApiKeyRecord {
  id: string;
  label: string;
  keyHash: string;
  scopes: ApiScope[];
  rateLimit: number;
  ownerId: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ApiKeyPublic {
  id: string;
  label: string;
  scopes: ApiScope[];
  rateLimit: number;
  revoked: boolean;
  createdAt: string;
  /** Última vez que se usó (desde el último arranque del server). */
  lastUsedAt: string | null;
}

export interface VerifiedApiKey {
  id: string;
  scopes: ApiScope[];
  rpm: number;
  ownerId: string | null;
}

const memoryKeys = new Map<string, ApiKeyRecord>();
const lastUsedAt = new Map<string, number>();

function toPublic(record: ApiKeyRecord): ApiKeyPublic {
  const used = lastUsedAt.get(record.id);
  return {
    id: record.id,
    label: record.label,
    scopes: record.scopes,
    rateLimit: record.rateLimit,
    revoked: Boolean(record.revokedAt),
    createdAt: record.createdAt,
    lastUsedAt: used ? new Date(used).toISOString() : null,
  };
}

function normalizeScopes(scopes: unknown): ApiScope[] {
  const list = Array.isArray(scopes) ? scopes : [];
  const valid = list.filter((s): s is ApiScope => s === "read" || s === "stream");
  return valid.length > 0 ? valid : ["read"];
}

export const keyStore = {
  get backend(): "supabase" | "memory" {
    return hasSupabase ? "supabase" : "memory";
  },

  /** Crea la key. Devuelve el registro público y la key EN CLARO (una sola vez). */
  async create(
    label: string,
    ownerId: string | null,
    scopes: ApiScope[],
    rateLimit: number,
  ): Promise<{ record: ApiKeyPublic; key: string }> {
    const { key, hash } = generateApiKey();
    const createdAt = new Date().toISOString();

    if (hasSupabase) {
      const { data, error } = await getSupabase()
        .from("api_keys")
        .insert({ label, key_hash: hash, scopes, rate_limit: rateLimit, owner_id: ownerId })
        .select("id, label, scopes, rate_limit, revoked_at, created_at, owner_id")
        .single();
      if (error) throw new Error(error.message);
      const row = data as {
        id: string;
        label: string;
        scopes: string[];
        rate_limit: number;
        revoked_at: string | null;
        created_at: string;
        owner_id: string | null;
      };
      const record: ApiKeyRecord = {
        id: row.id,
        label: row.label,
        keyHash: hash,
        scopes: normalizeScopes(row.scopes),
        rateLimit: row.rate_limit,
        ownerId: row.owner_id,
        revokedAt: row.revoked_at,
        createdAt: row.created_at,
      };
      return { record: toPublic(record), key };
    }

    const id = crypto.randomUUID();
    const record: ApiKeyRecord = {
      id,
      label,
      keyHash: hash,
      scopes,
      rateLimit,
      ownerId,
      revokedAt: null,
      createdAt,
    };
    memoryKeys.set(id, record);
    return { record: toPublic(record), key };
  },

  async list(ownerId: string | null): Promise<ApiKeyPublic[]> {
    if (hasSupabase) {
      let query = getSupabase()
        .from("api_keys")
        .select("id, label, scopes, rate_limit, revoked_at, created_at, owner_id")
        .order("created_at", { ascending: false })
        .limit(100);
      if (ownerId) query = query.eq("owner_id", ownerId);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => {
        const typed = row as {
          id: string;
          label: string;
          scopes: string[];
          rate_limit: number;
          revoked_at: string | null;
          created_at: string;
          owner_id: string | null;
        };
        return toPublic({
          id: typed.id,
          label: typed.label,
          keyHash: "",
          scopes: normalizeScopes(typed.scopes),
          rateLimit: typed.rate_limit,
          ownerId: typed.owner_id,
          revokedAt: typed.revoked_at,
          createdAt: typed.created_at,
        });
      });
    }

    return [...memoryKeys.values()]
      .filter((record) => !ownerId || record.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toPublic);
  },

  /** Revoca (no borra: así queda constancia de quién la usó). */
  async revoke(id: string, ownerId: string | null): Promise<boolean> {
    if (hasSupabase) {
      // `.select("id")` es imprescindible: PostgREST no devuelve filas tras un
      // UPDATE sin `Prefer: return=…`, y sin filas "revocada" parecería falsa.
      let query = getSupabase()
        .from("api_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", id)
        .is("revoked_at", null)
        .select("id");
      if (ownerId) query = query.eq("owner_id", ownerId);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    }

    const record = memoryKeys.get(id);
    if (!record) return false;
    if (ownerId && record.ownerId !== ownerId) return false;
    if (record.revokedAt) return false;
    record.revokedAt = new Date().toISOString();
    return true;
  },

  async count(): Promise<{ total: number; active: number; revoked: number }> {
    if (hasSupabase) {
      const supabase = getSupabase();
      const [total, revoked] = await Promise.all([
        supabase.from("api_keys").select("id", { count: "exact", head: true }),
        supabase.from("api_keys").select("id", { count: "exact", head: true }).not("revoked_at", "is", null),
      ]);
      if (total.error || revoked.error) throw new Error(total.error?.message ?? revoked.error?.message);
      const t = total.count ?? 0;
      const r = revoked.count ?? 0;
      return { total: t, active: t - r, revoked: r };
    }
    const all = [...memoryKeys.values()];
    const r = all.filter((record) => record.revokedAt).length;
    return { total: all.length, active: all.length - r, revoked: r };
  },

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    if (hasSupabase) {
      const { data, error } = await getSupabase()
        .from("api_keys")
        .select("id, label, key_hash, scopes, rate_limit, revoked_at, created_at, owner_id")
        .eq("key_hash", hash)
        .limit(1);
      if (error) throw new Error(error.message);
      const row = (data ?? [])[0] as
        | {
            id: string;
            label: string;
            key_hash: string;
            scopes: string[];
            rate_limit: number;
            revoked_at: string | null;
            created_at: string;
            owner_id: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        id: row.id,
        label: row.label,
        keyHash: row.key_hash,
        scopes: normalizeScopes(row.scopes),
        rateLimit: row.rate_limit,
        ownerId: row.owner_id,
        revokedAt: row.revoked_at,
        createdAt: row.created_at,
      };
    }

    // comparación en tiempo constante de los hashes (SHA-256 en hex)
    for (const record of memoryKeys.values()) {
      const a = Buffer.from(record.keyHash, "hex");
      const b = Buffer.from(hash, "hex");
      if (a.length === b.length && a.length > 0 && timingSafeEqual(a, b)) return record;
    }
    return null;
  },
};

/**
 * Valida una API key presentada por un tercero.
 * Devuelve null si no es una key, está revocada o el formato no corresponde.
 */
export async function verifyApiKey(presented: string): Promise<VerifiedApiKey | null> {
  const trimmed = presented.trim();
  if (!trimmed || !isApiKeyLike(trimmed)) return null;

  const record = await keyStore.findByHash(hashApiKey(trimmed));
  if (!record || record.revokedAt) return null;

  lastUsedAt.set(record.id, Date.now());
  return {
    id: record.id,
    scopes: record.scopes,
    rpm: record.rateLimit > 0 ? record.rateLimit : 60,
    ownerId: record.ownerId,
  };
}

export function keyStatsSnapshot() {
  return { lastUsed: lastUsedAt.size };
}
