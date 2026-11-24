import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import { SHOWN_PRESALES, SHOWN_ACTIVITY } from "@blast/core/modules/social/read-model/chain-presales.ts";
import {
  readStepCursor,
  writeStepCursor,
  type SocialWorkerBounds,
  type SocialWorkerStep,
  type SocialWorkerStepReport,
} from "../worker/steps.ts";

/**
 * The milestone generator (social-feed T-027 and T-029): two social worker
 * steps that turn presale progress into `social_milestones` rows (0054),
 * which `social_feed_entries` (0055) publishes as presale posts
 * (`milestone_participants`, `milestone_raise`, `milestone_holders`).
 *
 * Step `milestone-commits` (presale pipeline): new `presale_commit` rows of
 * `chain_read_v1.activity`, in total order, never past the presale
 * pipeline's watermark, at most `batchSize` a pass.
 *
 * - **Participants.** For each `participant_milestones` value `v` a commit
 *   takes the sale's backer count to or past for the first time (the count
 *   before it is under `v`, the count after it is `v` or more), one entry
 *   `m:<presale_id>:participants:<v>` with that commit's time, digest and
 *   activity id. A commit that passes two values writes two entries.
 * - **Raise.** When a commit takes the sale's total to its `raise_target`
 *   (`SHOWN_PRESALES`, the T-020 alignment's filter over
 *   `chain_read_v1.presales`) or past it for the first time, one entry
 *   `m:<presale_id>:raise:<raise_target>`. A sale blast-infra has not
 *   finished (no sale decimals, an unlisted quote, an unknown venue) is in
 *   no list, page or feed item, so it gets no raise post either; the filter
 *   reads the sale's current row, so a sale completed after its crossing
 *   commit has already passed the cursor and its raise post is written only
 *   if the cursor is replayed. In practice the presale's creation takes
 *   `&mut Currency<SaleToken>`, so the metadata is seen in the creating
 *   checkpoint, before any commit.
 *
 * Only sales the web shows: both kinds read a commit only when its sale is in
 * `SHOWN_PRESALES` (`SHOWN_ACTIVITY` in the batch). blast-infra hides
 * T-043's test sales from its presale views but not from
 * `chain_read_v1.activity`, so before 2026-10-05 a hidden sale's commits
 * wrote participant milestones (posts with no sale to show). The batch end
 * still counts every commit, so a hidden commit only makes a pass shorter,
 * and the feed's reads drop a milestone of a sale not shown as well. Like
 * the raise rule, a sale shown only after its crossing commit passed the
 * cursor gets its milestones only from a replay.
 *
 * "Before" is the sale's previous commit in total order: the previous row of
 * the batch, or for a sale's first commit in the batch one indexed lookup of
 * its latest earlier commit (none: 0). A value added to the config later
 * therefore waits for a real crossing; it is never written at a commit that
 * did not cross it.
 *
 * Idempotency: an entry id is derived from the sale, the kind and the
 * threshold (0054's check), inserted with `ON CONFLICT DO NOTHING`, and the
 * cursor is stored in the same transaction as the writes. A repeated pass, a
 * restart, a replayed cursor or a lost lease mid-pass never writes a second
 * entry for a milestone; the earliest crossing in the batch wins.
 *
 * Unlike the notification steps, a first pass starts at the origin, not at
 * the watermark: a milestone is a post dated at its commit, so history is
 * written (in batches, oldest first), not skipped.
 *
 * Reads go through `chain_read_v1` views only. Order and ranges use
 * `(timestamp_ms, checkpoint, tx_slot, event_slot, part)`: Sui checkpoint
 * times never decrease, so this is the activity total order, and it lets the
 * activity time index (`timestamp_ms DESC`) serve the range with no sort of
 * the history.
 *
 * Step `milestone-holders` (T-029, market pipeline): new
 * `chain_read_v1.coin_holder_history` rows of the sale coins of shown
 * presales, in checkpoint order, at most `batchSize` a pass.
 *
 * - **Holders.** For each `holder_milestones` value `v` a history row takes
 *   the coin's holder count to or past for the first time, one entry
 *   `m:<presale_id>:holders:<v>` with that row's time and the coin type. A
 *   row that passes two values writes two entries; a drop and a rise past a
 *   value already written adds nothing (its entry id already exists).
 * - **Both watermarks.** The rows come from the market pipeline, the sale
 *   coins from the presale pipeline, so the step is a market step whose
 *   batch is additionally capped at `presale_checkpoint`: a history row the
 *   market pipeline has committed in a checkpoint the presale pipeline has
 *   not reached could belong to a sale coin whose `PresaleCreated` is not
 *   indexed yet, and advancing past it would lose that sale's milestone for
 *   good. A sale coin's holders exist only after its presale is created, so
 *   capping the batch there is enough. T-025's step interface hands a step
 *   the bounds of one pipeline, so the step reads `chain_read_v1.watermark`
 *   itself inside its own transaction (one row); the interface is unchanged.
 * - **Reading order.** blast-infra indexes `coin_holder_history` by
 *   `(coin_type, checkpoint)` and by nothing else (T-037), so there is no
 *   index that serves a checkpoint-ordered scan across coins. The step
 *   therefore drives from the shown presales and range-scans each sale coin
 *   on that index, merging the rows; the cursor is the one checkpoint the
 *   pass read up to, and the batch ends at the `batchSize`-th smallest
 *   checkpoint of the merged rows, so one pass is bounded in rows and holds
 *   a bounded transaction.
 *
 * Both steps share the idempotency, the origin-first backfill and the
 * `social_config` reader; only their pipeline, cursor and source differ.
 */

