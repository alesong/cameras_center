import { SignJWT, jwtVerify } from "jose";
import { config } from "../config";

export interface TokenPayload {
  sub: string;
  email: string;
  role: string;
}

function secret(): Uint8Array {
  if (!config.jwtSecret) {
    throw new Error("JWT_SECRET no definido: no se pueden emitir tokens");
  }
  return new TextEncoder().encode(config.jwtSecret);
}

export async function signToken(payload: TokenPayload): Promise<string> {
  return new SignJWT({ email: payload.email, role: payload.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setIssuer("cameras-center")
    .setExpirationTime("7d")
    .sign(secret());
}

export async function verifyToken(token: string): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, secret(), { issuer: "cameras-center" });
  if (!payload.sub) throw new Error("Token sin subject");
  return {
    sub: payload.sub,
    email: String(payload.email ?? ""),
    role: String(payload.role ?? "viewer"),
  };
}
