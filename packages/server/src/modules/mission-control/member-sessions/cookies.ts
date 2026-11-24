import { OPAQUE_SESSION_COOKIE_NAME } from "@blast/core/lib/web-security/mutation-guard.ts";
import { z } from "zod";

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export function isMemberSessionToken(value: string): boolean {
  return tokenSchema.safeParse(value).success;
}

export function readMemberSessionToken(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  let token: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== OPAQUE_SESSION_COOKIE_NAME) continue;
    if (token !== null) return null;
    token = part.slice(separator + 1).trim();
  }
  return token && isMemberSessionToken(token) ? token : null;
}

export function clearMemberSessionCookie(): string {
  return `${OPAQUE_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