export type MilestoneStepsConfig = Readonly<{
  /** Rows read per pass by each step (`SOCIAL_NOTIFICATION_BATCH`, shared with the notification steps). */
  batchSize: number;
  /** `participant_milestones` (`social_config`), read per pass through the 30 s cached reader. */
  participantMilestones: () => Promise<readonly number[]>;
  /** `holder_milestones` (`social_config`), read per pass through the 30 s cached reader. */
  holderMilestones: () => Promise<readonly number[]>;
}>;

/** An activity position past any slot in a checkpoint. */
const SLOT_MAX = 2_147_483_647;

/** The last commit a pass read: `(checkpoint, tx_slot, event_slot, part)` and its time. */
export type CommitCursor = Readonly<{ c: number; t: number; e: number; p: number; ts: number }>;

/** Before the first commit of the chain. */
const ORIGIN: CommitCursor = { c: -1, t: -1, e: -1, p: -1, ts: 0 };

/** Commit rows the steps read: a presale's commit with its counters after it. */
const COMMIT_ROW = `a.kind = 'presale_commit' AND a.presale_id IS NOT NULL
    AND a.participants_after IS NOT NULL AND a.total_commitments_after IS NOT NULL`;

/**
 * The `$8`-th commit after the cursor (`$1` time, `$3`..`$6` position), if
 * there are that many up to the watermark (`$2` checkpoint, `$7` its time).
 */
const BATCH_END = `
  SELECT a.checkpoint::text AS c, a.tx_slot AS t, a.event_slot AS e, a.part AS p, a.timestamp_ms::text AS ts
  FROM ${SHOWN_ACTIVITY} a
  WHERE a.timestamp_ms >= $1::bigint AND a.timestamp_ms <= $7::bigint AND a.checkpoint <= $2::bigint
    AND (a.checkpoint, a.tx_slot, a.event_slot, a.part) > ($3::bigint, $4::int, $5::int, $6::int)
    AND ${COMMIT_ROW}
  ORDER BY a.timestamp_ms, a.checkpoint, a.tx_slot, a.event_slot, a.part
  OFFSET $8::int - 1 LIMIT 1`;

/**
 * The milestones of one pass's commits: after the cursor (`$1` time, `$3`..`$6`
 * position), up to the batch end (`$7`..`$10` position, `$11` time), never past
 * the watermark (`$2`); `$12` the participant milestones.
 */
