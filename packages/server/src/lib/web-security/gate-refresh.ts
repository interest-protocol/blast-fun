import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import { issueGateCookie, type GateKeys } from "@blast/core/lib/web-security/gate-cookie.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";

function answer(status: number, error: string, extra: Record<string, string> = {}): Response {
  const message = error === "gate_forbidden" ? "The request origin could not be verified."
    : error === "rate_limited" ? "Too many requests. Wait before retrying."
    : "Request verification is temporarily unavailable. Please retry.";
  return publicErrorResponse(error, message, status, { headers: extra, body: { error, code: error, message } });
}

/**
 * `GET /api/gate`: re-issues the gate cookie for a tab whose cookie expired
 * (the browser's fetch wrapper calls it once after a `gate_required` 401,
 * then retries). Only a same-origin fetch (`Sec-Fetch-Site: same-origin`,
 * and the site's `Origin` when one is sent) gets one, at most `web_gate`'s
 * budget per client address. 204 with `Set-Cookie`, never stored.
 *
 * A script can forge those headers; the endpoint only spares a person a
 * reload. What it gives out is what any page load gives out, and the bucket
 * bounds how fast.
 */
export async function gateRefreshResponse(
  request: Request,
  client: ClientAddress,
  dependencies: Readonly<{
    expectedOrigin: string;
    keys: GateKeys;
    limiter: () => Promise<RateLimitPort | null>;
    now?: number;
  }>,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") !== "same-origin" || (origin !== null && origin !== new URL(dependencies.expectedOrigin).origin)) {
    return answer(403, "gate_forbidden");
  }
  try {
    const limiter = await dependencies.limiter();
    if (!limiter) return answer(503, "gate_unavailable", { "Retry-After": "5" });
    const decision = await limiter.consume("web_gate", { ip: client.rateKey });
    if (!decision.allowed) return answer(429, "rate_limited", { "Retry-After": String(decision.retryAfterSeconds) });
  } catch {
    return answer(503, "gate_unavailable", { "Retry-After": "5" });
  }
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store", "Set-Cookie": issueGateCookie(request, dependencies.keys, dependencies.now) },
  });
}
