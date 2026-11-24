import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import { walletNamingSql } from "@blast/core/modules/social/read-model/naming.ts";
import {
  readStepCursor,
  writeStepCursor,
  type SocialWorkerBounds,
  type SocialWorkerStep,
  type SocialWorkerStepReport,
} from "../worker/steps.ts";
import { VESTING_MAX_MS } from "@blast/core/modules/social/contracts/vesting.ts";
import { SHOWN_PRESALES, SHOWN_ACTIVITY } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { DISPLAY_PRICES } from "@blast/core/modules/social/prices/test-sui.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "@blast/core/modules/social/contracts/portfolio.ts";

/**
 * The notification generator: five social worker steps that turn chain
 * events into `social_notifications` rows (0064), fanned out on write to
 * each recipient whose switch (`social_notification_preferences`, 0059) is
 * on. Chain data is read only through `chain_read_v1` views, never past the
 * presale pipeline's watermark (the pipeline that writes presales, their
 * lifecycle and commit activity). Every insert is one set-based statement
 * (`INSERT … SELECT`, no per-recipient round trip) keyed by
 * `(account_id, source_key)` with `ON CONFLICT DO NOTHING`, so a repeated
 * pass, a restart or a replay never duplicates a notification.
 *
 * Steps and cursors (`social_worker_state`):
 *
 * - `notify-activity`: new `presale_commit` activity in total order
 *   `(checkpoint, tx_slot, event_slot, part)`, at most `batchSize` commits a
 *   pass. `follow` to the actor's followers when the naming rule names the
 *   actor at the commit; `fill` to the sale's followers and backers when the
 *   commit takes the backers count exactly to a `participant_milestones`
 *   value, or the raised total across 80% of the target.
 * - `notify-lifecycle`: new `chain_read_v1.presale_lifecycle` rows: `funded`
 *   to backers; `migrated` / `cancelled` → `claim` to backers with an
 *   unclaimed position.
 * - `notify-clock`: the chain clock (the watermark's time) passing an hour
 *   before a pending sale's start (`soon` to followers), an hour before an
 *   open sale's end (`soon` to backers) and the unlock lead before a team
 *   vesting's first unlock, when its cliff ends (`unlock` to backers).
 * - `notify-calls` (market pipeline): a trading USDC sale's coin rising past
 *   `CALL_UP_THRESHOLDS` over the sale's entry price (net raise ÷ tokens
 *   delivered, from a sample of its claims: the price a profile's call shows,
 *   `profiles/calls.ts`), at a price at most `PORTFOLIO_PRICE_MAX_AGE_MS`
 *   older than the chain clock. `call_up` to every account the naming rule
 *   names for a commit to the sale (its callers, OA-9), for the highest
 *   threshold crossed only, and each threshold once per sale: the cursor
 *   keeps each sale's highest threshold reached, so a fall and a new rise
 *   past it, a jump past several at once, or retention deleting the row never
 *   repeat one or send a lower one after a higher. The first pass records
 *   where every sale stands and sends nothing; a sale seen later for the first
 *   time (its price was stale until now) is recorded the same way, unless it
 *   migrated after the first pass, so a rise from before the step ran is never
 *   announced as new. The trade-off: such a sale's first observed level is
 *   recorded, not sent, even when that rise came after the step started, and
 *   only a later, higher threshold is sent. After a deploy or a cursor reset
 *   while prices are stale (the USDC price older than two minutes, so no sale
 *   is fresh), this holds for every trading sale.
 * - `notify-retention`: deletes notifications whose event is older than the
 *   retention, in batches, at most every ten minutes (no chain read).
 *
 * A first pass starts at the watermark: history before the worker first ran
 * is not notified.
 *
 * Only sales the web shows: a commit is notified only when its sale is in
 * `SHOWN_PRESALES` (`SHOWN_ACTIVITY` in the commit range, so neither
 * `follow` nor `fill` sees a hidden sale's commit). blast-infra hides T-043's
 * test sales from its presale views (so from the lifecycle, position and
 * vesting steps) but not from `chain_read_v1.activity`. The batch end still
 * counts every commit, so a hidden commit only makes a pass shorter. The
 * reads (`store.ts`) leave out any row of a sale not shown as well, so a sale
 * hidden after its notifications were written disappears from them. Backers are the accounts owning (`social_wallet_owners`) a
 * wallet with a positive commitment (`chain_read_v1.presale_positions`);
 * a backer's `c` is the sum of its wallets' commitments in quote atoms.
 */

