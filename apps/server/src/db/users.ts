import { randomUUID } from "node:crypto";
import type { Camera } from "@cameras/protocol";
import { config, hasSupabase } from "../config";

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  createdAt: string;
}

export interface UserStore {
  readonly backend: "supabase" | "memory";
  findByEmail(email: string): Promise<StoredUser | undefined>;
  create(email: string, passwordHash: string, role?: string): Promise<StoredUser>;
  count(): Promise<number>;
}

// --- memoria ---------------------------------------------------------------
const memoryUsers = new Map<string, StoredUser>();

const memoryUsersStore: UserStore = {
  backend: "memory",
  async findByEmail(email) {
    const wanted = email.toLowerCase();
    for (const user of memoryUsers.values()) if (user.email === wanted) return user;
    return undefined;
  },
  async create(email, passwordHash, role = "owner") {
    const user: StoredUser = {
      id: randomUUID(),
      email: email.toLowerCase(),
      passwordHash,
      role,
      createdAt: new Date().toISOString(),
    };
    memoryUsers.set(user.id, user);
    return user;
  },
  async count() {
    return memoryUsers.size;
  },
};

// --- supabase -------------------------------------------------------------
interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  created_at: string;
}

const supabaseUsersStore: UserStore = {
  backend: "supabase",
  async findByEmail(email) {
    const { getSupabase } = await import("../db/supabase");
    const { data, error } = await getSupabase()
      .from("users")
      .select("*")
      .eq("email", email.toLowerCase())
      .maybeSingle();
    if (error) throw new Error(`Supabase users: ${error.message}`);
    if (!data) return undefined;
    const row = data as UserRow;
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      role: row.role,
      createdAt: row.created_at,
    };
  },
  async create(email, passwordHash, role = "owner") {
    const { getSupabase } = await import("../db/supabase");
    const { data, error } = await getSupabase()
      .from("users")
      .insert({ email: email.toLowerCase(), password_hash: passwordHash, role })
      .select("*")
      .single();
    if (error) throw new Error(`Supabase create user: ${error.message}`);
    const row = data as UserRow;
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      role: row.role,
      createdAt: row.created_at,
    };
  },
  async count() {
    const { getSupabase } = await import("../db/supabase");
    const { count, error } = await getSupabase()
      .from("users")
      .select("*", { count: "exact", head: true });
    if (error) throw new Error(`Supabase count users: ${error.message}`);
    return count ?? 0;
  },
};

export const userStore: UserStore = hasSupabase ? supabaseUsersStore : memoryUsersStore;

/** Diagnóstico para /api/health */
export function authInfo() {
  return {
    backend: userStore.backend,
    allowRegister: config.allowRegister,
    jwt: config.jwtSecret ? "configured" : "missing",
  };
}

/** La primera creación es siempre owner; el resto respeta ALLOW_REGISTER. */
export async function canRegister(): Promise<boolean> {
  if (config.allowRegister) return true;
  return (await userStore.count()) === 0;
}

export type { Camera };
