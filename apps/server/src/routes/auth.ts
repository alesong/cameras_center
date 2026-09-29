import { Router } from "express";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../auth/password";
import { signToken } from "../auth/jwt";
import { canRegister, userStore } from "../db/users";
import { requireAuth } from "../middleware/auth";
import { config } from "../config";

const CredentialsSchema = z.object({
  email: z.string().email("Email inválido").max(160),
  password: z.string().min(8, "Mínimo 8 caracteres").max(200),
});

export const authRouter = Router();

/** Estado para la UI: ¿hay que crear el primer usuario? ¿se puede registrar? */
authRouter.get("/status", async (_req, res) => {
  const total = await userStore.count().catch(() => 0);
  res.json({
    backend: userStore.backend,
    needsSetup: total === 0,
    allowRegister: config.allowRegister || total === 0,
    jwt: config.jwtSecret ? "configured" : "missing",
  });
});

authRouter.post("/register", async (req, res) => {
  const parsed = CredentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Payload inválido", issues: parsed.error.issues });
  }
  if (!(await canRegister())) {
    return res.status(403).json({ error: "Registro cerrado (ALLOW_REGISTER=false)" });
  }

  const email = parsed.data.email.toLowerCase();
  try {
    const existing = await userStore.findByEmail(email);
    if (existing) return res.status(409).json({ error: "Ese email ya está registrado" });

    const total = await userStore.count();
    const user = await userStore.create(email, hashPassword(parsed.data.password), total === 0 ? "owner" : "viewer");
    const token = await signToken({ sub: user.id, email: user.email, role: user.role });
    res.status(201).json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) {
    console.error("[auth] register:", error);
    res.status(500).json({ error: schemaAware(error, "No se pudo crear el usuario") });
  }
});

/** Traduce el error de PostgREST "tabla no existe" a algo accionable. */
function schemaAware(error: unknown, fallback: string): string {
  return /Could not find the table|PGRST205/i.test(String((error as Error)?.message ?? error))
    ? "Supabase sin migrar: ejecuta supabase/migrations/0001_init.sql en el SQL Editor"
    : fallback;
}

authRouter.post("/login", async (req, res) => {
  const parsed = CredentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Payload inválido", issues: parsed.error.issues });
  }
  try {
    const user = await userStore.findByEmail(parsed.data.email.toLowerCase());
    if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
      return res.status(401).json({ error: "Credenciales incorrectas" });
    }
    const token = await signToken({ sub: user.id, email: user.email, role: user.role });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) {
    console.error("[auth] login:", error);
    res.status(500).json({ error: schemaAware(error, "No se pudo iniciar sesión") });
  }
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: { id: res.locals.userId, role: res.locals.userRole, email: req.get("x-user-email") ?? null } });
});
