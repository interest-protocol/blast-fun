import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { PRESALE_SPONSOR_EXECUTE_PATH } from "@blast/core/modules/backend-api/private/presale-contracts.ts";
import type { AfterResponseReservation } from "@blast/server/lib/request-work.ts";

import { errorLabel } from "@blast/core/lib/metrics.ts";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import { executeSubmissionSchema } from "@blast/core/modules/presale/contracts/execute-request.ts";
import type { ExecuteResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import type { PresaleOutcomeRecorder } from "../presale/outcomes/recorder.ts";
import { recordPresaleMetric } from "@blast/core/modules/presale/redaction/redaction.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { hasDailySponsorshipLimit, recordsCommit } from "@blast/core/modules/sponsor/intents.ts";
import {
  readJsonBody,
  type PresaleRequestContext,
  type PresaleRouteKit,
} from "@blast/core/modules/presale/route-kit/route.ts";
import type { SponsorTransactionLookup } from "./chain.ts";
import type { SponsorSignatureVerifier } from "./signature.ts";
import { routeSponsorCaller, sponsorAccountKey } from "./caller.ts";
import type {
  SponsorExecutionOutcome,
  SponsorExecutionRow,
  SponsorExecutionStore,
} from "./executions.ts";
import {
  GAS_POOL_EXECUTE_TIMEOUT_MS,
  type GasPoolExecution,
  type PresaleGasPoolExecutor,
  type SponsorExecutionEffects,
} from "./pool-execute.ts";

/** How long execute looks for the digest on chain when the pool's answer did not settle it. */
export const EXECUTE_CONFIRM_WINDOW_MS = 15_000;
/** The wait between two digest lookups. */
export const EXECUTE_POLL_INTERVAL_MS = 1_000;
/** The longest one digest lookup may take. */
const LOOKUP_TIMEOUT_MS = 2_000;
/**
 * A submitter's own time beyond its pool call and window, which a waiter adds
 * to its deadline (Q-004): signature verification, the pool settings and the
 * submit round trip before the call, and its last lookup after the window.
 */
const SUBMITTER_SLACK_MS = LOOKUP_TIMEOUT_MS + 3_000;
/** Room for the largest Sui signature (multisig, zkLogin, passkey) in base64. */
const BODY_LIMIT_BYTES = 16 * 1_024;
const RESERVATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METRIC = "presale.sponsor_execute";

export type PresaleSponsorExecuteDependencies = Readonly<{
  kit: PresaleRouteKit;
  executions: SponsorExecutionStore;
  authorizeSubmission?: (row: SponsorExecutionRow, signal: AbortSignal) => Promise<void>;
  /** The pool's execute client; throws `service_unavailable` when its settings are missing. Read before anything is submitted. */
  pool: () => PresaleGasPoolExecutor;
  /** The presale node's digest lookup. */
  transactions: SponsorTransactionLookup;
  /** Checks the user's signature over the reservation's bytes (`createSponsorSignatureVerifier`). */
  verifySignature: SponsorSignatureVerifier;
  outcomes: Pick<PresaleOutcomeRecorder, "recordSponsoredCommit">;
  /** Reserve before irreversible submission; only the conditional settlement winner attaches. */
  reserveBackground: () => AfterResponseReservation | null;
  /** Counts wrong signatures per reservation (`presale_sponsor_bad_signature`, keyed by the reservation id). */
  limits: Pick<RateLimitPort, "consume">;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** The pool call's timeout, which also bounds how long another request waits on a fresh submission. */
  poolTimeoutMs?: number;
  confirmWindowMs?: number;
  pollIntervalMs?: number;
}>;

/** The path's `{reservation_id}`: a lowercase uuid, else `invalid_parameter` (CL-21). */
function reservationIdOf(request: Request): string {
  const id = routeSegments(PRESALE_SPONSOR_EXECUTE_PATH, new URL(request.url).pathname)?.reservation_id ?? "";
  if (!RESERVATION_ID.test(id))
    throw new PresaleRouteError("invalid_parameter");
  return id;
}

/** `{ user_signature }`: exact keys and canonical base64, else `invalid_request`. */
function userSignatureOf(value: unknown): string {
  const parsed = executeSubmissionSchema.safeParse(value);
  if (!parsed.success) throw new PresaleRouteError("invalid_request");
  return parsed.data.user_signature;
}

function executeResponse(
  digest: string,
  outcome: SponsorExecutionOutcome,
): ExecuteResponse {
  return {
    digest,
    effects: { status: outcome.status, gas_used: `${outcome.gasUsed}` },
  };
}

type ExecutionWork = { background?: AfterResponseReservation };

const unconfirmed = (digest: string) =>
  new PresaleRouteError("execution_unconfirmed", { extra: { digest } });

/** The reservation's Privy DID, or null for a wallet session's `sui:` key (its commit is recorded unlinked). */
const privyAccountOf = (accountKey: string): string | null =>
  accountKey.startsWith("did:privy:") ? accountKey : null;

/**
 * `POST /api/presale/sponsor/{reservation_id}/execute`: submits the caller's
 * signed reservation through the gas pool exactly once, then settles it.
 *
 * 1. The Privy token (kit: `unauthorized`); the reservation must be the
 *    caller's and completed, else `not_found`.
 * 2. A settled reservation answers its stored outcome (`executed`,
 *    `failed_execution`: 200; `expired`: 410). A `submitted` one is settled
 *    by step 6 without resubmitting. An `unconfirmed` one is not settled: one
 *    bounded digest lookup settles it when the transaction landed late,
 *    else it answers 504 with the digest.
 * 3. At or after `expires_at` by the route's clock: `expired`, 410, unless
 *    another request changed the row first; then its current state answers.
 * 4. `user_signature` must be the sender's over `tx_bytes`, else
 *    `invalid_signature`; nothing is submitted. Each wrong signature counts
 *    in `presale_sponsor_bad_signature` for this reservation; the third
 *    expires it, so one reservation cannot be replayed with junk forever.
 * 4b. For capped intents, the platform daily limit (`presale_sponsor_exec_global`), counted only
 *    now (review H2): an expired reservation or a wrong signature never
 *    spends it. Full is `rate_limited`.
 * 5. One conditional update moves `reserved` to `submitted`; only its winner
 *    calls the pool's `execute_tx` (20 s), and the pool signs as sponsor.
 * 6. Effects for the stored digest settle the row (`executed` or
 *    `failed_execution`), count one `presale_sponsor_exec` unit for capped intents, and link an
 *    executed commit to the account. Any other pool outcome looks the digest
 *    up on chain for 15 s; without it the row is `unconfirmed`, 504 with the digest.
 *
 * After step 5 the route answers only 200 or `execution_unconfirmed`: a
 * submission's fate is never reported as a refusal.
 */
export function createPresaleSponsorExecuteRoute(
  dependencies: PresaleSponsorExecuteDependencies,
): (request: Request, client: ClientAddress) => Promise<Response> {
  const { executions } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());
  const sleep =
    dependencies.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const poolTimeoutMs =
    dependencies.poolTimeoutMs ?? GAS_POOL_EXECUTE_TIMEOUT_MS;
  const confirmWindowMs =
    dependencies.confirmWindowMs ?? EXECUTE_CONFIRM_WINDOW_MS;
  const pollIntervalMs =
    dependencies.pollIntervalMs ?? EXECUTE_POLL_INTERVAL_MS;

  /** The row again, or null when it cannot be read now (the caller keeps what it knows). */
  const reread = (row: SponsorExecutionRow) =>
    executions.find(row.id, row.privyDid).catch(() => null);

  /** A settled (or expired) row's stored answer. */
  function stored(
    context: PresaleRequestContext,
    row: SponsorExecutionRow,
  ): Response {
    if (
      row.outcome &&
      (row.state === "executed" || row.state === "failed_execution")
    )
      return context.json(executeResponse(row.digest, row.outcome));
    if (row.state === "expired")
      throw new PresaleRouteError("reservation_expired");
    throw unconfirmed(row.digest);
  }

  /**
   * Step 6 with effects: settles the row once. Only the request whose
   * conditional settle matched counts the budget unit and links an executed
   * commit (Q-003). A settlement the database cannot store still answers the
   * effects (they are the chain's) but counts and links nothing: the row
   * stays unsettled, and the request that later settles it counts once.
   */
  async function settle(
    context: PresaleRequestContext,
    work: ExecutionWork,
    row: SponsorExecutionRow,
    effects: SponsorExecutionEffects,
  ): Promise<Response> {
    const outcome = { status: effects.status, gasUsed: effects.gasUsed };
    let settled: boolean;
    try {
      settled = await executions.settle(row.id, outcome, clock());
    } catch (error) {
      recordPresaleMetric(METRIC, {
        outcome: "settle_failed",
        cause: errorLabel(error),
      });
      return context.json(executeResponse(row.digest, outcome));
    }
    if (!settled) {
      // Another request settled it first: its stored outcome answers.
      const current = await reread(row);
      return current?.outcome
        ? context.json(executeResponse(current.digest, current.outcome))
        : context.json(executeResponse(row.digest, outcome));
    }
    if (hasDailySponsorshipLimit(row.intent)) {
      try {
        const decision = await context.consume("presale_sponsor_exec");
        if (!decision.allowed)
          recordPresaleMetric(METRIC, { outcome: "over_daily_budget" });
      } catch (error) {
        recordPresaleMetric(METRIC, {
          outcome: "budget_count_failed",
          cause: errorLabel(error),
        });
      }
    }
    if (
      recordsCommit(row.intent) &&
      row.presaleId !== null &&
      outcome.status === "success"
    ) {
      const link = {
        presaleId: row.presaleId,
        txDigest: row.digest,
        privyDid: privyAccountOf(row.privyDid),
      };
      if (!work.background)
        throw new Error(
          "Commit settlement requires reserved background capacity.",
        );
      work.background.attach(() =>
        dependencies.outcomes.recordSponsoredCommit(link),
      );
      work.background = undefined;
    }
    recordPresaleMetric(METRIC, {
      outcome: outcome.status === "success" ? "executed" : "failed_execution",
      intent: row.intent,
    });
    return context.json(executeResponse(row.digest, outcome));
  }

  /** The digest's effects on chain, or null when the node does not have them (or cannot answer now). */
  async function onChain(
    digest: string,
  ): Promise<SponsorExecutionEffects | null> {
    try {
      const effects = await dependencies.transactions.effects(digest, {
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      return effects?.digest === digest ? effects : null;
    } catch {
      return null;
    }
  }

  /**
   * Step 6 without effects: until `deadline`, settles from the chain, or
   * answers whatever another request stored meanwhile. Then the row is
   * `unconfirmed` and the answer is 504 with the digest.
   */
  async function confirm(
    context: PresaleRequestContext,
    work: ExecutionWork,
    row: SponsorExecutionRow,
    deadline: number,
  ): Promise<Response> {
    for (;;) {
      const current = await reread(row);
      if (current && current.state !== "submitted")
        return answer(context, work, current);
      const effects = await onChain(row.digest);
      if (effects) return settle(context, work, row, effects);
      const left = deadline - clock().getTime();
      if (left <= 0) break;
      await sleep(Math.min(pollIntervalMs, left));
    }
    let moved = false;
    try {
      moved = await executions.unconfirm(row.id, clock());
    } catch (error) {
      recordPresaleMetric(METRIC, {
        outcome: "unconfirm_failed",
        cause: errorLabel(error),
      });
      throw unconfirmed(row.digest);
    }
    if (moved) {
      recordPresaleMetric(METRIC, {
        outcome: "unconfirmed",
        intent: row.intent,
      });
      throw unconfirmed(row.digest);
    }
    const current = await reread(row);
    if (current && current.state !== "submitted")
      return answer(context, work, current);
    throw unconfirmed(row.digest);
  }

  /**
   * Step 3's refusal. When the expire update matched nothing, another request
   * changed the row first (it submitted it with an earlier clock, or settled
   * it): the answer is the row's current state, never a 410 for a
   * reservation that is executing (Q-001).
   */
  async function expired(
    context: PresaleRequestContext,
    work: ExecutionWork,
    row: SponsorExecutionRow,
    now: Date,
  ): Promise<Response> {
    if (await executions.expire(row.id, row.privyDid, now))
      throw new PresaleRouteError("reservation_expired");
    const current = await executions.find(row.id, row.privyDid);
    if (!current) throw new PresaleRouteError("not_found");
    if (current.state === "reserved")
      throw new PresaleRouteError("reservation_expired");
    return answer(context, work, current);
  }

  /**
   * Step 4's count: one more wrong signature on this reservation. The third
   * (`presale_sponsor_bad_signature` refuses it) expires the reservation, so
   * its next call answers `reservation_expired`. A count or expiry that
   * fails is recorded and changes nothing else: the signature is refused
   * all the same.
   */
  async function countWrongSignature(row: SponsorExecutionRow): Promise<void> {
    try {
      const decision = await dependencies.limits.consume(
        "presale_sponsor_bad_signature",
        { attemptId: row.id },
      );
      if (decision.allowed) return;
      if (await executions.revoke(row.id, row.privyDid)) {
        recordPresaleMetric(METRIC, {
          outcome: "expired_after_invalid_signatures",
          intent: row.intent,
        });
      }
    } catch (error) {
      recordPresaleMetric(METRIC, {
        outcome: "signature_count_failed",
        cause: errorLabel(error),
      });
    }
  }

  function reserve(row: SponsorExecutionRow, work: ExecutionWork) {
    if (!recordsCommit(row.intent) || row.presaleId === null || work.background)
      return;
    const reservation = dependencies.reserveBackground();
    if (!reservation) throw new PresaleRouteError("service_unavailable");
    work.background = reservation;
  }

  /** Steps 3 to 6 for a `reserved` row. */
  async function submit(
    context: PresaleRequestContext,
    work: ExecutionWork,
    row: SponsorExecutionRow,
    userSignature: string,
  ): Promise<Response> {
    const now = clock();
    if (now.getTime() >= row.expiresAt.getTime())
      return expired(context, work, row, now);
    // The reservation's exact sender must sign its exact bytes. A node that
    // cannot check a zkLogin proof is not a wrong signature: it is not counted.
    const valid = await dependencies
      .verifySignature(row.txBytes, userSignature, row.sender)
      .catch((error: unknown) => {
        recordPresaleMetric(METRIC, {
          outcome: "signature_check_unavailable",
          cause: errorLabel(error),
        });
        throw new PresaleRouteError("service_unavailable");
      });
    if (!valid) {
      recordPresaleMetric(METRIC, { outcome: "invalid_signature" });
      await countWrongSignature(row);
      throw new PresaleRouteError("invalid_signature");
    }
    await dependencies.authorizeSubmission?.(row, context.request.signal);
    reserve(row, work);
    // Only capped intents consume the platform daily budget, after signature verification.
    if (hasDailySponsorshipLimit(row.intent)) {
      const global = await context.consume("presale_sponsor_exec_global");
      if (!global.allowed) {
        throw new PresaleRouteError("rate_limited", {
          retryAfterSeconds: global.retryAfterSeconds,
        });
      }
    }
    const pool = dependencies.pool();
    if (!(await executions.submit(row.id, row.privyDid, clock()))) {
      // Another request won the row, or it expired in between: answer from its current state.
      const current = await executions.find(row.id, row.privyDid);
      if (!current) throw new PresaleRouteError("not_found");
      if (current.state === "reserved")
        return expired(context, work, current, clock());
      return answer(context, work, current);
    }
    // The client never throws; any failure of another executor is an unknown fate all the same.
    const execution: GasPoolExecution = await pool
      .execute({ txBytes: row.txBytes, userSignature })
      .catch(
        () =>
          ({
            status: "unknown",
            reason: "transport",
            httpStatus: null,
          }) as const,
      );
    if (
      execution.status === "executed" &&
      execution.effects.digest === row.digest
    )
      return settle(context, work, row, execution.effects);
    recordPresaleMetric(METRIC, {
      outcome: "pool_unsettled",
      reason:
        execution.status === "executed" ? "digest_mismatch" : execution.reason,
      ...(execution.status === "unknown" && execution.httpStatus !== null
        ? { status: execution.httpStatus }
        : {}),
    });
    return confirm(context, work, row, clock().getTime() + confirmWindowMs);
  }

  /**
   * Step 2 for a row that is not `reserved`:
   * - `submitted`: settle it without resubmitting (step 6);
   * - `unconfirmed`: not settled. One bounded digest lookup; effects settle it
   *   as step 6 does (count once, link), else the stored 504 (B-001);
   * - `executed`, `failed_execution`, `expired`: the stored outcome.
   */
  async function answer(
    context: PresaleRequestContext,
    work: ExecutionWork,
    row: SponsorExecutionRow,
  ): Promise<Response> {
    if (row.state === "submitted" || row.state === "unconfirmed")
      reserve(row, work);
    if (row.state === "unconfirmed") {
      const effects = await onChain(row.digest);
      if (effects) return settle(context, work, row, effects);
      throw unconfirmed(row.digest);
    }
    if (row.state !== "submitted") return stored(context, row);
    // Wait at least as long as the submitter itself may (its overhead, its pool call, its window and
    // its last lookup), so a waiter never declares `unconfirmed` while the submitter can still settle.
    const now = clock().getTime();
    const submitterDeadline =
      (row.submittedAt?.getTime() ?? now) +
      poolTimeoutMs +
      confirmWindowMs +
      SUBMITTER_SLACK_MS;
    return confirm(
      context,
      work,
      row,
      Math.max(now + confirmWindowMs, submitterDeadline),
    );
  }

  return dependencies.kit.route(
    {
      name: "POST /api/presale/sponsor/{reservation_id}/execute",
      auth: "account_or_wallet",
      deployment: "none",
    },
    async (context) => {
      // The reservation's owner: the Privy DID, or `sui:<address>` for a wallet session (`sponsorAccountKey`).
      const caller = routeSponsorCaller(context);
      const did = caller && sponsorAccountKey(caller);
      if (!did) throw new PresaleRouteError("unauthorized");
      const id = reservationIdOf(context.request);
      // Per client IP on top of the account (WP3), once the path is a reservation id.
      const perIp = await context.consume("presale_sponsor_exec_ip");
      if (!perIp.allowed)
        throw new PresaleRouteError("rate_limited", {
          retryAfterSeconds: perIp.retryAfterSeconds,
        });
      const userSignature = userSignatureOf(
        await readJsonBody(context.request, { maxBytes: BODY_LIMIT_BYTES }),
      );
      const row = await executions.find(id, did);
      if (!row) throw new PresaleRouteError("not_found");
      const work: ExecutionWork = {};
      try {
        return await (row.state !== "reserved"
          ? answer(context, work, row)
          : submit(context, work, row, userSignature));
      } finally {
        work.background?.release();
      }
    },
  );
}
