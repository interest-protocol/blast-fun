import { canonicalAddress } from "@blast/core/lib/web-security/ingress.ts";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import { rateLimitAddress } from "@blast/core/lib/web-security/client-address.ts";
import { bearerMatches } from "@blast/server/lib/bearer.ts";
import { readBoundedText } from "@blast/server/lib/web-security/request-body.ts";

const PATH = "/api/admin/login-admission";
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
/** `secret` is `ADMIN_LOGIN_ADMISSION_TOKEN`; boot rejects it when it equals the operator token. */
type Dependencies = Readonly<{ secret: string; limiter: RateLimitPort }>;
const failed = (status: number) => Response.json({ error: status === 503 ? "Login admission unavailable" : "Login admission refused" }, { status, headers: HEADERS });

/** Acknowledges one attempt only. It never receives passwords or issues operator grants. */
export function createAdminLoginAdmissionRoute(dependencies: Dependencies) {
  return async (request: Request): Promise<Response> => {
    if (!bearerMatches(request, dependencies.secret)) return failed(401);
    if (request.method !== "POST") return failed(405);
    const url = new URL(request.url);
    if (url.pathname !== PATH || url.search || request.headers.has("origin") || request.headers.has("x-blast-partner-key") ||
        [...request.headers.keys()].some((name) => name.startsWith("x-blast-gateway-") || name.startsWith("x-blast-internal-"))) return failed(403);
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") return failed(415);
    let clientAddress: string;
    try { clientAddress = await readClientAddress(request); }
    catch { return failed(400); }
    const ip = rateLimitAddress(clientAddress);
    if (!ip) return failed(400);
    try {
      // Atomic operation is mandatory: no sequential partial spend or fallback store.
      if (!dependencies.limiter.consumeAll) return failed(503);
      const decision = await dependencies.limiter.consumeAll(["admin_login_ip", "admin_login_global"], { ip });
      if (!decision.allowed) return new Response(null, { status: 429, headers: { ...HEADERS, "Retry-After": String(Math.max(1, decision.retryAfterSeconds)) } });
      return new Response(null, { status: 204, headers: HEADERS });
    } catch { return failed(503); }
  };
}

async function readClientAddress(request: Request): Promise<string> {
  const length = request.headers.get("content-length");
  if (length !== null && !/^\d+$/.test(length)) throw new Error("Invalid size");
  const body = await readBoundedText(request, 256, { fatal: true, signal: AbortSignal.timeout(1000) });
  if (body === null) throw new Error("Invalid size");
  // IP literals need no JSON escapes; this closed syntax also refuses duplicate fields.
  if (!/^\s*\{\s*"clientAddress"\s*:\s*"[^"\\]*"\s*\}\s*$/.test(body)) throw new Error("Invalid schema");
  const value: unknown = JSON.parse(body).clientAddress;
  if (typeof value !== "string" || canonicalAddress(value) !== value) throw new Error("Invalid address");
  return value;
}