export type NotificationStepsConfig = Readonly<{
  batchSize: number;
  retentionDays: number;
  unlockLeadDays: number;
  /** `participant_milestones` (`social_config`), read per pass through the 30 s cached reader. */
  participantMilestones: () => Promise<readonly number[]>;
}>;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const RETENTION_EVERY_MS = 10 * 60_000;
const RETENTION_BATCH = 10_000;
/** An activity position past any slot in a checkpoint. */
const SLOT_MAX = 2_147_483_647;

type ActivityCursor = Readonly<{ c: number; t: number; e: number; p: number; ts: number }>;

/**
 * The commit range of one pass: after the cursor, up to the batch end, never
 * past the watermark, of shown sales only.
 */
const COMMITS = `
  SELECT a.activity_id, a.checkpoint, a.tx_slot, a.event_slot, a.part, a.timestamp_ms, a.actor, a.presale_id,
    a.quote_amount, a.usd_value, a.participants_after, a.total_commitments_after
  FROM ${SHOWN_ACTIVITY} a
  WHERE a.timestamp_ms >= $1::bigint AND a.checkpoint <= $2::bigint
    AND (a.checkpoint, a.tx_slot, a.event_slot, a.part) > ($3::bigint, $4::int, $5::int, $6::int)
    AND (a.checkpoint, a.tx_slot, a.event_slot, a.part) <= ($7::bigint, $8::int, $9::int, $10::int)
    AND a.kind = 'presale_commit' AND a.presale_id IS NOT NULL`;

/** The `batchSize`-th commit after the cursor, if there are that many before the watermark. */
const BATCH_END = `
  SELECT a.checkpoint::text AS c, a.tx_slot AS t, a.event_slot AS e, a.part AS p, a.timestamp_ms::text AS ts
  FROM ${SHOWN_ACTIVITY} a
  WHERE a.timestamp_ms >= $1::bigint AND a.checkpoint <= $2::bigint
    AND (a.checkpoint, a.tx_slot, a.event_slot, a.part) > ($3::bigint, $4::int, $5::int, $6::int)
    AND a.kind = 'presale_commit' AND a.presale_id IS NOT NULL
  ORDER BY a.checkpoint, a.tx_slot, a.event_slot, a.part
  OFFSET $7::int - 1 LIMIT 1`;

/**
 * The followers of `$presale` and its backers (sum of commitments), as
 * `(account_id, commitment)`. Each backer wallet's owner is one indexed
 * lookup (`social_wallet_owners` filtered by address reaches every source's
 * address index), never the whole view joined per sale.
 */
function audience(presale: string, include: Readonly<{ followers: boolean; unclaimedOnly?: boolean }>): string {
  const followers = include.followers
    ? `SELECT f.follower_account_id AS account_id, 0::numeric AS commitment
       FROM social_follows f WHERE f.target_kind = 'presale' AND f.target_id = ${presale}
       UNION ALL `
    : "";
  return `(SELECT who.account_id, sum(who.commitment) AS commitment FROM (
      ${followers}SELECT o.account_id, pp.commitment
      FROM chain_read_v1.presale_positions pp
      CROSS JOIN LATERAL (SELECT ow.account_id FROM social_wallet_owners ow WHERE ow.address = pp.wallet OFFSET 0) AS o
      WHERE pp.presale_id = ${presale} AND pp.commitment > 0${include.unclaimedOnly ? " AND pp.claim_digest IS NULL" : ""}
    ) AS who GROUP BY who.account_id)`;
}

