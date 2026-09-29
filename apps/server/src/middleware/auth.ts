import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../auth/jwt";

/** `Authorization: Bearer <jwt>` */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    return res.status(401).json({ error: "Autenticación requerida" });
  }
  try {
    const payload = await verifyToken(token);
    res.locals.userId = payload.sub;
    res.locals.userRole = payload.role;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
}
