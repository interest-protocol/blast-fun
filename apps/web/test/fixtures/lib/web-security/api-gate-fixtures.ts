import { gateCookieName, gateKeys, mintGateToken } from "@blast/core/lib/web-security/gate-cookie.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Test harness helper: a `Cookie` header value carrying a valid API gate
 * cookie for `url`'s scheme, minted with the process's gate secret (the
 * environment's `BLAST_GATE_SECRET`, else the development secret).
 */
export function gateCookieHeader(url: string, options: Readonly<{ environment?: Environment; now?: number }> = {}): string {
  const keys = gateKeys(options.environment ?? process.env);
  if (!keys) throw new Error("No API gate secret: set BLAST_GATE_SECRET or run outside production.");
  return `${gateCookieName(new URL(url).protocol === "https:")}=${mintGateToken(keys, options.now)}`;
}

/** `request` with a valid gate cookie added to its Cookie header. */
export function withGateCookie(request: Request, options: Readonly<{ environment?: Environment; now?: number }> = {}): Request {
  const headers = new Headers(request.headers);
  const cookie = gateCookieHeader(request.url, options);
  headers.set("cookie", headers.has("cookie") ? `${headers.get("cookie")}; ${cookie}` : cookie);
  return new Request(request, { headers });
}
