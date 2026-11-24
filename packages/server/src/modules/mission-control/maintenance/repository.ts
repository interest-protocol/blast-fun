import type { TransactionContext } from "@blast/core/modules/database/transaction.ts";
import type {
  MissionControlModule,
  OwnedTable,
} from "@blast/core/modules/database/modules.ts";
import {
  LAUNCHPAD_REPORTING_POLICY,
  outcomeCommitmentWindowMs,
} from "@blast/core/modules/launchpad-telemetry/contracts.ts";
import {
  ADMISSION_FAILURE_LOOKBACK_MS,
  ADMISSION_TTL_MS,
  CALLSIGN_ATTEMPT_WINDOW_MS,
  CLEANUP_GRACE_MS,
  MEMBER_SESSION_RETENTION_MS,
  type CleanupTable,
} from "@blast/core/modules/mission-control/maintenance/contracts.ts";

type TargetFor<M extends MissionControlModule> = Readonly<{
  /** The module that owns the table; cleanup writes go through it. */
  module: M;
  table: OwnedTable<M> & CleanupTable;
  /**
   * Rows that may be deleted, as a condition on the unaliased table. `$1` is
   * the batch size; the condition's own parameters start at `$2`.
   */
  eligible: string;
  parameters: (now: Date) => readonly Date[];
}>;

export type CleanupTarget = {
  [M in MissionControlModule]: TargetFor<M>;
}[MissionControlModule];

function before(now: Date, milliseconds: number): Date {
  return new Date(now.getTime() - milliseconds);
}

const LAUNCHPAD_TELEMETRY_RETENTION_MS =
  LAUNCHPAD_REPORTING_POLICY.retentionDays * 24 * 60 * 60 * 1_000;

/**
 * What each table keeps, and why:
 *
 * - Rate-limit windows are only read while current.
 * - OAuth states are only consumed before `expires_at`; a consumed or expired
 *   state is refused whether or not its row exists.
 * - Wallet challenges are verified only before `expires_at`. A consumed
 *   onboarding proof could be read again by an outstanding admission attempt.
 *   Keep the historical ADMISSION_TTL_MS retention window for consumed
 *   challenges.
 * - Past admission failures retain the original ADMISSION_FAILURE_LOOKBACK_MS.
 * - Past admission attempts were valid until `expires_at`. An attempt that
 *   completed is referenced by completion idempotency (a permanent record)
 *   and stays.
 * - Member sessions authorize only while unrevoked and unexpired; dead ones
 *   stay MEMBER_SESSION_RETENTION_MS past revocation or idle expiry (idle
 *   expiry never exceeds absolute expiry).
 * - Past callsign attempt limits keep their original window.
 * - Launchpad first views and outcomes are kept for the reporting policy's
 *   retention (launchpad-telemetry/contracts.ts); a view goes with its whole
 *   reporting period, by the period's first day in UTC.
 * - A launchpad outcome commitment is deleted by the report that decides its
 *   digest's link; one never decided goes after the deployment's short window
 *   (`LAUNCHPAD_OUTCOME_COMMITMENT_WINDOW_MINUTES`, never past the retention).
 * - Launchpad Wallet Proof challenges are consumed only before `expires_at`,
 *   in the transaction of the write they authorize; nothing reads one after
 *   it expires, spent or not.
 * - Presale outcomes and commitments (modules/presale/outcomes) mirror the
 *   launchpad's exactly: outcomes are kept for the launchpad reporting
 *   policy's retention, the lifetime of the visitor cookie that links them; a
 *   commitment no report has decided goes after the same window
 *   (`LAUNCHPAD_OUTCOME_COMMITMENT_WINDOW_MINUTES`, never past the retention).
 *
 * Events, idempotency, operator audit, memberships, and every other table are
 * never touched.
 */