/** `{c: atoms}` for a backer, nothing for a follower who has not committed. */
const MINE = `CASE WHEN r.commitment > 0 THEN jsonb_build_object('c', r.commitment::text) ELSE '{}'::jsonb END`;

const INSERT = `INSERT INTO social_notifications (account_id, kind, source_key, presale_id, actor_account_id, entry_id, occurred_at_ms, data)`;
const DEDUPE = "ON CONFLICT (account_id, source_key) DO NOTHING";

/**
 * Followers of each named actor. The batch's commits and their distinct
 * wallets are materialized once; each wallet's owner and the time the naming
 * rule starts naming it are resolved once (`walletNamingSql`); a commit is
 * named when its time is at or after that. Then one index range of
 * `social_follows_target_idx` per named commit.
 */
const FOLLOW_INSERT = `${INSERT}
  WITH commits AS MATERIALIZED (
    SELECT c.activity_id, c.presale_id, c.actor, c.usd_value, c.timestamp_ms AS occurred_at_ms FROM (${COMMITS}) c
  ), wallets AS MATERIALIZED (
    SELECT w.actor, n.account_id, n.named_from_ms
    FROM (SELECT DISTINCT actor FROM commits) AS w
    CROSS JOIN LATERAL ${walletNamingSql("w.actor")} AS n
  ), named AS MATERIALIZED (
    SELECT c.activity_id, c.presale_id, c.usd_value, c.occurred_at_ms, w.account_id AS owner_id
    FROM commits c JOIN wallets w ON w.actor = c.actor
    WHERE c.occurred_at_ms >= w.named_from_ms
  )
  SELECT f.follower_account_id, 'follow', 'follow:' || e.activity_id, e.presale_id, e.owner_id, 'a:' || e.activity_id,
    e.occurred_at_ms, jsonb_strip_nulls(jsonb_build_object('usd', round(e.usd_value)::text))
  FROM named e
  JOIN social_follows f ON f.target_kind = 'account' AND f.target_id = e.owner_id::text AND f.follower_account_id <> e.owner_id
  LEFT JOIN social_notification_preferences pref ON pref.account_id = f.follower_account_id
  WHERE COALESCE(pref.people_you_follow, true)
  ${DEDUPE}`;

/**
 * Backer-count and 80% milestones of the batch: the crossing events are
 * materialized first (one per sale and milestone, the earliest commit), then
 * each event's audience (followers and backers) is read once.
 */
const FILL_INSERT = `${INSERT}
  WITH events AS MATERIALIZED (
    SELECT DISTINCT ON (x.source_key) x.source_key, x.presale_id, x.entry_id, x.occurred_at_ms, x.data
    FROM (
      SELECT 'fill:' || c.presale_id || ':participants:' || m.value AS source_key, c.presale_id, 'a:' || c.activity_id AS entry_id,
        c.timestamp_ms AS occurred_at_ms, c.checkpoint, c.tx_slot, c.event_slot, c.part,
        jsonb_build_object('m', 'participants', 'v', m.value,
          'pct', floor(c.total_commitments_after * 100 / NULLIF(p.raise_target, 0))) AS data
      FROM (${COMMITS}) c
      JOIN ${SHOWN_PRESALES} p ON p.presale_id = c.presale_id
      JOIN unnest($11::bigint[]) AS m (value) ON c.participants_after = m.value
      UNION ALL
      SELECT 'fill:' || c.presale_id || ':filled:80', c.presale_id, 'a:' || c.activity_id, c.timestamp_ms,
        c.checkpoint, c.tx_slot, c.event_slot, c.part, jsonb_build_object('m', 'filled', 'v', 80)
      FROM (${COMMITS}) c
      JOIN ${SHOWN_PRESALES} p ON p.presale_id = c.presale_id
      WHERE p.raise_target > 0 AND c.total_commitments_after * 5 >= p.raise_target * 4
        AND (c.total_commitments_after - c.quote_amount) * 5 < p.raise_target * 4
    ) AS x
    ORDER BY x.source_key, x.checkpoint, x.tx_slot, x.event_slot, x.part
  )
  SELECT r.account_id, 'fill', ev.source_key, ev.presale_id, NULL, ev.entry_id, ev.occurred_at_ms, ev.data || ${MINE}
  FROM events ev
  CROSS JOIN LATERAL ${audience("ev.presale_id", { followers: true })} AS r
  LEFT JOIN social_notification_preferences pref ON pref.account_id = r.account_id
  WHERE COALESCE(pref.almost_full, true)
  ${DEDUPE}`;

