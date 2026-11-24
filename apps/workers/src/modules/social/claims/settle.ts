import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import { CLAIM_SENT_EXPIRY_MS, CLAIM_UNSENT_EXPIRY_MS } from "@blast/core/modules/social/contracts/claims.ts";
import { settleLoggedTransaction } from "@blast/core/modules/social/transactions/log.ts";
import { creatorClaimStep } from "./creator.ts";
import { LAUNCH_CLAIM_PAGE_SQL, launchClaimStep } from "./launch.ts";
import { VESTING_CLAIM_PAGE_SQL, vestingClaimStep } from "./vesting.ts";
import {
  readStepCursor,
  writeStepCursor,
  type SocialWorkerBounds,
  type SocialWorkerStep,
  type SocialWorkerStepReport,
} from "../worker/steps.ts";

export type { VestingClaimExecution } from "./vesting.ts";

/**
 * The social worker's claim step (R3-63, closing R3-27's known gap for
 * claims): a claim the browser recorded and then never came back to settle
 * — the tab closed after signing, the network dropped — is settled from the
 * indexer, as T-026 settles commits, and an attempt that never reached the
 * chain is marked `expired` rather than left `Pending` in `This session`
 * for ever.
 *
 * - **Settle.** An open claim (`submitted`, with a digest) whose transaction
 *   `chain_read_v1.activity` now shows as a `presale_claim`, up to the
 *   presale pipeline's watermark: `confirmed` when one of its claim rows paid
 *   a wallet of the row's account from the row's sale, `failed` /
 *   `mismatch` otherwise, at the chain's time. An aborted claim emits no
 *   event, so it is never found here; the route settles it from the
 *   fullnode, or the expiry does. Vesting claims use their own bounded
 *   shared evidence step: native transaction and event facts prove the digest,
 *   while aggregate schedule totals establish no individual result.
 * - **Expire.** On the chain's clock (the watermark's time, so a lagging
 *   indexer never expires a claim it has not reached): an open claim with
 *   no digest after `CLAIM_UNSENT_EXPIRY_MS` (one hour; nothing was ever
 *   sent), and a sent refund/token claim after `CLAIM_SENT_EXPIRY_MS` (the
 *   commits' 24 hours), become `failed` / `expired`. A sent vesting claim
 *   expires after the same day only while `chain_read_v1.transaction_evidence`
 *   has no row for its digest; one with evidence waits for the vesting step,
 *   which leaves it open when it cannot judge it (a key with no schedule, a
 *   schedule the views do not list, malformed evidence). A claim whose
 *   transaction ran before the indexer's coverage, or more than a day after
 *   it was recorded, has no evidence and expires although it may have run.
 *   At most every `CLAIM_EXPIRY_EVERY_MS`.
 *
 * The steps run as `blast_watcher`, which 0085 lets read and update the log and
 * nothing else; 0084's trigger keeps every fact and every settled row as it
 * is, and every statement is guarded on `state = 'submitted'`, so a race
 * with the route's own settlement, a repeat pass and two workers all change
 * a row once. They read open claims through 0096's partial index, whose size
 * is the claims in flight, never the log.
 */

export type ClaimStepsConfig = Readonly<{
  /** Claims settled per pass (`SOCIAL_NOTIFICATION_BATCH`, shared with the other steps). */
  batchSize: number;
}>;

/** The claim kinds of the log, the partial index's own predicate. */
const OPEN_CLAIM = "t.state = 'submitted' AND t.kind IN ('claim_refund', 'claim_tokens', 'claim_vesting')";

/**
 * The oldest open claims whose transaction the indexer has reached, with
 * whether one of its claim rows paid the row's own account from its sale.
 * The lateral aggregate is one probe of the activity's digest index per open
 * claim, and an open claim not on chain yet costs only its index entry.
 */
const SETTLE_BATCH_SQL = `SELECT t.account_id::text AS account_id, t.idempotency_key, t.digest,
    seen.paid_own, seen.timestamp_ms::text AS timestamp_ms
  FROM social_transactions t
  CROSS JOIN LATERAL (
    SELECT bool_or(
        a.presale_id = t.presale_id
        AND EXISTS (SELECT 1 FROM social_wallet_owners o WHERE o.address = a.actor AND o.account_id = t.account_id)
      ) AS paid_own,
      max(a.timestamp_ms) AS timestamp_ms
    FROM chain_read_v1.activity a
    WHERE a.digest = t.digest AND a.kind = 'presale_claim' AND a.checkpoint <= $1
  ) seen
  WHERE ${OPEN_CLAIM} AND t.kind <> 'claim_vesting' AND t.digest IS NOT NULL AND seen.timestamp_ms IS NOT NULL
  ORDER BY t.created_at_ms, t.tx_id
  LIMIT $2`;
