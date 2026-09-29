import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { keyStore } from "../keys";

/**
 * Gestión de API keys de terceros (F5).
 *
 *  - `GET    /api/v1/keys`      lista las tuyas (nunca devuelve la key en claro)
 *  - `POST   /api/v1/keys`      crea una → la key se devuelve **una sola vez**
 *  - `DELETE /api/v1/keys/:id`  la revoca (queda registrada, ya no autentica)
 *
 * Sólo un `owner` puede crear/revocar: si `ALLOW_REGISTER=true` cualquiera
 * podría registrarse y no queremos que un viewer genere claves de lectura.
 */
export const keysRouter = Router();

function handleError(res: import("express").Response, error: unknown, context: string) {
  console.error(`[keys] ${context}:`, error);
  return res.status(500).json({ error: error instanceof Error ? error.message : "Error interno" });
}

const CreateKeySchema = z.object({
  label: z.string().trim().min(1, "Etiqueta obligatoria").max(80),
  scopes: z.array(z.enum(["read", "stream"])).min(1).max(2).optional(),
  rate_limit: z.number().int().min(1).max(6000).optional(),
});

keysRouter.get("/", requireAuth, async (req, res) => {
  try {
    const keys = await keyStore.list(res.locals.userId ?? null);
    res.json({ keys, backend: keyStore.backend });
  } catch (error) {
    handleError(res, error, "list");
  }
});

keysRouter.post("/", requireAuth, async (req, res) => {
  if (res.locals.userRole !== "owner") {
    return res.status(403).json({ error: "Sólo el usuario owner puede crear API keys" });
  }
  const parsed = CreateKeySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Payload inválido", issues: parsed.error.issues });
  }
  try {
    const { label, scopes, rate_limit } = parsed.data;
    const { record, key } = await keyStore.create(
      label,
      res.locals.userId ?? null,
      scopes ?? ["read", "stream"],
      rate_limit ?? 60,
    );
    res.status(201).json({
      key, // única vez: sólo se guarda su hash
      warning: "Guarda esta clave ahora: no volverá a mostrarse.",
      apikey: record,
    });
  } catch (error) {
    handleError(res, error, "create");
  }
});

keysRouter.delete("/:id", requireAuth, async (req, res) => {
  if (res.locals.userRole !== "owner") {
    return res.status(403).json({ error: "Sólo el usuario owner puede revocar API keys" });
  }
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Falta el id" });
    const revoked = await keyStore.revoke(id, res.locals.userId ?? null);
    if (!revoked) return res.status(404).json({ error: "API key no encontrada o ya revocada" });
    res.status(204).end();
  } catch (error) {
    handleError(res, error, "revoke");
  }
});
