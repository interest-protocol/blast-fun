import type { Pool } from "pg";

import type { VisitorLink } from "@blast/core/modules/launchpad-telemetry/contracts.ts";
import type { TransactionTimeouts } from "@blast/core/modules/database/pool.ts";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import type {
  PresaleCommitment,
  PresaleOutcomeRecord,
  PresaleOutcomeStore,
  PresaleRecordResult,
} from "./store.ts";

const MODULE = "presale-outcomes";

/**
 * Server-side budgets for each outcome transaction (the launchpad's
 * `LAUNCHPAD_STORAGE_TIMEOUTS`): a statement that waits or runs past them is
 * cancelled and rolled back, so a slow database answers `service_unavailable`
 * at once instead of holding the page's call.
 */
export const PRESALE_OUTCOME_STORAGE_TIMEOUTS: Readonly<TransactionTimeouts> =
  Object.freeze({
    statementTimeoutMs: 1_000,
    lockTimeoutMs: 500,
    idleInTransactionMs: 1_000,
  });

/** `presale_outcomes` and `presale_outcome_commitments` (migration 0043), as the web runtime role. */
export class PostgresPresaleOutcomeStore implements PresaleOutcomeStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** One bounded insert; the first receipt of a digest by a visitor is kept, a repeat is a duplicate. */
  async recordCommitment(
    commitment: PresaleCommitment,
  ): Promise<PresaleRecordResult> {
    const inserted = await withTransaction(
      this.#pool,
      (transaction) =>
        transaction.forModule(MODULE).write(
          "presale_outcome_commitments",
          `INSERT INTO presale_outcome_commitments (tx_digest, visitor_id, presale_id, committed_at)
         VALUES ($1, $2::uuid, $3, $4)
         ON CONFLICT (tx_digest, visitor_id) DO NOTHING`,
          [
            commitment.txDigest,
            commitment.visitorId,
            commitment.presaleId,
            commitment.committedAt,
          ],
        ),
      { timeouts: PRESALE_OUTCOME_STORAGE_TIMEOUTS },
    );
    return inserted.rowCount === 1 ? "recorded" : "duplicate";
  }

  /**
   * Records a verified outcome for its event's sender and decides its links,
   * in one bounded transaction, by the launchpad's rules
   * (`LaunchpadTelemetryRepository.recordOutcome`):
   *
   * 1. The digest's commitments are deleted and read: whatever this report
   *    decides, they are spent.
   * 2. A visitor link already recorded on the digest is the decision, whatever
   *    this report carries. Otherwise the reporter's own Privy session for the
   *    sender links its visitor (`privy_session`), or else the one visitor
   *    whose commitment was received strictly before the checkpoint's time
   *    (`signed_commitment`); none, or two or more (contested), is no link.
   *    Concurrent reports of a digest with commitments serialize on their row
   *    locks, so the later one sees the earlier one's link.
   * 3. The outcome is inserted once per completed event; a duplicate keeps its
   *    sender, checkpoint, time and position. A missing visitor link or
   *    account is written onto an existing outcome, never replacing one.
   */
  async recordOutcome(
    outcome: PresaleOutcomeRecord,
  ): Promise<Readonly<{ result: PresaleRecordResult; late: number }>> {
    const { completion } = outcome;
    return withTransaction(
      this.#pool,
      async (transaction) => {
        const store = transaction.forModule(MODULE);
        const commitments = await store.write<{
          visitor_id: string;
          on_time: boolean;
        }>(
          "presale_outcome_commitments",
          `DELETE FROM presale_outcome_commitments
           WHERE tx_digest = $1
           RETURNING visitor_id::text, committed_at < $2::timestamptz AS on_time`,
          [completion.txDigest, completion.completedAt],
        );
        const onTime = commitments.rows.filter((row) => row.on_time);
        const decided = await store.read<{
          visitor_id: string;
          visitor_link: VisitorLink;
        }>(
          `SELECT visitor_id::text, visitor_link FROM presale_outcomes
           WHERE tx_digest = $1 AND visitor_id IS NOT NULL
           ORDER BY recorded_at, event_seq
           LIMIT 1`,
          [completion.txDigest],
        );
        const link: Readonly<{
          visitorId: string;
          visitorLink: VisitorLink;
        }> | null = decided.rows[0]
          ? {
              visitorId: decided.rows[0].visitor_id,
              visitorLink: decided.rows[0].visitor_link,
            }
          : outcome.sessionVisitorId !== null
            ? {
                visitorId: outcome.sessionVisitorId,
                visitorLink: "privy_session",
              }
            : onTime.length === 1
              ? {
                  visitorId: onTime[0]!.visitor_id,
                  visitorLink: "signed_commitment",
                }
              : null;
        const inserted = await store.write(
          "presale_outcomes",
          `INSERT INTO presale_outcomes (
             tx_digest, event_seq, presale_id, sender_wallet, checkpoint, completed_at, visitor_id, visitor_link, privy_did
           ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::uuid, $8, $9)
           ON CONFLICT (tx_digest, event_seq) DO NOTHING`,
          [
            completion.txDigest,
            completion.eventSeq,
            outcome.presaleId,
            outcome.senderWallet,
            completion.checkpoint,
            completion.completedAt,
            link?.visitorId ?? null,
            link?.visitorLink ?? null,
            outcome.privyDid,
          ],
        );
        const result: PresaleRecordResult =
          inserted.rowCount === 1 ? "recorded" : "duplicate";
        if (result === "duplicate" && (link || outcome.privyDid)) {
          await store.write(
            "presale_outcomes",
            `UPDATE presale_outcomes
             SET visitor_id = CASE WHEN visitor_id IS NULL THEN $3::uuid ELSE visitor_id END,
                 visitor_link = CASE WHEN visitor_id IS NULL THEN $4 ELSE visitor_link END,
                 privy_did = coalesce(privy_did, $5)
             WHERE tx_digest = $1 AND event_seq = $2
               AND ((visitor_id IS NULL AND $3::uuid IS NOT NULL) OR (privy_did IS NULL AND $5::text IS NOT NULL))`,
            [
              completion.txDigest,
              completion.eventSeq,
              link?.visitorId ?? null,
              link?.visitorLink ?? null,
              outcome.privyDid,
            ],
          );
        }
        return { result, late: commitments.rows.length - onTime.length };
      },
      { timeouts: PRESALE_OUTCOME_STORAGE_TIMEOUTS },
    );
  }
}