const FUNDED_INSERT = `${INSERT}
  SELECT r.account_id, 'funded', 'funded:' || l.presale_id, l.presale_id, NULL, 'l:' || l.presale_id || ':funded', l.timestamp_ms, ${MINE}
  FROM chain_read_v1.presale_lifecycle l
  CROSS JOIN LATERAL ${audience("l.presale_id", { followers: false })} AS r
  LEFT JOIN social_notification_preferences pref ON pref.account_id = r.account_id
  WHERE l.state = 'funded' AND l.checkpoint > $1::bigint AND l.checkpoint <= $2::bigint AND COALESCE(pref.funded, true)
  ${DEDUPE}`;

const CLAIM_INSERT = `${INSERT}
  SELECT r.account_id, 'claim', 'claim:' || l.presale_id, l.presale_id, NULL, 'l:' || l.presale_id || ':' || l.state, l.timestamp_ms,
    jsonb_build_object('refund', l.state = 'cancelled') || ${MINE}
  FROM chain_read_v1.presale_lifecycle l
  CROSS JOIN LATERAL ${audience("l.presale_id", { followers: false, unclaimedOnly: true })} AS r
  LEFT JOIN social_notification_preferences pref ON pref.account_id = r.account_id
  WHERE l.state IN ('migrated', 'cancelled') AND l.checkpoint > $1::bigint AND l.checkpoint <= $2::bigint
    AND COALESCE(pref.claims_open, true)
  ${DEDUPE}`;

/**
 * The chain clock passed (`$1`, `$2`]: an hour before a followed sale opens, pending or shared with its scheduled
 * start still ahead (`open` from the share, taking commitments only from `start_ms`).
 */
const OPENS_INSERT = `${INSERT}
  SELECT f.follower_account_id, 'soon', 'soon:' || p.presale_id || ':opens', p.presale_id, NULL, NULL,
    p.start_ms - ${HOUR_MS}, jsonb_build_object('at', 'opens')
  FROM ${SHOWN_PRESALES} p
  JOIN social_follows f ON f.target_kind = 'presale' AND f.target_id = p.presale_id
  LEFT JOIN social_notification_preferences pref ON pref.account_id = f.follower_account_id
  WHERE p.lifecycle IN ('pending', 'open') AND p.start_ms - ${HOUR_MS} > $1::bigint AND p.start_ms - ${HOUR_MS} <= $2::bigint
    AND p.start_ms > $2::bigint AND COALESCE(pref.opens_soon, true)
  ${DEDUPE}`;

/** An hour before a backed open sale closes. */
const CLOSES_INSERT = `${INSERT}
  SELECT r.account_id, 'soon', 'soon:' || p.presale_id || ':closes', p.presale_id, NULL, NULL,
    p.end_ms - ${HOUR_MS}, jsonb_build_object('at', 'closes') || ${MINE}
  FROM ${SHOWN_PRESALES} p
  CROSS JOIN LATERAL ${audience("p.presale_id", { followers: false })} AS r
  LEFT JOIN social_notification_preferences pref ON pref.account_id = r.account_id
  WHERE p.lifecycle = 'open' AND p.end_ms - ${HOUR_MS} > $1::bigint AND p.end_ms - ${HOUR_MS} <= $2::bigint
    AND p.end_ms > $2::bigint AND COALESCE(pref.last_hour, true)
  ${DEDUPE}`;

