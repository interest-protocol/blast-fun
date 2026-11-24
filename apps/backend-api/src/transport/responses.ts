import { INTERNAL_READ_PREFIX } from "@blast/core/modules/backend-api/gateway.ts";
import { firstPartyReadCodes } from "@blast/server/modules/partner-api/v1/failures.ts";

/** A coded transport refusal. Only a limit (429) or an outage (5xx) is worth retrying, so only those carry `Retry-After`. */
export function refusal(status: number, code: string, retryAfter = 1, message?: string): Response {
  const retry = status === 429 || status >= 500;
  return Response.json(
    { error: { code, ...(message === undefined ? {} : { message }) } },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store",
        ...(retry ? { "Retry-After": String(retryAfter) } : {}),
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

/** The operator namespace's own refusal shape, distinct from the transport's coded errors. */
export function operatorRefusal(status: 401 | 404, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export function unavailableCode(path: string): string {
  return path.startsWith(INTERNAL_READ_PREFIX + "/")
    ? firstPartyReadCodes(path.slice(INTERNAL_READ_PREFIX.length)).unavailable
    : "service_unavailable";
}
