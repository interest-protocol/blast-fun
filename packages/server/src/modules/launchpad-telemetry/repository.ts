import type { Pool } from "pg";

import type { OwnedTable } from "@blast/core/modules/database/modules.ts";
import { autocommitRead, withTransaction } from "@blast/core/modules/database/transaction.ts";

import {
  OUTCOME_KINDS,
  type CoinViewSurface,
  type CompletedOutcome,
  type OutcomeKind,
  type OutcomeReport,
  type VisitorLink,
} from "@blast/core/modules/launchpad-telemetry/contracts.ts";
import { LAUNCHPAD_STORAGE_TIMEOUTS } from "@blast/server/modules/launchpad-telemetry/gate.ts";

/** Whether a record was new or a retry of one already stored. */
export type RecordResult = "recorded" | "duplicate";

export interface FirstCoinView {
  periodStart: string;
  visitorId: string;
  launchId: string;
  surface: CoinViewSurface;
  viewedAt: Date;
}

/** A visitor's commitment of a signed transaction's digest, as the server received it. */
export interface OutcomeCommitment extends OutcomeReport {
  visitorId: string;
  committedAt: Date;
}

/** What recording an outcome did: new or a duplicate, and how many of its commitments arrived late. */
export interface OutcomeRecord {
  result: RecordResult;
  /** Commitments of the digest received at or after its checkpoint's time (not linked). */
  late: number;
}

export interface OutcomeCounts {
  /** Completed outcomes of this kind in the period. */
  completed: number;
  /**
   * Visitors with a first view in the period whose own completed outcome of
   * this kind followed that view within the period.
   */
  convertedViewers: number;
}

/**
 * One reporting period of the funnel. Counts only: no visitor, wallet or
 * coin appears, and no volume is stored to rank by.
 */
export interface LaunchpadFunnelPeriod {
  periodStart: string;
  /** First views (one per visitor and coin). */
  firstViews: number;
  /** Distinct visitors with at least one first view. */
  viewers: number;
  outcomes: Record<OutcomeKind, OutcomeCounts>;
}

interface FunnelRow {
  period_start: string;
  kind: OutcomeKind;
  first_views: string;
  viewers: string;
  completed: string;
  converted: string;
}

const MODULE = "launchpad-telemetry";

/**
 * One insert in its own transaction with the storage budgets set by SET LOCAL
 * (safe behind Neon's transaction-mode PgBouncer). A statement that waits or
 * runs past them is cancelled by PostgreSQL and rolled back, so it neither
 * lingers on the server nor commits after its beacon was answered.
 */
async function boundedInsert(
  pool: Pool,
  table: OwnedTable<typeof MODULE>,
  text: string,
  values: readonly unknown[],
): Promise<RecordResult> {
  const result = await withTransaction(
    pool,
    (transaction) => transaction.forModule(MODULE).write(table, text, values),
    { timeouts: LAUNCHPAD_STORAGE_TIMEOUTS },
  );
  return result.rowCount === 1 ? "recorded" : "duplicate";
}

export class LaunchpadTelemetryRepository {
  /** One bounded insert; a repeated view in the same period is a duplicate. */
  recordFirstView(pool: Pool, view: FirstCoinView): Promise<RecordResult> {
    return boundedInsert(
      pool,
      "mission_control_launchpad_coin_views",
      `INSERT INTO mission_control_launchpad_coin_views (
         period_start, visitor_id, launch_id, surface, viewed_at
       ) VALUES ($1::date, $2::uuid, $3, $4, $5)
       ON CONFLICT (period_start, visitor_id, launch_id) DO NOTHING`,
      [view.periodStart, view.visitorId, view.launchId, view.surface, view.viewedAt],
    );
  }

  /** One bounded insert; the first receipt of a digest by a visitor is kept, a repeat is a duplicate. */
  recordCommitment(pool: Pool, commitment: OutcomeCommitment): Promise<RecordResult> {
    return boundedInsert(
      pool,
      "mission_control_launchpad_outcome_commitments",
      `INSERT INTO mission_control_launchpad_outcome_commitments (
         tx_digest, visitor_id, kind, launch_id, committed_at
       ) VALUES ($1, $2::uuid, $3, $4, $5)
       ON CONFLICT (tx_digest, visitor_id) DO NOTHING`,
      [commitment.txDigest, commitment.visitorId, commitment.kind, commitment.launchId, commitment.committedAt],
    );
  }

