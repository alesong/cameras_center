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