export const CLEANUP_TARGETS: readonly CleanupTarget[] = [
  {
    module: "web-security",
    table: "mission_control_rate_limit_windows",
    eligible: "expires_at < $2",
    parameters: (now) => [before(now, CLEANUP_GRACE_MS)],
  },
  {
    module: "web-security",
    table: "mission_control_oauth_states",
    eligible: "expires_at < $2",
    parameters: (now) => [before(now, CLEANUP_GRACE_MS)],
  },
  {
    module: "wallet-challenge",
    table: "mission_control_wallet_challenges",
    eligible: "expires_at < $2 AND (consumed_at IS NULL OR expires_at < $3)",
    parameters: (now) => [
      before(now, CLEANUP_GRACE_MS),
      before(now, ADMISSION_TTL_MS + CLEANUP_GRACE_MS),
    ],
  },
  {
    module: "invitation",
    table: "mission_control_admission_failures",
    eligible: "occurred_at < $2",
    parameters: (now) => [
      before(now, ADMISSION_FAILURE_LOOKBACK_MS + CLEANUP_GRACE_MS),
    ],
  },
  {
    module: "invitation",
    table: "mission_control_admission_attempts",
    eligible: `expires_at < $2
      AND NOT EXISTS (
        SELECT 1
        FROM mission_control_completion_idempotency AS idempotency
        WHERE idempotency.attempt_id = mission_control_admission_attempts.attempt_id
      )`,
    parameters: (now) => [before(now, CLEANUP_GRACE_MS)],
  },
  {
    module: "session",
    table: "mission_control_member_sessions",
    eligible: "(revoked_at < $2 OR idle_expires_at < $2)",
    parameters: (now) => [before(now, MEMBER_SESSION_RETENTION_MS)],
  },
  {
    module: "profile",
    table: "mission_control_callsign_attempt_limits",
    eligible: "window_started_at < $2",
    parameters: (now) => [
      before(now, CALLSIGN_ATTEMPT_WINDOW_MS + CLEANUP_GRACE_MS),
    ],
  },
  {
    module: "launchpad-telemetry",
    table: "mission_control_launchpad_coin_views",
    eligible: "period_start < ($2::timestamptz AT TIME ZONE 'UTC')::date",
    parameters: (now) => [before(now, LAUNCHPAD_TELEMETRY_RETENTION_MS)],
  },
  {
    module: "launchpad-telemetry",
    table: "mission_control_launchpad_outcomes",
    eligible: "completed_at < $2",
    parameters: (now) => [before(now, LAUNCHPAD_TELEMETRY_RETENTION_MS)],
  },
  {
    module: "launchpad-telemetry",
    table: "mission_control_launchpad_outcome_commitments",
    eligible: "committed_at < $2",
    parameters: (now) => [
      before(
        now,
        outcomeCommitmentWindowMs(
          process.env.LAUNCHPAD_OUTCOME_COMMITMENT_WINDOW_MINUTES,
        ),
      ),
    ],
  },
  {
    module: "launchpad-identity",
    table: "mission_control_launchpad_wallet_challenges",
    eligible: "expires_at < $2",
    parameters: (now) => [before(now, CLEANUP_GRACE_MS)],
  },
  {
    module: "presale-outcomes",
    table: "presale_outcomes",
    eligible: "completed_at < $2",
    parameters: (now) => [before(now, LAUNCHPAD_TELEMETRY_RETENTION_MS)],
  },
  {
    module: "presale-outcomes",
    table: "presale_outcome_commitments",
    eligible: "committed_at < $2",
    parameters: (now) => [
      before(
        now,
        outcomeCommitmentWindowMs(
          process.env.LAUNCHPAD_OUTCOME_COMMITMENT_WINDOW_MINUTES,
        ),
      ),
    ],
  },
];

/**
 * Deletes up to `batchSize` eligible rows of one table and returns how many.
 *
 * The inner SELECT picks the batch by ctid (a TID scan, no second index
 * lookup). If a picked row is updated concurrently (a callsign window that
 * restarts, say), the DELETE waits and then re-checks the row's newest
 * version, whose ctid no longer matches, so it survives until a later run.
 * The eligibility condition is repeated in the outer WHERE so that safety does
 * not rest on the ctid recheck alone.
 */
export async function deleteExpiredBatch(
  transaction: TransactionContext,
  target: CleanupTarget,
  now: Date,
  batchSize: number,
): Promise<number> {
  const result = await transaction.forModule(target.module).write(
    target.table,
    `DELETE FROM ${target.table}
     WHERE ctid = ANY (ARRAY(
       SELECT ctid
       FROM ${target.table}
       WHERE ${target.eligible}
       LIMIT $1
     ))
       AND ${target.eligible}`,
    [batchSize, ...target.parameters(now)],
  );
  return result.rowCount ?? 0;
}