/**
 * The unlock lead (`$3` ms) before a backed sale's team tokens first unlock:
 * when a schedule's cliff ends (`start_ms + cliff_ms`, OA-18; the start
 * without a cliff). One per sale and unlock time; the key is the unlock time,
 * so a schedule without a cliff keeps its earlier key. `s` is the unlock, `v`
 * the vesting start and `e` the latest end (clamped to `VESTING_MAX_MS`). The
 * window bounds the unlock to the chain clock plus the lead, so it fits a
 * BIGINT.
 */
const UNLOCK_INSERT = `${INSERT}
  SELECT r.account_id, 'unlock', 'unlock:' || v.presale_id || ':' || v.unlock_ms, v.presale_id, NULL, NULL,
    (v.unlock_ms - $3::bigint)::bigint, jsonb_build_object('s', v.unlock_ms::bigint, 'v', v.start_ms, 'e', LEAST(v.end_ms, ${VESTING_MAX_MS}::numeric))
  FROM (
    SELECT vs.presale_id, vs.start_ms + vs.cliff_ms AS unlock_ms, min(vs.start_ms) AS start_ms, max(vs.end_ms) AS end_ms
    FROM chain_read_v1.vesting_schedules vs
    WHERE vs.start_ms + vs.cliff_ms - $3::bigint > $1::bigint AND vs.start_ms + vs.cliff_ms - $3::bigint <= $2::bigint
      AND vs.start_ms + vs.cliff_ms > $2::bigint
    GROUP BY vs.presale_id, vs.start_ms + vs.cliff_ms
  ) AS v
  CROSS JOIN LATERAL ${audience("v.presale_id", { followers: false })} AS r
  LEFT JOIN social_notification_preferences pref ON pref.account_id = r.account_id
  WHERE COALESCE(pref.unlocks, true)
  ${DEDUPE}`;

/** "Up N% since your call": the rises over the entry price that notify, in percent. */
export const CALL_UP_THRESHOLDS = [50, 100, 200, 500, 1_000] as const;

/**
 * Each trading USDC sale's highest `CALL_UP_THRESHOLDS` value (`$2`) its
 * coin's price is at or past now (`$1` the market pipeline's clock), with the entry and
 * the price as exact decimals. The entry is `net × 10^sale / (tokens ×
 * 10^quote)` over up to 50 claimed positions, the sample `readPresaleFacts`
 * takes (claims are pro rata, so every claim has the same price); the
 * comparison is `price ≥ entry × (100 + t) / 100` with no division; a sale
 * below the lowest threshold reads 0. `migrated_ms` is the sale's migration
 * (its `migrated` lifecycle row). Every trading USDC sale with a fresh price is
 * read each pass (a pool price's time also follows the quote's Pyth time), one
 * `presale_positions` range of at most 50 claims each.
 */
