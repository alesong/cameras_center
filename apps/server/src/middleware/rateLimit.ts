import type { NextFunction, Request, Response } from "express";

/**
 * Rate limiting en memoria (F5).
 *
 * Ventana fija de 60 s por "bucket" (IP, API key o usuario). Sin dependencias
 * externas: en un despliegue único (Render) la memoria es suficiente y se
 * limpia sola cada minuto para no crecer.
 *
 * Cabeceras siempre visibles:
 *   X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset
 * y al superar el límite además `Retry-After` + HTTP 429.
 */
export interface RateVerdict {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSec: number;
}

export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;
  blocked = 0;
  requests = 0;

  take(bucket: string, rpm: number): RateVerdict {
    const now = Date.now();
    this.requests += 1;
    if (now - this.lastSweep > 60_000) this.sweep(now);

    let window = this.windows.get(bucket);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + 60_000 };
      this.windows.set(bucket, window);
    }
    window.count += 1;

    const allowed = window.count <= rpm;
    if (!allowed) this.blocked += 1;
    return {
      allowed,
      limit: rpm,
      remaining: Math.max(0, rpm - window.count),
      resetSec: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    };
  }

  stats() {
    return { buckets: this.windows.size, requests: this.requests, blocked: this.blocked };
  }

  reset(): void {
    this.windows.clear();
    this.blocked = 0;
    this.requests = 0;
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [bucket, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(bucket);
    }
  }
}

export const globalLimiter = new RateLimiter();
export const authLimiter = new RateLimiter();
export const keyLimiter = new RateLimiter();

function ipOf(req: Request): string {
  const forwarded = req.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return req.ip ?? "unknown";
}

function applyHeaders(res: Response, verdict: RateVerdict): void {
  res.set("X-RateLimit-Limit", String(verdict.limit));
  res.set("X-RateLimit-Remaining", String(verdict.remaining));
  res.set("X-RateLimit-Reset", String(verdict.resetSec));
}

function reject(res: Response, verdict: RateVerdict, what: string): void {
  applyHeaders(res, verdict);
  res.set("Retry-After", String(verdict.resetSec));
  res.status(429).json({
    error: `Límite de peticiones excedido (${verdict.limit}/min en ${what})`,
    retryAfterSec: verdict.resetSec,
  });
}

const toInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Protección global por IP para toda la API (def. 300/min, RATE_LIMIT_RPM). */
export function globalRateLimit(req: Request, res: Response, next: NextFunction) {
  const rpm = toInt(process.env.RATE_LIMIT_RPM, 300);
  const verdict = globalLimiter.take(`ip:${ipOf(req)}`, rpm);
  applyHeaders(res, verdict);
  if (!verdict.allowed) return reject(res, verdict, "IP");
  next();
}

/**
 * Límite fino aplicado DESPUÉS de conocer la identidad:
 * API key → su `rate_limit` propio; JWT → `RATE_LIMIT_RPM`; anónimo → IP.
 */
export function principalRateLimit(req: Request, res: Response, next: NextFunction) {
  const principal = res.locals.principal as { type?: string; id?: string; rpm?: number } | undefined;

  let bucket = `ip:${ipOf(req)}`;
  let rpm = toInt(process.env.RATE_LIMIT_RPM, 300);
  if (principal?.type === "apikey") {
    bucket = `key:${principal.id}`;
    rpm = principal.rpm && principal.rpm > 0 ? principal.rpm : 60;
  } else if (principal?.type === "jwt") {
    bucket = `jwt:${principal.id}`;
  }

  const verdict = keyLimiter.take(bucket, rpm);
  applyHeaders(res, verdict);
  if (!verdict.allowed) return reject(res, verdict, principal?.type === "apikey" ? "esta API key" : "este cliente");
  next();
}

/** Login/registro: fuerza bruta. 10 intentos por IP y minuto. */
export function authRateLimit(req: Request, res: Response, next: NextFunction) {
  const verdict = authLimiter.take(`ip:${ipOf(req)}`, toInt(process.env.AUTH_RATE_LIMIT_RPM, 10));
  applyHeaders(res, verdict);
  if (!verdict.allowed) return reject(res, verdict, "login");
  next();
}