const MILESTONES_INSERT = `INSERT INTO social_milestones (entry_id, presale_id, coin_type, kind, value, activity_id, digest, timestamp_ms)
  WITH batch AS MATERIALIZED (
    SELECT a.activity_id, a.checkpoint, a.tx_slot, a.event_slot, a.part, a.timestamp_ms, a.digest, a.presale_id,
      a.participants_after, a.total_commitments_after,
      lag(a.participants_after) OVER sale AS participants_lag,
      lag(a.total_commitments_after) OVER sale AS total_lag,
      row_number() OVER sale AS nth
    FROM ${SHOWN_ACTIVITY} a
    WHERE a.timestamp_ms >= $1::bigint AND a.timestamp_ms <= $11::bigint AND a.checkpoint <= $2::bigint
      AND (a.checkpoint, a.tx_slot, a.event_slot, a.part) > ($3::bigint, $4::int, $5::int, $6::int)
      AND (a.checkpoint, a.tx_slot, a.event_slot, a.part) <= ($7::bigint, $8::int, $9::int, $10::int)
      AND ${COMMIT_ROW}
    WINDOW sale AS (PARTITION BY a.presale_id ORDER BY a.timestamp_ms, a.checkpoint, a.tx_slot, a.event_slot, a.part)
  ), steps AS MATERIALIZED (
    SELECT b.activity_id, b.checkpoint, b.tx_slot, b.event_slot, b.part, b.timestamp_ms, b.digest, b.presale_id,
      b.participants_after, b.total_commitments_after,
      COALESCE(CASE WHEN b.nth = 1 THEN prior.participants_after ELSE b.participants_lag END, 0) AS participants_before,
      COALESCE(CASE WHEN b.nth = 1 THEN prior.total_commitments_after ELSE b.total_lag END, 0) AS total_before
    FROM batch b
    LEFT JOIN LATERAL (
      SELECT a.participants_after, a.total_commitments_after
      FROM ${SHOWN_ACTIVITY} a
      WHERE b.nth = 1 AND a.presale_id = b.presale_id AND a.timestamp_ms <= b.timestamp_ms
        AND (a.checkpoint, a.tx_slot, a.event_slot, a.part) < (b.checkpoint, b.tx_slot, b.event_slot, b.part)
        AND ${COMMIT_ROW}
      ORDER BY a.timestamp_ms DESC, a.checkpoint DESC, a.tx_slot DESC, a.event_slot DESC, a.part DESC
      LIMIT 1
    ) AS prior ON true
  ), crossings AS (
    SELECT 'participants'::text AS kind, m.value::numeric AS value, s.*
    FROM steps s
    JOIN unnest($12::bigint[]) AS m (value) ON s.participants_before < m.value AND s.participants_after >= m.value
    UNION ALL
    SELECT 'raise', p.raise_target, s.*
    FROM steps s
    JOIN ${SHOWN_PRESALES} p ON p.presale_id = s.presale_id
    WHERE p.raise_target > 0 AND s.total_before < p.raise_target AND s.total_commitments_after >= p.raise_target
  )
  SELECT DISTINCT ON (x.entry_id) x.entry_id, x.presale_id, NULL, x.kind, x.value, x.activity_id, x.digest, x.timestamp_ms
  FROM (SELECT 'm:' || c.presale_id || ':' || c.kind || ':' || c.value::text AS entry_id, c.* FROM crossings c) AS x
  ORDER BY x.entry_id, x.timestamp_ms, x.checkpoint, x.tx_slot, x.event_slot, x.part
  ON CONFLICT (entry_id) DO NOTHING`;

/** The presale pipeline's checkpoint, which also caps the holder step's batch. */
const PRESALE_WATERMARK = `SELECT presale_checkpoint::text AS c FROM chain_read_v1.watermark`;

/** The last holder-history checkpoint a pass read. */
export type HolderCursor = Readonly<{ c: number }>;

/** Before the first holder-history row of the chain (checkpoints are never negative). */
const HOLDERS_ORIGIN: HolderCursor = { c: -1 };

/** A shown presale's sale-coin history after the cursor (`$1`), up to the bound (`$2`). */
const HOLDER_ROWS = `SELECT g.coin_type, g.checkpoint, g.timestamp_ms, g.holders
      FROM chain_read_v1.coin_holder_history g
      WHERE g.coin_type = p.sale_token AND g.checkpoint > $1::bigint AND g.checkpoint <= $2::bigint`;

/**
 * The `$3`-th smallest history checkpoint after the cursor (`$1`), up to the
 * bound (`$2`), over the shown presales' sale coins: the pass's last
 * checkpoint. No row when fewer than `$3` remain, and the pass then runs to
 * the bound. Each coin is a range scan of blast-infra's `(coin_type,
 * checkpoint)` index, capped at `$3` rows, so the merge is bounded too.
 */
const HOLDERS_BATCH_END = `
  SELECT r.checkpoint::text AS c
  FROM ${SHOWN_PRESALES} p
  JOIN LATERAL (${HOLDER_ROWS} ORDER BY g.checkpoint LIMIT $3::int) AS r ON true
  ORDER BY r.checkpoint
  OFFSET $3::int - 1 LIMIT 1`;

/**
 * The holder milestones of one pass's rows: after the cursor (`$1`), up to
 * the batch end (`$3`), never past the bound (`$2`); `$4` the holder
 * milestones.
 */
const HOLDERS_INSERT = `INSERT INTO social_milestones (entry_id, presale_id, coin_type, kind, value, activity_id, digest, timestamp_ms)
  WITH batch AS MATERIALIZED (
    SELECT p.presale_id, r.coin_type, r.checkpoint, r.timestamp_ms, r.holders,
      lag(r.holders) OVER coin AS holders_lag,
      row_number() OVER coin AS nth
    FROM ${SHOWN_PRESALES} p
    JOIN LATERAL (${HOLDER_ROWS} AND g.checkpoint <= $3::bigint ORDER BY g.checkpoint) AS r ON true
    WINDOW coin AS (PARTITION BY r.coin_type ORDER BY r.checkpoint)
  ), steps AS MATERIALIZED (
    SELECT b.presale_id, b.coin_type, b.checkpoint, b.timestamp_ms, b.holders,
      COALESCE(CASE WHEN b.nth = 1 THEN prior.holders ELSE b.holders_lag END, 0) AS holders_before
    FROM batch b
    LEFT JOIN LATERAL (
      SELECT g.holders
      FROM chain_read_v1.coin_holder_history g
      WHERE b.nth = 1 AND g.coin_type = b.coin_type AND g.checkpoint <= $1::bigint
      ORDER BY g.checkpoint DESC
      LIMIT 1
    ) AS prior ON true
  )
  SELECT DISTINCT ON (x.entry_id) x.entry_id, x.presale_id, x.coin_type, 'holders', x.value, NULL, NULL, x.timestamp_ms
  FROM (
    SELECT 'm:' || s.presale_id || ':holders:' || m.value::numeric::text AS entry_id, m.value::numeric AS value, s.*
    FROM steps s
    JOIN unnest($4::bigint[]) AS m (value) ON s.holders_before < m.value AND s.holders >= m.value
  ) AS x
  ORDER BY x.entry_id, x.timestamp_ms, x.checkpoint
  ON CONFLICT (entry_id) DO NOTHING`;

