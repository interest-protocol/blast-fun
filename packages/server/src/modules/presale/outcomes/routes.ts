
import {
  sameOrigin,
  visitorIdFromRequest,
} from "@blast/server/modules/launchpad-telemetry/http.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import {
  readJsonBody,
  type PresaleRouteKit,
} from "@blast/core/modules/presale/route-kit/route.ts";
import { outcomeSubmissionSchema } from "@blast/core/modules/presale/contracts/outcome-request.ts";
import type { PresaleOutcomeRecorder } from "./recorder.ts";
import type { PresaleOutcomeStore } from "./store.ts";
import type { PresaleOutcomeReport } from "./verifier.ts";

/** An outcome request is two identifiers, about 130 bytes; anything much larger is not one. */
export const PRESALE_OUTCOME_BODY_LIMIT_BYTES = 1_024;

/** `{ presale_id, tx_digest }` exactly (contracts `outcome-request`), canonical, else `invalid_request`. */
export function parsePresaleOutcomeRequest(body: unknown): PresaleOutcomeReport {
  const result = outcomeSubmissionSchema.safeParse(body);
  if (!result.success) {
    throw new PresaleRouteError("invalid_request");
  }
  return { presaleId: result.data.presale_id, txDigest: result.data.tx_digest };
}

export type PresaleOutcomeRouteDependencies = Readonly<{
  kit: PresaleRouteKit;
  /** The site origin: with the kit's `Origin` rule, the request must also be same-site (`Sec-Fetch-Site`). */
  expectedOrigin: string;
  store: PresaleOutcomeStore;
  recorder: PresaleOutcomeRecorder;
  /** Server time, read once a commitment's body has arrived: its receipt time. */
  clock?: () => Date;
}>;

/**
 * `POST /api/presale/outcomes/commitments` and `POST /api/presale/outcomes`
 * (contract section 3.6), through the presale route kit: every answer is
 * `no-store` with `X-Request-ID`, and every refusal one of the route's
 * published codes.
 */
export function createPresaleOutcomeRoutes(
  dependencies: PresaleOutcomeRouteDependencies,
) {
  const { kit, expectedOrigin, store } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  function assertSameOrigin(request: Request): void {
    if (!sameOrigin(request, expectedOrigin))
      throw new PresaleRouteError("origin_invalid");
  }

  /**
   * Just before it submits a signed commit, the page commits the digest as its
   * visitor's own. In order, nothing is stored before step 4:
   *
   * 1. Same origin (`origin_invalid`); the body bounded (`body_too_large`) and
   *    exactly `{ presale_id, tx_digest }` (`invalid_request`).
   * 2. The receipt time, read as soon as the body has arrived (a client cannot
   *    pre-date it by opening the request early) and before the rate check (a
   *    slow limiter cannot make it later).
   * 3. Without the visitor cookie there is no one to link: `no_visitor`. The
   *    route never mints a visitor. Then the client IP's
   *    `presale_outcome_commit` bucket: `rate_limited`.
   * 4. `(digest, visitor)` is stored once: 201 `recorded`, 200 `duplicate`.
   *
   * No node is read, so a digest the chain has not seen yet is fine: the
   * route never waits for a transaction. No outcome is recorded here.
   */
  const commitments = kit.route(
    { name: "POST /api/presale/outcomes/commitments", auth: "none" },
    async (context) => {
      assertSameOrigin(context.request);
      const body = await readJsonBody(context.request, {
        maxBytes: PRESALE_OUTCOME_BODY_LIMIT_BYTES,
      });
      const committedAt = clock();
      const report = parsePresaleOutcomeRequest(body);
      const visitorId = visitorIdFromRequest(context.request);
      if (!visitorId) throw new PresaleRouteError("no_visitor");
      const decision = await context.consume("presale_outcome_commit");
      if (!decision.allowed)
        throw new PresaleRouteError("rate_limited", {
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      const result = await store.recordCommitment({
        ...report,
        visitorId,
        committedAt,
      });
      return context.json(
        { status: result },
        result === "recorded" ? 201 : 200,
      );
    },
  );

  /**
   * Anyone same-origin reports a commit's digest; the server records it once as
   * a verified outcome of the wallet that sent the `Committed` event. An
   * optional `Authorization: Bearer <Privy access token>` can only link the
   * reporter's own account (and visitor); a missing, invalid or expired token
   * is anonymous and never `unauthorized` (CL-22). In order:
   *
   * 1. The kit's `Origin` rule and same-site (`origin_invalid`), then the
   *    client IP's `presale_outcome` bucket (`rate_limited`).
   * 2. The body bounded (`body_too_large`) and exactly `{ presale_id, tx_digest }`
   *    (`invalid_request`).
   * 3. The recorder (`createPresaleOutcomeRecorder`): one bounded node read,
   *    never a wait for confirmation. No `Committed` of the sale in the digest,
   *    or a transaction the node has not checkpointed yet, is `not_found`; a
   *    node that cannot answer now is `service_unavailable`.
   * 4. 201 `recorded`, 200 `duplicate`. The answer never says whether, or to
   *    whom, the outcome is linked.
   */
  const outcomes = kit.route(
    {
      name: "POST /api/presale/outcomes",
      auth: "optional",
      bucket: "presale_outcome",
    },
    async (context) => {
      assertSameOrigin(context.request);
      const report = parsePresaleOutcomeRequest(
        await readJsonBody(context.request, {
          maxBytes: PRESALE_OUTCOME_BODY_LIMIT_BYTES,
        }),
      );
      const outcome = await dependencies.recorder.record({
        ...report,
        visitorId: visitorIdFromRequest(context.request),
        privyDid: context.account?.did ?? null,
      });
      if (outcome.status === "not_found")
        throw new PresaleRouteError("not_found");
      if (outcome.status === "unavailable")
        throw new PresaleRouteError("service_unavailable");
      return context.json(
        { status: outcome.status },
        outcome.status === "recorded" ? 201 : 200,
      );
    },
  );

  return Object.freeze({ commitments, outcomes });
}