const CALL_LEVELS = `
  SELECT s.presale_id, COALESCE(lvl.top, 0) AS top, s.migrated_ms::text AS migrated_ms, trim_scale(round(s.net * power(10::numeric, s.sale_decimals) / (s.tokens * power(10::numeric, s.quote_decimals)), 18))::text AS entry,
    trim_scale(s.price)::text AS price, s.as_of_ms::text AS as_of_ms
  FROM (
    SELECT p.presale_id, p.sale_decimals, p.quote_decimals, pr.usd_price AS price, pr.as_of_ms, claims.net, claims.tokens,
      (SELECT max(l.timestamp_ms) FROM chain_read_v1.presale_lifecycle l WHERE l.presale_id = p.presale_id AND l.state = 'migrated') AS migrated_ms
    FROM ${SHOWN_PRESALES} p
    JOIN ${DISPLAY_PRICES} pr ON pr.coin_type = p.sale_token
    CROSS JOIN LATERAL (
      SELECT sum(c.commitment - COALESCE(c.claimed_quote_refund, 0)) AS net, sum(c.claimed_tokens) AS tokens
      FROM (
        SELECT pp.commitment, pp.claimed_quote_refund, pp.claimed_tokens
        FROM chain_read_v1.presale_positions pp
        WHERE pp.presale_id = p.presale_id AND pp.claim_digest IS NOT NULL AND pp.claimed_tokens > 0
        ORDER BY pp.presale_id, pp.wallet
        LIMIT 50
      ) c
    ) claims
    WHERE p.lifecycle = 'migrated' AND p.quote_symbol = 'USDC'
      AND pr.as_of_ms >= $1::bigint - ${PORTFOLIO_PRICE_MAX_AGE_MS}
      AND claims.tokens > 0 AND claims.net > 0
  ) s
  CROSS JOIN LATERAL (
    SELECT max(t.value) AS top FROM unnest($2::int[]) AS t (value)
    WHERE s.price * s.tokens * power(10::numeric, s.quote_decimals) * 100 >= (100 + t.value) * s.net * power(10::numeric, s.sale_decimals)
  ) lvl`;

/**
 * `call_up` for each sale and threshold in the arrays (`$1` sales, `$2`
 * thresholds, `$3` entries, `$4` prices, `$5` the prices' times) to its
 * callers: each wallet that committed to the sale is resolved once
 * (`walletNamingSql`), and an account is a caller when the rule names it
 * for one of its commits. The commits are one range of `activity_presale`
 * per sale. `data`: `t` the threshold, `e` the entry, `p` the price
 * that crossed it.
 */
const CALL_UP_INSERT = `${INSERT}
  WITH fired AS MATERIALIZED (
    SELECT f.presale_id, f.threshold, f.entry, f.price, f.as_of_ms
    FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::bigint[]) AS f (presale_id, threshold, entry, price, as_of_ms)
  ), commits AS MATERIALIZED (
    SELECT a.presale_id, a.actor, max(a.timestamp_ms) AS last_ms
    FROM fired f
    JOIN ${SHOWN_ACTIVITY} a ON a.presale_id = f.presale_id
    WHERE a.kind = 'presale_commit'
    GROUP BY a.presale_id, a.actor
  ), callers AS MATERIALIZED (
    SELECT DISTINCT c.presale_id, n.account_id
    FROM commits c
    CROSS JOIN LATERAL ${walletNamingSql("c.actor")} AS n
    WHERE c.last_ms >= n.named_from_ms
  )
  SELECT r.account_id, 'call_up', 'call_up:' || f.presale_id || ':' || f.threshold, f.presale_id, NULL, NULL, f.as_of_ms,
    jsonb_build_object('t', f.threshold, 'e', f.entry, 'p', f.price)
  FROM fired f
  JOIN callers r ON r.presale_id = f.presale_id
  LEFT JOIN social_notification_preferences pref ON pref.account_id = r.account_id
  WHERE COALESCE(pref.call_moves, true)
  ${DEDUPE}`;

/** The market pipeline's clock: prices are its facts, so their freshness is measured against it, not the earlier of the step's two cuts. */
const MARKET_CLOCK = `SELECT market_timestamp_ms::text AS ms FROM chain_read_v1.watermark`;

const RETENTION_DELETE = `DELETE FROM social_notifications WHERE notification_id IN (
    SELECT notification_id FROM social_notifications WHERE occurred_at_ms < $1::bigint ORDER BY occurred_at_ms LIMIT $2::int)`;

for (const statement of [COMMITS, BATCH_END, FOLLOW_INSERT, FILL_INSERT, FUNDED_INSERT, CLAIM_INSERT, OPENS_INSERT, CLOSES_INSERT, UNLOCK_INSERT, CALL_LEVELS, CALL_UP_INSERT, MARKET_CLOCK]) {
  assertChainReadThroughViews(statement);
}

