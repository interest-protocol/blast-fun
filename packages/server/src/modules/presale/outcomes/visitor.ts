import { randomUUID } from "node:crypto";

import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import {
  sameOrigin,
  visitorCookie,
  visitorIdFromRequest,
} from "@blast/server/modules/launchpad-telemetry/http.ts";
import { recordPresaleMetric } from "@blast/core/modules/presale/redaction/redaction.ts";
import {
  PresaleRouteError,
  presaleErrorCause,
  toPresaleRouteError,
} from "@blast/core/modules/presale/route-kit/errors.ts";
import { presaleErrorResponse } from "@blast/core/modules/presale/route-kit/route.ts";

export type PresaleVisitorRouteDependencies = Readonly<{
  /** The site origin: a present `Origin` must equal it, and the request must be same-site. */
  expectedOrigin: string;
  limiter: RateLimitPort;
  createVisitorId?: () => string;
  createRequestId?: () => string;
}>;

// What this route can answer besides 204: the route kit's codes it uses.
const CODES = new Set([
  "origin_invalid",
  "rate_limited",
  "service_unavailable",
]);

/**
 * `POST /api/presale/outcomes/visitor` (no body): the presale page's source of
 * the first-party visitor cookie for visitors who land directly on a presale.
 * The page calls it once per tab per page
 * load, before it registers a commitment, and ignores the answer. In order:
 *
 * 1. Another site or `Origin`: `origin_invalid` (403).
 * 2. A request that already carries a valid `__Host-blast_vid` keeps it: 204,
 *    no `Set-Cookie`, and no rate bucket spent, so a returning visitor's page
 *    loads, in any number of tabs, are never refused.
 * 3. Otherwise the client IP's `presale_outcome_commit` bucket, the commitment
 *    route's (`rate_limited` 429 with `Retry-After`; `service_unavailable` 503
 *    when the limiter cannot answer), then a new opaque visitor (UUID v4) is
 *    minted with exactly the launchpad telemetry route's cookie
 *    (`visitorCookie`): 204.
 *
 * Nothing is stored. Answers are `no-store` with `X-Request-ID`; refusals use
 * the presale error body.
 */
export function createPresaleVisitorRouteHandler(
  dependencies: PresaleVisitorRouteDependencies,
): (request: Request, client: ClientAddress) => Promise<Response> {
  const createVisitorId = dependencies.createVisitorId ?? randomUUID;
  const createRequestId = dependencies.createRequestId ?? randomUUID;
  return async (request, client) => {
    const requestId = createRequestId();
    const headers = new Headers({
      "Cache-Control": "no-store",
      "X-Request-ID": requestId,
    });
    try {
      if (!sameOrigin(request, dependencies.expectedOrigin))
        throw new PresaleRouteError("origin_invalid");
      if (!visitorIdFromRequest(request)) {
        const decision = await dependencies.limiter.consume(
          "presale_outcome_commit",
          { ip: client.rateKey },
        );
        if (!decision.allowed)
          throw new PresaleRouteError("rate_limited", {
            retryAfterSeconds: decision.retryAfterSeconds,
          });
        headers.set("Set-Cookie", visitorCookie(createVisitorId()));
      }
      return new Response(null, { status: 204, headers });
    } catch (caught) {
      let error = toPresaleRouteError(caught);
      if (!CODES.has(error.code))
        error = new PresaleRouteError("service_unavailable");
      recordPresaleMetric("presale.route", {
        route: "POST /api/presale/outcomes/visitor",
        requestId,
        status: error.status,
        outcome: error.status >= 500 ? "error" : "refused",
        code: error.code,
        cause: presaleErrorCause(caught),
      });
      return presaleErrorResponse(requestId, error);
    }
  };
}
