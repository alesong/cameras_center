#!/usr/bin/env node
/**
 * npm run db:ping — comprueba credenciales Supabase y qué tablas existen.
 * No escribe nada: sólo hace SELECT con límite 0.
 *
 *   node tools/db-ping.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readEnv(name, fallback = "") {
  const file = resolve(root, ".env");
  if (!existsSync(file)) return fallback;
  const line = readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.trim().startsWith(`${name}=`));
  if (!line) return fallback;
  return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
}

const url = readEnv("SUPABASE_URL") || process.env.SUPABASE_URL || "";
const key = readEnv("SUPABASE_SERVICE_KEY") || process.env.SUPABASE_SERVICE_KEY || "";
const schema = readEnv("SUPABASE_SCHEMA", "public") || "public";

if (!url || !key) {
  console.error("Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en .env");
  process.exit(2);
}

console.log(`project : ${url}`);
console.log(`key     : ${key.slice(0, 12)}… (${key.length} chars)`);
console.log(`schema  : ${schema}\n`);

const db = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema },
});

const TABLES = ["users", "cameras", "api_keys", "events", "agent_tokens"];
let missing = 0;

for (const table of TABLES) {
  // OJO: `head:true` + count NO devuelve error con tablas inexistentes
  // (PostgREST responde sin cuerpo y supabase-js se lo traga). Usamos SELECT real.
  const { data, error } = await db.from(table).select("*").limit(1);
  if (error) {
    const absent = /Could not find the table|does not exist|PGRST205/i.test(error.message);
    if (absent) missing++;
    console.log(`  ✗ ${table.padEnd(14)} ${absent ? "NO EXISTE" : "error"} — ${error.message}`);
  } else {
    console.log(`  ✓ ${table.padEnd(14)} lista (${(data ?? []).length} filas en la muestra)`);
  }
}

console.log(
  missing === 0
    ? "\n✔ Esquema completo: el server puede usar el backend supabase."
    : `\n⚠ Faltan ${missing} tabla(s). Ejecuta supabase/migrations/0001_init.sql en el SQL Editor.`,
);
process.exit(missing === 0 ? 0 : 1);