assertChainReadThroughViews(SETTLE_BATCH_SQL);

/**
 * Open claims past their time: no digest after an hour, sent refund/token and launch claims after
 * a day (blast-infra's native evidence holds every launchpad transaction, so a day without it is
 * one that never ran), and sent vesting claims after a day with no evidence row for the digest
 * (blast-infra#169 keeps only transactions with a kept event or a call to a kept package, so an
 * unrelated digest never gains evidence). Evidence the watermark has not reached keeps the claim.
 * The range on `created_at_ms` is the partial index's key.
 */
const EXPIRE_SQL = `UPDATE social_transactions t
  SET state = 'failed', failure_code = 'expired', settled_at_ms = GREATEST($3::bigint, t.created_at_ms)
  WHERE ((${OPEN_CLAIM}) OR (t.state='submitted' AND t.kind IN ('collect_fees','claim_residuals') AND t.digest IS NULL)
      OR (t.state='submitted' AND t.kind IN ('claim_launch_fees','claim_launch_lp_fees'))) AND t.created_at_ms < $1
    AND (t.digest IS NULL OR (t.created_at_ms < $2 AND (t.kind <> 'claim_vesting'
      OR NOT EXISTS (SELECT 1 FROM chain_read_v1.transaction_evidence e WHERE e.digest = t.digest))))`;
assertChainReadThroughViews(EXPIRE_SQL);

/** How often the expiry runs, at most. */
export const CLAIM_EXPIRY_EVERY_MS = 10 * 60_000;

type SettleRow = Readonly<{ account_id: string; idempotency_key: string; digest: string; paid_own: boolean; timestamp_ms: string }>;

async function settleStep(
  tx: ModuleTransaction<"social">,
  bounds: SocialWorkerBounds,
  config: ClaimStepsConfig,
): Promise<SocialWorkerStepReport> {
  const { rows } = await tx.read<SettleRow>(SETTLE_BATCH_SQL, [bounds.checkpoint, config.batchSize]);
  let confirmed = 0;
  let failed = 0;
  for (const row of rows) {
    const settledAtMs = Number(row.timestamp_ms);
    const outcome = await settleLoggedTransaction(
      tx,
      { accountId: row.account_id, idempotencyKey: row.idempotency_key },
      row.paid_own
        ? { state: "confirmed", digest: row.digest, settledAtMs }
        : { state: "failed", failureCode: "mismatch", settledAtMs },
    );
    if (outcome !== "settled") continue;
    if (row.paid_own) confirmed += 1;
    else failed += 1;
  }
  return { claims_confirmed: confirmed, claims_failed: failed };
}

async function expiryStep(
  tx: ModuleTransaction<"social">,
  bounds: SocialWorkerBounds,
  lastRun: Readonly<{ at: number }> | null,
): Promise<Readonly<{ report: SocialWorkerStepReport; at: number }>> {
  const chainNow = bounds.timestampMs;
  if (lastRun !== null && chainNow - lastRun.at < CLAIM_EXPIRY_EVERY_MS) return { report: {}, at: lastRun.at };
  const expired = await tx.write("social_transactions", EXPIRE_SQL, [
    chainNow - CLAIM_UNSENT_EXPIRY_MS,
    chainNow - CLAIM_SENT_EXPIRY_MS,
    chainNow,
  ]);
  return { report: { claims_expired: expired.rowCount ?? 0 }, at: chainNow };
}

/** The claim steps, in pass order, bounded by the presale pipeline's checkpoint and clock. */
export function claimSteps(config: ClaimStepsConfig): readonly SocialWorkerStep[] {
  return Object.freeze([
    {
      name: "claim-settle",
      pipeline: "presale" as const,
      run: (tx, bounds) => settleStep(tx, bounds!, config),
    },
    vestingClaimStep(config),
    creatorClaimStep(config),
    launchClaimStep(config),
    {
      name: "claim-expiry",
      pipeline: "presale" as const,
      async run(tx, bounds) {
        const cursor = await readStepCursor<Readonly<{ at: number }>>(tx, "claim-expiry");
        const { report, at } = await expiryStep(tx, bounds!, cursor);
        if (cursor === null || at !== cursor.at) await writeStepCursor(tx, "claim-expiry", { at });
        return report;
      },
    },
  ] satisfies SocialWorkerStep[]);
}

/** The steps' statements, for EXPLAIN checks and the scale record. */
export const CLAIM_STATEMENTS = Object.freeze({
  settleBatch: SETTLE_BATCH_SQL,
  vestingPage: VESTING_CLAIM_PAGE_SQL,
  launchPage: LAUNCH_CLAIM_PAGE_SQL,
  expire: EXPIRE_SQL,
});
