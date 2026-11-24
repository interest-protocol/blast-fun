import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import type { RateBucket } from "@blast/core/lib/web-security/rate-limits.ts";
import type { NonSocialRouteId } from "@blast/core/modules/backend-api/private/non-social-contracts.ts";
import { UNAVAILABLE_RETRY_AFTER_SECONDS } from "@blast/core/modules/database/availability.ts";
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { withRouteLimits } from "@blast/core/modules/web-security/route-limits.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";

type MissionControlRouteId = Exclude<NonSocialRouteId, "launchpad.csrf">;

const ownerRead = "mission_control_owner_read";
const ownerWrite = "mission_control_owner_write";

/** Wallet challenge routes take `wallet` per address inside the challenge service. */
const MISSION_CONTROL_ROUTE_LIMITS = {
  "mission-control.owner.card": "mission_control_owner_card",
  "mission-control.owner": ownerRead,
  "mission-control.owner.recruits": ownerRead,
  "mission-control.owner.display-name": ownerWrite,
  "mission-control.logout": ownerWrite,
  "mission-control.owner.wallets": ownerRead,
  "mission-control.owner.wallets.primary": ownerWrite,
  "mission-control.owner.wallets.challenge": null,
  "mission-control.owner.wallets.link": null,
  "mission-control.restore.challenge": null,
  "mission-control.restore.verify": null,
} as const satisfies Record<MissionControlRouteId, RateBucket | null>;

export type MissionControlRoute = Readonly<{
  client: ClientAddress;
  /** Built on first read, so a route that never reads it never opens the pool. */
  limiter: PostgresRateLimitEnforcer;
}>;

/**
 * Runs `handle` under the route's limit from `MISSION_CONTROL_ROUTE_LIMITS`.
 * A throw becomes `failure(cause)`; without `failure` it becomes the limit
 * wrapper's 500.
 */
export function missionControlRoute(
  id: MissionControlRouteId,
  client: ClientAddress,
  handle: (route: MissionControlRoute) => Promise<Response>,
  failure?: (cause: unknown) => Response,
): Promise<Response> {
  const bucket = MISSION_CONTROL_ROUTE_LIMITS[id];
  const run = async () => {
    try {
      return await handle({
        client,
        get limiter() {
          return missionControlLimiter();
        },
      });
    } catch (cause) {
      if (!failure) throw cause;
      return failure(cause);
    }
  };
  return bucket ? withRouteLimits(client, [bucket], run) : run();
}

type Unavailable = Readonly<{
  code: string;
  message: string;
  /** Echoed in the body and `X-Request-ID`; random in the header only when omitted. */
  requestId?: string;
  retryAfterSeconds?: number;
  /** Body fields between `requestId` and `error`. */
  fields?: Readonly<Record<string, unknown>>;
  /** `error` fields after `code` and `message`. */
  error?: Readonly<Record<string, unknown>>;
}>;

/** A 503 with `Retry-After`, recording `cause` in the `http.error` metric. */
export function unavailable(failure: Unavailable, cause: unknown): Response {
  const { code, message, requestId, retryAfterSeconds = UNAVAILABLE_RETRY_AFTER_SECONDS } = failure;
  return publicErrorResponse(code, message, 503, {
    requestId,
    cause,
    headers: { "Retry-After": String(retryAfterSeconds) },
    body: {
      ...(requestId === undefined ? {} : { requestId }),
      ...failure.fields,
      error: { code, message, ...failure.error },
    },
  });
}

/** The durable limiter; the pool and pepper are read on first use. */
function missionControlLimiter(): PostgresRateLimitEnforcer {
  return processSingleton(
    "mission-control.rate-limiter",
    () => new PostgresRateLimitEnforcer({ pool: primaryPool(), subjectPepper: runtimeConfig().subjectPepper }),
  );
}