const written = (result: { rowCount: number | null }) => result.rowCount ?? 0;

async function activityStep(
  tx: ModuleTransaction<"social">,
  name: string,
  bounds: SocialWorkerBounds,
  config: NotificationStepsConfig,
): Promise<SocialWorkerStepReport> {
  const cursor = await readStepCursor<ActivityCursor>(tx, name);
  const atBound: ActivityCursor = { c: bounds.checkpoint, t: SLOT_MAX, e: SLOT_MAX, p: SLOT_MAX, ts: bounds.timestampMs };
  if (cursor === null) {
    await writeStepCursor(tx, name, atBound);
    return {};
  }
  if (cursor.c >= bounds.checkpoint && cursor.t === SLOT_MAX) return {};
  const from = [cursor.ts, bounds.checkpoint, cursor.c, cursor.t, cursor.e, cursor.p] as const;
  const { rows } = await tx.read<{ c: string; t: number; e: number; p: number; ts: string }>(BATCH_END, [...from, config.batchSize]);
  const last = rows[0];
  const end: ActivityCursor = last ? { c: Number(last.c), t: last.t, e: last.e, p: last.p, ts: Number(last.ts) } : atBound;
  const range = [...from, end.c, end.t, end.e, end.p];
  const milestones = [...(await config.participantMilestones())];
  const follows = await tx.write("social_notifications", FOLLOW_INSERT, range);
  const fills = await tx.write("social_notifications", FILL_INSERT, [...range, milestones]);
  await writeStepCursor(tx, name, end);
  return { notifications_written: written(follows) + written(fills) };
}

async function lifecycleStep(tx: ModuleTransaction<"social">, name: string, bounds: SocialWorkerBounds): Promise<SocialWorkerStepReport> {
  const cursor = await readStepCursor<{ c: number }>(tx, name);
  if (cursor === null || cursor.c >= bounds.checkpoint) {
    if (cursor === null) await writeStepCursor(tx, name, { c: bounds.checkpoint });
    return {};
  }
  const funded = await tx.write("social_notifications", FUNDED_INSERT, [cursor.c, bounds.checkpoint]);
  const claims = await tx.write("social_notifications", CLAIM_INSERT, [cursor.c, bounds.checkpoint]);
  await writeStepCursor(tx, name, { c: bounds.checkpoint });
  return { notifications_written: written(funded) + written(claims) };
}

async function clockStep(
  tx: ModuleTransaction<"social">,
  name: string,
  bounds: SocialWorkerBounds,
  config: NotificationStepsConfig,
): Promise<SocialWorkerStepReport> {
  const cursor = await readStepCursor<{ ms: number }>(tx, name);
  if (cursor === null || cursor.ms >= bounds.timestampMs) {
    if (cursor === null) await writeStepCursor(tx, name, { ms: bounds.timestampMs });
    return {};
  }
  const window = [cursor.ms, bounds.timestampMs];
  const opens = await tx.write("social_notifications", OPENS_INSERT, window);
  const closes = await tx.write("social_notifications", CLOSES_INSERT, window);
  const unlocks = await tx.write("social_notifications", UNLOCK_INSERT, [...window, config.unlockLeadDays * DAY_MS]);
  await writeStepCursor(tx, name, { ms: bounds.timestampMs });
  return { notifications_written: written(opens) + written(closes) + written(unlocks) };
}

type CallLevelRow = Readonly<{ presale_id: string; top: number; migrated_ms: string | null; entry: string; price: string; as_of_ms: string }>;
/** When the first pass ran (chain clock) and each sale's highest threshold reached (0 below the lowest). */
type CallCursor = Readonly<{ since_ms: number; top: Readonly<Record<string, number>> }>;