  /**
   * Records a completed outcome for its event's sender and decides its
   * visitor link, in one bounded transaction:
   *
   * 1. The digest's commitments are deleted and read: whatever this report
   *    decides, they are spent.
   * 2. The digest decides once, for every outcome of its transaction (a
   *    creation that includes the creator's first buy has a `buy` and a
   *    `launch`; every event of a transaction has the one sender). A link
   *    already recorded on any outcome of the digest is the decision: its
   *    visitor and its kind (`privy_session` or `signed_commitment`), whatever
   *    this report carries, and commitments read now arrived after it.
   *    Otherwise the link is the outcome's own (a verified Privy session the
   *    route checked), or else the one visitor whose commitment was received
   *    strictly before the checkpoint's time; none, or two or more, is no
   *    link. Concurrent reports of a digest that has commitments serialize
   *    on their row locks, so the later one sees the earlier one's link.
   * 3. The outcome is inserted once per completed event; a duplicate keeps its
   *    sender, checkpoint, time and position. A link is written onto an
   *    existing outcome only where it has none, never replacing one, and never
   *    onto a development row recorded before migration 0037 (no sender).
   */
  async recordOutcome(pool: Pool, outcome: CompletedOutcome): Promise<OutcomeRecord> {
    const { completion } = outcome;
    return withTransaction(
      pool,
      async (transaction) => {
        const store = transaction.forModule(MODULE);
        const commitments = await store.write<{ visitor_id: string; on_time: boolean }>(
          "mission_control_launchpad_outcome_commitments",
          `DELETE FROM mission_control_launchpad_outcome_commitments
           WHERE tx_digest = $1
           RETURNING visitor_id::text, committed_at < $2::timestamptz AS on_time`,
          [completion.txDigest, completion.completedAt],
        );
        const onTime = commitments.rows.filter((row) => row.on_time);
        const decided = await store.read<{ visitor_id: string; visitor_link: VisitorLink }>(
          `SELECT visitor_id::text, visitor_link FROM mission_control_launchpad_outcomes
           WHERE tx_digest = $1 AND visitor_id IS NOT NULL AND sender_wallet IS NOT NULL
           ORDER BY recorded_at, event_seq
           LIMIT 1`,
          [completion.txDigest],
        );
        const recorded = decided.rows[0];
        const link: Readonly<{ visitorId: string; visitorLink: VisitorLink }> | null = recorded
          ? { visitorId: recorded.visitor_id, visitorLink: recorded.visitor_link }
          : outcome.visitorId !== null
            ? { visitorId: outcome.visitorId, visitorLink: outcome.visitorLink }
            : onTime.length === 1
              ? { visitorId: onTime[0]!.visitor_id, visitorLink: "signed_commitment" }
              : null;
        const inserted = await store.write(
          "mission_control_launchpad_outcomes",
          `INSERT INTO mission_control_launchpad_outcomes (
             tx_digest, event_seq, kind, checkpoint, launch_id, sender_wallet, visitor_id, visitor_link, completed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, $8, $9::timestamptz)
           ON CONFLICT (tx_digest, event_seq) DO NOTHING`,
          [
            completion.txDigest,
            completion.eventSeq,
            outcome.kind,
            completion.checkpoint,
            outcome.launchId,
            outcome.senderWallet,
            link?.visitorId ?? null,
            link?.visitorLink ?? null,
            completion.completedAt,
          ],
        );
        const result: RecordResult = inserted.rowCount === 1 ? "recorded" : "duplicate";
        if (result === "duplicate" && link) {
          await store.write(
            "mission_control_launchpad_outcomes",
            `UPDATE mission_control_launchpad_outcomes
             SET visitor_id = $3::uuid, visitor_link = $4
             WHERE tx_digest = $1 AND event_seq = $2
               AND visitor_id IS NULL AND sender_wallet IS NOT NULL`,
            [completion.txDigest, completion.eventSeq, link.visitorId, link.visitorLink],
          );
        }
        return { result, late: commitments.rows.length - onTime.length };
      },
      { timeouts: LAUNCHPAD_STORAGE_TIMEOUTS },
    );
  }

  /** The funnel for each period starting at `periodStarts`, each `periodDays` long. */
  async funnel(
    pool: Pool,
    periodStarts: readonly string[],
    periodDays: number,
  ): Promise<LaunchpadFunnelPeriod[]> {
    const result = await autocommitRead<FunnelRow>(
      pool,
      MODULE,
      `SELECT period.start::text AS period_start, kind.kind,
              views.first_views, views.viewers,
              completed.total AS completed, converted.total AS converted
       FROM unnest($1::date[]) AS period(start)
       CROSS JOIN unnest($3::text[]) AS kind(kind)
       CROSS JOIN LATERAL (
         SELECT count(*) AS first_views, count(DISTINCT view.visitor_id) AS viewers
         FROM mission_control_launchpad_coin_views AS view
         WHERE view.period_start = period.start
       ) AS views
       CROSS JOIN LATERAL (
         SELECT count(*) AS total
         FROM mission_control_launchpad_outcomes AS outcome
         WHERE outcome.kind = kind.kind
           AND outcome.completed_at >= period.start::timestamp AT TIME ZONE 'UTC'
           AND outcome.completed_at < (period.start + $2::int)::timestamp AT TIME ZONE 'UTC'
       ) AS completed
       CROSS JOIN LATERAL (
         SELECT count(DISTINCT view.visitor_id) AS total
         FROM mission_control_launchpad_coin_views AS view
         WHERE view.period_start = period.start
           AND EXISTS (
             SELECT 1
             FROM mission_control_launchpad_outcomes AS outcome
             WHERE outcome.visitor_id = view.visitor_id
               AND outcome.kind = kind.kind
               AND outcome.completed_at >= view.viewed_at
               AND outcome.completed_at < (period.start + $2::int)::timestamp AT TIME ZONE 'UTC'
           )
       ) AS converted
       ORDER BY period.start, kind.kind`,
      [periodStarts, periodDays, OUTCOME_KINDS],
      { label: "launchpad-funnel" },
    );
    const periods = new Map<string, LaunchpadFunnelPeriod>();
    for (const row of result.rows) {
      let period = periods.get(row.period_start);
      if (!period) {
        period = {
          periodStart: row.period_start,
          firstViews: Number(row.first_views),
          viewers: Number(row.viewers),
          outcomes: {} as Record<OutcomeKind, OutcomeCounts>,
        };
        periods.set(row.period_start, period);
      }
      period.outcomes[row.kind] = {
        completed: Number(row.completed),
        convertedViewers: Number(row.converted),
      };
    }
    return [...periods.values()];
  }
}