for (const statement of [BATCH_END, MILESTONES_INSERT, PRESALE_WATERMARK, HOLDERS_BATCH_END, HOLDERS_INSERT]) {
  assertChainReadThroughViews(statement);
}

const written = (result: { rowCount: number | null }) => result.rowCount ?? 0;

const STEP = "milestone-commits";
const HOLDERS_STEP = "milestone-holders";

async function commitsStep(
  tx: ModuleTransaction<"social">,
  bounds: SocialWorkerBounds,
  config: MilestoneStepsConfig,
): Promise<SocialWorkerStepReport> {
  const cursor = (await readStepCursor<CommitCursor>(tx, STEP)) ?? ORIGIN;
  if (cursor.c >= bounds.checkpoint && cursor.t === SLOT_MAX) return {};
  const from = [cursor.ts, bounds.checkpoint, cursor.c, cursor.t, cursor.e, cursor.p] as const;
  const { rows } = await tx.read<{ c: string; t: number; e: number; p: number; ts: string }>(BATCH_END, [
    ...from, bounds.timestampMs, config.batchSize,
  ]);
  const last = rows[0];
  const end: CommitCursor = last
    ? { c: Number(last.c), t: last.t, e: last.e, p: last.p, ts: Number(last.ts) }
    : { c: bounds.checkpoint, t: SLOT_MAX, e: SLOT_MAX, p: SLOT_MAX, ts: bounds.timestampMs };
  const milestones = [...(await config.participantMilestones())];
  const inserted = await tx.write("social_milestones", MILESTONES_INSERT, [...from, end.c, end.t, end.e, end.p, end.ts, milestones]);
  await writeStepCursor(tx, STEP, end);
  return { milestones_written: written(inserted) };
}

async function holdersStep(
  tx: ModuleTransaction<"social">,
  bounds: SocialWorkerBounds,
  config: MilestoneStepsConfig,
): Promise<SocialWorkerStepReport> {
  const { rows: watermark } = await tx.read<{ c: string | null }>(PRESALE_WATERMARK);
  const presaleCheckpoint = watermark[0]?.c;
  // No presale checkpoint means no indexed sale, so no sale coin has holders yet.
  if (presaleCheckpoint == null) return {};
  const bound = Math.min(bounds.checkpoint, Number(presaleCheckpoint));
  const cursor = (await readStepCursor<HolderCursor>(tx, HOLDERS_STEP)) ?? HOLDERS_ORIGIN;
  if (cursor.c >= bound) return {};
  const { rows } = await tx.read<{ c: string }>(HOLDERS_BATCH_END, [cursor.c, bound, config.batchSize]);
  const end: HolderCursor = rows[0] ? { c: Number(rows[0].c) } : { c: bound };
  const milestones = [...(await config.holderMilestones())];
  const inserted = await tx.write("social_milestones", HOLDERS_INSERT, [cursor.c, bound, end.c, milestones]);
  await writeStepCursor(tx, HOLDERS_STEP, end);
  return { milestones_written: written(inserted) };
}

/** The milestone steps, in pass order. */
export function milestoneSteps(config: MilestoneStepsConfig): readonly SocialWorkerStep[] {
  return Object.freeze([
    { name: STEP, pipeline: "presale", run: (tx, bounds) => commitsStep(tx, bounds!, config) },
    { name: HOLDERS_STEP, pipeline: "market", run: (tx, bounds) => holdersStep(tx, bounds!, config) },
  ] satisfies SocialWorkerStep[]);
}

/** The generator's statements, for EXPLAIN checks and the scale record. */
export const MILESTONE_STATEMENTS = Object.freeze({
  commitsBatchEnd: BATCH_END,
  commits: MILESTONES_INSERT,
  holdersBatchEnd: HOLDERS_BATCH_END,
  holders: HOLDERS_INSERT,
});
