import type { NextFunction, Request, Response } from "express";
import { isApiKeyLike } from "@cameras/core";
import { verifyToken } from "../auth/jwt";
import { verifyApiKey } from "../keys";

/** Identidad resuelta: JWT de usuario o API key de un tercero. */
export interface Principal {
  type: "jwt" | "apikey";
  id: string;
  scopes?: string[];
  rpm?: number;
}

/**
 * Credencial presentada: cabecera `Authorization: Bearer …` o `X-API-Key: …`.
 * API keys y JWT se distinguen por el formato (`cc_live_…` vs `eyJ…`).
 */
function credentialOf(req: Request): string {
  const header = req.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return (req.get("x-api-key") ?? "").trim();
}

/** Sólo usuarios con JWT (escritura: crear/borrar cámaras, gestionar keys). */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = credentialOf(req);
  if (!token) {
    return res.status(401).json({ error: "Autenticación requerida" });
  }
  if (isApiKeyLike(token)) {
    return res.status(401).json({
      error: "Esta operación requiere un JWT de usuario: una API key sólo puede leer",
    });
  }
  try {
    const payload = await verifyToken(token);
    res.locals.userId = payload.sub;
    res.locals.userRole = payload.role;
    res.locals.principal = { type: "jwt", id: payload.sub } satisfies Principal;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
}

/**
 * Lectura para terceros: acepta **JWT de usuario** o **API key** con scope `read`.
 * Usado en frame.jpg, thumbnails y el stream MJPEG.
 */
export async function requirePrincipal(req: Request, res: Response, next: NextFunction) {
  const credential = credentialOf(req);
  if (!credential) {
    return res.status(401).json({
      error: "Autenticación requerida",
      hint: "Authorization: Bearer <jwt|cc_live_…> o X-API-Key: cc_live_…",
    });
  }

  if (isApiKeyLike(credential)) {
    let verified;
    try {
      verified = await verifyApiKey(credential);
    } catch (error) {
      console.error("[auth] error validando API key:", error);
      return res.status(500).json({ error: "No se pudo validar la API key" });
    }
    if (!verified) {
      return res.status(401).json({ error: "API key inválida o revocada" });
    }
    if (!verified.scopes.includes("read")) {
      return res.status(403).json({ error: "La API key no tiene el scope `read`" });
    }
    res.locals.principal = { type: "apikey", id: verified.id, scopes: verified.scopes, rpm: verified.rpm } satisfies Principal;
    res.locals.userId = verified.ownerId;
    return next();
  }

  try {
    const payload = await verifyToken(credential);
    res.locals.userId = payload.sub;
    res.locals.userRole = payload.role;
    res.locals.principal = { type: "jwt", id: payload.sub } satisfies Principal;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
}
