import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, hasSupabase } from "../config";

let cached: SupabaseClient | null = null;

/**
 * Cliente Supabase (service_role). Se usa SÓLO desde el server; la key nunca
 * viaja al navegador. Si no está configurado, `hasSupabase` es false y el
 * store cae en modo memoria (desarrollo local).
 */
export function getSupabase(): SupabaseClient {
  if (!hasSupabase) {
    throw new Error("Supabase no configurado: define SUPABASE_URL y SUPABASE_SERVICE_KEY en .env");
  }
  if (!cached) {
    cached = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { schema: config.supabaseSchema as "public" },
    }) as unknown as SupabaseClient;
  }
  return cached;
}

/** Tablas que el server necesita (ver supabase/migrations/0001_init.sql). */
export const REQUIRED_TABLES = ["users", "cameras", "api_keys", "events", "agent_tokens"] as const;

export interface SchemaStatus {
  ok: boolean;
  missing: string[];
  checkedAt: string;
}

let schemaCache: SchemaStatus | null = null;

/**
 * Comprueba que existan las tablas. Necesario porque supabase-js NO devuelve
 * error con `head:true` cuando falta una tabla, y un fallo silencioso aquí
 * se traduciría en 500s poco explicables más adelante.
 */
export async function verifySchema(force = false): Promise<SchemaStatus> {
  if (schemaCache && !force) return schemaCache;
  const db = getSupabase();
  const missing: string[] = [];
  for (const table of REQUIRED_TABLES) {
    const { error } = await db.from(table).select("*").limit(1);
    if (error && /Could not find the table|does not exist|PGRST205/i.test(error.message)) {
      missing.push(table);
    }
  }
  schemaCache = { ok: missing.length === 0, missing, checkedAt: new Date().toISOString() };
  return schemaCache;
}

export function getSchemaStatus(): SchemaStatus | null {
  return schemaCache;
}
