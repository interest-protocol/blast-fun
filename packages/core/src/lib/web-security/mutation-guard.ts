import { randomBytes, timingSafeEqual } from "node:crypto";

import { isLoopbackHostname } from "@blast/core/lib/loopback.ts";
import { WebSecurityError } from "@blast/core/lib/web-security/errors.ts";

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, readCsrfCookie } from "./csrf-contract.ts";

export { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "./csrf-contract.ts";

export const OPAQUE_SESSION_COOKIE_NAME = "__Host-blast_session";

function canonicalOrigin(value: string): string {
  try {
    const url = new URL(value);
    const local = isLoopbackHostname(url.hostname);
    if (
      url.origin !== value ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    ) {
      throw new Error("not canonical");
    }
    return url.origin;
  } catch {
    throw new WebSecurityError("OAUTH_CONFIGURATION_INVALID");
  }
}

function sameSecret(left: string | null, right: string | null): boolean {
  if (!left || !right || left.length !== right.length) return false;
  if (!/^[A-Za-z0-9_-]{43}$/.test(left) || !/^[A-Za-z0-9_-]{43}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function createCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function csrfCookie(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new TypeError("Invalid CSRF token.");
  }
  return `${CSRF_COOKIE_NAME}=${token}; Path=/; Secure; SameSite=Strict`;
}

export function opaqueSessionCookie(value: string, maxAgeSeconds: number): string {
  if (
    !/^[A-Za-z0-9_-]{32,2048}$/.test(value) ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 1 ||
    maxAgeSeconds > 31 * 24 * 60 * 60
  ) {
    throw new TypeError("Invalid opaque session cookie.");
  }
  return `${OPAQUE_SESSION_COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function assertTrustedMutationRequest(
  request: Request,
  expectedOriginValue: string,
): void {
  const expectedOrigin = canonicalOrigin(expectedOriginValue);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    origin !== expectedOrigin ||
    (fetchSite !== null && fetchSite !== "same-origin")
  ) {
    throw new WebSecurityError("ORIGIN_INVALID");
  }
  const cookie = readCsrfCookie(request.headers.get("cookie"));
  const header = request.headers.get(CSRF_HEADER_NAME);
  if (!sameSecret(cookie, header)) {
    throw new WebSecurityError("CSRF_INVALID");
  }
}

export async function withTrustedMutation<Result>(
  request: Request,
  expectedOrigin: string,
  mutation: () => Promise<Result>,
): Promise<Result> {
  assertTrustedMutationRequest(request, expectedOrigin);
  return mutation();
}