async function callsStep(tx: ModuleTransaction<"social">, name: string, bounds: SocialWorkerBounds): Promise<SocialWorkerStepReport> {
  const cursor = await readStepCursor<CallCursor>(tx, name);
  const { rows: clock } = await tx.read<{ ms: string | null }>(MARKET_CLOCK);
  const marketMs = clock[0]?.ms == null ? bounds.timestampMs : Number(clock[0].ms);
  const { rows } = await tx.read<CallLevelRow>(CALL_LEVELS, [marketMs, [...CALL_UP_THRESHOLDS]]);
  if (cursor === null) {
    // The first pass records where every sale stands: rises before the worker first ran are not notified.
    await writeStepCursor(tx, name, { since_ms: marketMs, top: Object.fromEntries(rows.map((row) => [row.presale_id, row.top])) } satisfies CallCursor);
    return {};
  }
  // A sale first seen now that migrated before the first pass may have risen before it: recorded, not sent.
  const unseen = rows.filter((row) => !Object.hasOwn(cursor.top, row.presale_id));
  const recorded = unseen.filter((row) => row.migrated_ms === null || Number(row.migrated_ms) <= cursor.since_ms);
  const fired = rows.filter((row) => !recorded.includes(row) && row.top > (cursor.top[row.presale_id] ?? 0));
  if (fired.length === 0) {
    if (unseen.length > 0) await writeStepCursor(tx, name, { ...cursor, top: { ...cursor.top, ...Object.fromEntries(unseen.map((row) => [row.presale_id, row.top])) } } satisfies CallCursor);
    return {};
  }
  const inserted = await tx.write("social_notifications", CALL_UP_INSERT, [
    fired.map((row) => row.presale_id),
    fired.map((row) => row.top),
    fired.map((row) => row.entry),
    fired.map((row) => row.price),
    fired.map((row) => row.as_of_ms),
  ]);
  const top = { ...cursor.top, ...Object.fromEntries([...unseen, ...fired].map((row) => [row.presale_id, row.top])) };
  await writeStepCursor(tx, name, { since_ms: cursor.since_ms, top } satisfies CallCursor);
  return { notifications_written: written(inserted) };
}

/** The five notification steps, in pass order. */
export function notificationSteps(config: NotificationStepsConfig): readonly SocialWorkerStep[] {
  let lastRetentionMs = Number.NEGATIVE_INFINITY;
  return Object.freeze([
    { name: "notify-activity", pipeline: "presale", run: (tx, bounds) => activityStep(tx, "notify-activity", bounds!, config) },
    { name: "notify-lifecycle", pipeline: "presale", run: (tx, bounds) => lifecycleStep(tx, "notify-lifecycle", bounds!) },
    { name: "notify-clock", pipeline: "presale", run: (tx, bounds) => clockStep(tx, "notify-clock", bounds!, config) },
    // Prices from the market pipeline; sales, claims and the callers' commits from the presale pipeline.
    { name: "notify-calls", pipeline: "market", requiredPipelines: ["market", "presale"], run: (tx, bounds) => callsStep(tx, "notify-calls", bounds!) },
    {
      name: "notify-retention",
      pipeline: null,
      async run(tx, _bounds, context) {
        const at = context.now();
        if (at - lastRetentionMs < RETENTION_EVERY_MS) return {};
        const deleted = await tx.write("social_notifications", RETENTION_DELETE, [at - config.retentionDays * DAY_MS, RETENTION_BATCH]);
        lastRetentionMs = at;
        return { notifications_deleted: written(deleted) };
      },
    },
  ] satisfies SocialWorkerStep[]);
}

/** The generator's statements, for EXPLAIN checks and the scale record. */
export const NOTIFICATION_STATEMENTS = Object.freeze({
  batchEnd: BATCH_END,
  follow: FOLLOW_INSERT,
  fill: FILL_INSERT,
  funded: FUNDED_INSERT,
  claim: CLAIM_INSERT,
  opens: OPENS_INSERT,
  closes: CLOSES_INSERT,
  unlock: UNLOCK_INSERT,
  callLevels: CALL_LEVELS,
  callUp: CALL_UP_INSERT,
  retention: RETENTION_DELETE,
});
