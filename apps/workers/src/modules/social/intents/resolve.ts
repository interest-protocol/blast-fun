import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import { activityEntryId, FEED_ENTRY_SOURCES, type FeedEntrySource } from "@blast/core/modules/social/contracts/feed-entries.ts";
import { INTENT_EXPIRY_MS, INTENT_LATE_AFTER_MS, type SocialIntentAction } from "@blast/core/modules/social/contracts/intents.ts";
import { doTheSameDescriptor } from "@blast/core/modules/social/items/do-the-same.ts";
import { SHOWN_PRESALES, SHOWN_FEED_ENTRIES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { entryBranchFilterSql, entryIdBranch } from "@blast/core/modules/social/read-model/entries.ts";
import { namedOwnerSql } from "@blast/core/modules/social/read-model/naming.ts";
import { WHY_RECORDS_PER_ITEM, validateWhy } from "@blast/core/modules/social/whys/validate.ts";
import { settleLoggedTransaction } from "@blast/core/modules/social/transactions/log.ts";
import { readStepCursor, writeStepCursor, type SocialWorkerBounds, type SocialWorkerStep, type SocialWorkerStepReport } from "../worker/steps.ts";

/**
 * Resolving intents (T-026): the social worker applies a registered intent as
 * soon as the indexer shows the transaction behind it. It attaches the
 * checkout why to the new item and, when the action came through someone
 * else's post, records the attribution that raises that post's "through"
 * counts. These rows feed the later airdrop and are never deleted.
 *
 * Why the worker and not the route: at registration the transaction has not
 * executed, so there is no item to attach a why to, no actor to check and no
 * amount to credit. All three exist only once `chain_read_v1.activity` has the
 * row, and only the indexer can say that.
 *
 * Five decisions per intent, in this order, all in one transaction with the
 * status write, so an intent can never be half applied:
 *
 * 1. **Late.** A registration more than `INTENT_LATE_AFTER_MS` after the
 *    transaction's own timestamp is `late`: the dialog registers *before* it
 *    executes, so a later registration is someone claiming a transaction
 *    after the fact. Nothing attaches.
 * 2. **Sender.** The activity's actor must be a wallet of the intent's own
 *    account, linked no later than the event (`social_wallet_owners`).
 *    Otherwise `rejected_sender`: an account cannot claim another wallet's
 *    commit, and cannot claim one made before it linked the wallet.
 * 3. **Why.** Revalidated here, not trusted from the route: the shared
 *    `validateWhy`, the per-item limits, and the entry must be named for that
 *    account (an unnamed item has no author to attach one to). A failure skips
 *    the why and the intent still applies.
 * 4. **Attribution.** One row when the source post still exists, its
 *    do-the-same **kind** matches the action, it is the same sale, and the
 *    actor is not the intent's own account. A `trade_sell` never attributes.
 * 5. **Applied.** `status = 'applied'` with `resolved_at`.
 *
 * The digest is the primary key of both `social_intents` and
 * `social_attributions`, so a repeated pass, a restart and two workers racing
 * all leave exactly one attribution and one why.
 *
 * **The why's text never reaches a log line or a metric** (AC-130): the step
 * reports counts only, and the text is read, validated and written inside one
 * statement's parameters.
 */

export type IntentStepsConfig = Readonly<{
  /** Intents resolved per pass (`SOCIAL_NOTIFICATION_BATCH`, shared with the other steps). */
  batchSize: number;
}>;

/**
 * The oldest pending intents whose transaction the indexer has reached.
 *
 * The join is the batch's own filter, so an intent whose transaction has not
 * appeared yet (or never will, because the signature was refused) costs
 * nothing but its index entry and cannot starve a newer one — which a plain
 * "oldest N pending" read would, since a pending row has no cursor to advance
 * past and must be revisited until it resolves or expires.
 *
 * `kind` narrows the row within the digest: one transaction can emit several
 * activity rows, and the commit's own row is the one that carries the amount.
 * `checkpoint <= $1` keeps the step inside the pipeline's watermark, so it
 * never reads a row the indexer may still be rewriting.
 */
const BATCH_SQL = `SELECT i.tx_digest, i.account_id, i.action, i.presale_id, i.source_entry_id, i.why_text,
    (extract(epoch FROM i.registered_at) * 1000)::bigint AS registered_ms,
    a.activity_id, a.actor, a.timestamp_ms, a.presale_id AS activity_presale,
    a.quote_amount::text AS quote_amount, a.usd_value::text AS usd_value
  FROM social_intents i
  JOIN chain_read_v1.activity a ON a.digest = i.tx_digest AND a.kind = $2
  WHERE i.status = 'pending' AND a.checkpoint <= $1
  ORDER BY i.registered_at, i.tx_digest
  LIMIT $3`;

/**
 * Whether the activity's actor is a wallet of the intent's account, linked no
 * later than the event. The view holds at most one owner per address, so an
 * address two accounts reach belongs to neither and fails this.
 */
const SENDER_SQL = `SELECT 1 FROM social_wallet_owners
  WHERE address = $1 AND account_id = $2 AND extract(epoch FROM linked_at) * 1000 <= $3`;

/**
 * The source post as the attribution needs it: it still exists, who names it
 * now, whose wallet it is, and its sale.
 *
 * Both the entry's own key and the owner lookup go through the read model's
 * own shapes, because both are access paths rather than conditions.
 * `entryBranchFilterSql` pins an activity entry to its row's time, without
 * which the derived `activity_id` makes this a sequential scan of every
 * activity row (measured: 188 ms p50 at a million rows, 0.3 ms with it); and
 * the actor's owner is a scalar subquery, not a join, so it is one index
 * lookup instead of a materialised pass over every linked wallet (22 ms).
 */
function sourceSql(source: FeedEntrySource): string {
  // The source is a literal, so the planner drops the view's other branches —
  // and a lifecycle entry and a milestone entry are different branches, which
  // one shared "post" shape would quietly conflate.
  const keyed = entryBranchFilterSql(
    source === "activity" ? { source, activityId: "" } : { source, presaleId: "" },
    "$2",
    "$1",
  );
  return `SELECT e.kind, e.presale_id, e.actor,
      named.account_id AS named_account_id,
      (SELECT actor_owner.account_id FROM social_wallet_owners actor_owner WHERE actor_owner.address = e.actor) AS actor_account_id,
      p.lifecycle, p.start_ms::text AS start_ms, p.end_ms::text AS end_ms, EXISTS (SELECT 1 FROM ${SHOWN_FEED_ENTRIES} shown WHERE shown.entry_id = e.entry_id) AS shown
    FROM social_feed_entries e
    CROSS JOIN LATERAL (SELECT ${namedOwnerSql("e")} AS account_id) named
    LEFT JOIN ${SHOWN_PRESALES} p ON p.presale_id = e.presale_id
    WHERE ${keyed}`;
}

/** Every why record of the item, in any state: the 3-per-item limit and the one active why. */
const WHY_RECORDS_SQL = "SELECT state FROM social_whys WHERE entry_id = $1";
const WHY_INSERT_SQL = "INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING";

/** One attribution per digest; a repeated pass writes nothing. */
const ATTRIBUTION_SQL = `INSERT INTO social_attributions
    (tx_digest, entry_id, author_account_id, actor_account_id, action, presale_id, quote_amount, usd_value, occurred_at_ms)
  VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9)
  ON CONFLICT (tx_digest) DO NOTHING`;

const APPLY_SQL = "UPDATE social_intents SET status = $2, resolved_at = now() WHERE tx_digest = $1 AND status = 'pending'";

/**
 * Still pending 24 hours after it was registered: deleted, so nothing resolves
 * it by accident later (AC-099).
 *
 * The cutoff is compared against the column, not against a derived epoch, so
 * `social_intents_pending_idx` range-scans it: the sweep then costs what it
 * deletes rather than a pass over everything still pending.
 */
const EXPIRE_SQL = "DELETE FROM social_intents WHERE status = 'pending' AND registered_at < to_timestamp($1::numeric / 1000)";

/**
 * Before they go, the expiring commits' rows in the transaction log (R3-27)
 * are settled `failed` / `expired`: the transaction never appeared on chain in
 * 24 hours (a refused signature after registration, or an abort, which emits
 * no event). The same pending slice as `EXPIRE_SQL` by the same index, then
 * one lookup each by the log's `(account_id, idempotency_key)` key; a row
 * already settled, or none at all, is left alone.
 */
const EXPIRE_LOG_SQL = `UPDATE social_transactions t
  SET state = 'failed', failure_code = 'expired', settled_at_ms = GREATEST($2::bigint, t.created_at_ms)
  FROM social_intents i
  WHERE i.status = 'pending' AND i.registered_at < to_timestamp($1::numeric / 1000) AND i.action = 'commit'
    AND t.account_id = i.account_id AND t.idempotency_key = 'commit:' || i.tx_digest AND t.state = 'submitted'`;

for (const source of FEED_ENTRY_SOURCES) assertChainReadThroughViews(sourceSql(source));
assertChainReadThroughViews(BATCH_SQL);

/** The activity kind each action's amount comes from. */
const ACTION_KIND: Readonly<Record<SocialIntentAction, string>> = {
  commit: "presale_commit",
  buy: "trade_buy",
  sell: "trade_sell",
};

/** A sell never credits a post (AC-139): copying someone out of a position is not following them in. */
const ATTRIBUTES: Readonly<Record<SocialIntentAction, boolean>> = { commit: true, buy: true, sell: false };

type IntentRow = Readonly<{
  tx_digest: string;
  account_id: string;
  action: SocialIntentAction;
  presale_id: string;
  source_entry_id: string | null;
  why_text: string | null;
  registered_ms: string;
  activity_id: string;
  actor: string;
  timestamp_ms: string;
  activity_presale: string | null;
  quote_amount: string;
  usd_value: string | null;
}>;

type SourceRow = Readonly<{
  kind: string;
  presale_id: string | null;
  actor: string | null;
  named_account_id: string | null;
  actor_account_id: string | null;
  lifecycle: string | null;
  start_ms: string | null;
  end_ms: string | null;
  /** Whether the entry's sale is one the web shows (`SHOWN_FEED_ENTRIES`). */
  shown: boolean;
}>;

export type IntentOutcome = "applied" | "late" | "rejected_sender";

/**
 * What one intent becomes, from the facts alone. Separated from the SQL so
 * every rule of T-026 is tested without a database, and so the order of the
 * checks is visible in one place.
 */
export function intentOutcome(input: Readonly<{ registeredMs: number; eventMs: number; senderOwned: boolean }>): IntentOutcome {
  if (input.registeredMs > input.eventMs + INTENT_LATE_AFTER_MS) return "late";
  if (!input.senderOwned) return "rejected_sender";
  return "applied";
}

/**
 * Whether the source post credits this action, given the post as it stands at
 * resolution. The descriptor's **kind** is what must match, never a
 * hard-coded list of item kinds and never whether it is still enabled: a
 * commit made before `end_ms` and resolved after the sale funded still counts.
 */
export function attributes(input: Readonly<{
  action: SocialIntentAction;
  activityPresale: string | null;
  source: SourceRow | null;
  accountId: string;
  nowMs: number;
}>): boolean {
  if (!ATTRIBUTES[input.action]) return false;
  const source = input.source;
  if (!source) return false;
  if (source.presale_id === null || input.activityPresale === null || source.presale_id !== input.activityPresale) return false;
  // One's own post is not a referral.
  if (source.actor_account_id !== null && source.actor_account_id === input.accountId) return false;
  const presale =
    source.presale_id === null || source.lifecycle === null || source.start_ms === null || source.end_ms === null
      ? null
      : { presale_id: source.presale_id, lifecycle: source.lifecycle, start_ms: Number(source.start_ms), end_ms: Number(source.end_ms) };
  const descriptor = doTheSameDescriptor(source.kind, presale, input.nowMs);
  return descriptor !== null && descriptor.kind === input.action;
}

/** The refusal an item's existing why records mean for a new one, or null (the whys route's rule). */
function whyBlocked(states: readonly string[]): boolean {
  return states.includes("active") || states.includes("removed") || states.length >= WHY_RECORDS_PER_ITEM;
}

async function readSource(
  tx: ModuleTransaction<"social">,
  entryId: string,
): Promise<SourceRow | null> {
  const branch = entryIdBranch(entryId);
  if (!branch) return null;
  const sql = sourceSql(branch.source);
  const key = branch.source === "activity" ? branch.activityId : branch.presaleId;
  const { rows } = await tx.read<SourceRow>(sql, [entryId, key]);
  return rows[0] ?? null;
}

async function resolveStep(
  tx: ModuleTransaction<"social">,
  bounds: SocialWorkerBounds,
  config: IntentStepsConfig,
  createId: () => string,
): Promise<SocialWorkerStepReport> {
  const counts: Record<IntentOutcome, number> = { applied: 0, rejected_sender: 0, late: 0 };
  // One pass, in declared action order, bounded by the pipeline watermark.
  for (const action of Object.keys(ACTION_KIND) as SocialIntentAction[]) {
    const { rows } = await tx.read<IntentRow>(BATCH_SQL, [bounds.checkpoint, ACTION_KIND[action], config.batchSize]);
    for (const row of rows) {
      if (row.action !== action) continue;
      const outcome = await resolveIntent(tx, row, bounds, createId);
      counts[outcome] += 1;
    }
  }
  return { intents_resolved: counts.applied, intents_rejected: counts.rejected_sender, intents_late: counts.late };
}

async function resolveIntent(tx: ModuleTransaction<"social">, row: IntentRow, bounds: SocialWorkerBounds, createId: () => string): Promise<IntentOutcome> {
  const action = row.action;
  const eventMs = Number(row.timestamp_ms);
  const sender = await tx.read(SENDER_SQL, [row.actor, row.account_id, eventMs]);
  const senderOwned = sender.rows.length > 0;
  const outcome = intentOutcome({ registeredMs: Number(row.registered_ms), eventMs, senderOwned });
  // R3-27: the account's logged commit settles from the chain, whatever
  // the social outcome. Its own wallet sent it: confirmed, at the chain's
  // time (a late registration voids the credit, not the commitment).
  // Another wallet did: it is not this account's transaction.
  if (action === "commit") {
    await settleLoggedTransaction(
      tx,
      { accountId: row.account_id, idempotencyKey: `commit:${row.tx_digest}` },
      senderOwned
        ? { state: "confirmed", digest: row.tx_digest, settledAtMs: eventMs }
        : { state: "failed", failureCode: "mismatch", settledAtMs: eventMs },
    );
  }
  if (outcome !== "applied") {
    await tx.write("social_intents", APPLY_SQL, [row.tx_digest, outcome]);
    return outcome;
  }

  await attachIntentWhy(tx, row, createId);
  await attributeIntent(tx, row, action, eventMs, bounds.timestampMs);

  await tx.write("social_intents", APPLY_SQL, [row.tx_digest, "applied"]);
  return "applied";
}

async function attachIntentWhy(tx: ModuleTransaction<"social">, row: IntentRow, createId: () => string): Promise<void> {
  // The why goes on the item the transaction just produced, authored by
  // the intent's account. It needs that item to be named for them: an
  // unnamed item shows an address and has no author. And its sale must be
  // one the web shows (`shown`): a commit to one of T-043's hidden test
  // sales (an intent the dialog never registers, only a hand-made request)
  // is an item nobody is shown, so a why on it would be one too.
  if (row.why_text !== null) {
    const entryId = activityEntryId(row.activity_id);
    const checked = validateWhy(row.why_text);
    const item = await readSource(tx, entryId);
    const named = item !== null && item.named_account_id === row.account_id && item.shown;
    if (checked.ok && named) {
      const records = await tx.read<{ state: string }>(WHY_RECORDS_SQL, [entryId]);
      if (!whyBlocked(records.rows.map((record) => record.state))) {
        // A competing active why is skipped without aborting this transaction.
        await tx.write("social_whys", WHY_INSERT_SQL, [createId(), entryId, row.account_id, checked.text]);
      }
    }
  }
}

async function attributeIntent(tx: ModuleTransaction<"social">, row: IntentRow, action: SocialIntentAction, eventMs: number, nowMs: number): Promise<void> {
  if (row.source_entry_id !== null) {
    const source = await readSource(tx, row.source_entry_id);
    if (attributes({ action, activityPresale: row.activity_presale, source, accountId: row.account_id, nowMs })) {
      await tx.write("social_attributions", ATTRIBUTION_SQL, [
        row.tx_digest,
        row.source_entry_id,
        source!.named_account_id,
        row.account_id,
        action,
        row.activity_presale,
        row.quote_amount,
        row.usd_value,
        eventMs,
      ]);
    }
  }
}

/** How often the expiry sweep runs, at most. */
export const INTENT_EXPIRY_EVERY_MS = 10 * 60_000;

async function expiryStep(
  tx: ModuleTransaction<"social">,
  nowMs: number,
  lastRun: Readonly<{ at: number }> | null,
): Promise<Readonly<{ report: SocialWorkerStepReport; at: number }>> {
  if (lastRun !== null && nowMs - lastRun.at < INTENT_EXPIRY_EVERY_MS) return { report: {}, at: lastRun.at };
  await tx.write("social_transactions", EXPIRE_LOG_SQL, [nowMs - INTENT_EXPIRY_MS, nowMs]);
  await tx.write("social_intents", EXPIRE_SQL, [nowMs - INTENT_EXPIRY_MS]);
  return { report: {}, at: nowMs };
}

/** The intent steps, in pass order. */
export function intentSteps(
  config: IntentStepsConfig,
  overrides: Readonly<{ createId?: () => string }> = {},
): readonly SocialWorkerStep[] {
  const createId = overrides.createId ?? (() => crypto.randomUUID());
  return Object.freeze([
    {
      name: "intent-resolve",
      pipeline: "presale" as const,
      run: (tx, bounds) => resolveStep(tx, bounds!, config, createId),
    },
    {
      name: "intent-expiry",
      // No chain data: expiry is 24 hours of wall clock since the registration.
      pipeline: null,
      async run(tx, _bounds, context) {
        const cursor = await readStepCursor<Readonly<{ at: number }>>(tx, "intent-expiry");
        const { report, at } = await expiryStep(tx, context.now(), cursor);
        if (cursor === null || at !== cursor.at) await writeStepCursor(tx, "intent-expiry", { at });
        return report;
      },
    },
  ] satisfies SocialWorkerStep[]);
}

/** The step's statements, for EXPLAIN checks and the scale record. */
export const INTENT_STATEMENTS = Object.freeze({
  batch: BATCH_SQL,
  sender: SENDER_SQL,
  sourceActivity: sourceSql("activity"),
  sourceLifecycle: sourceSql("lifecycle"),
  sourceMilestone: sourceSql("milestone"),
  whyRecords: WHY_RECORDS_SQL,
  attribution: ATTRIBUTION_SQL,
  apply: APPLY_SQL,
  expire: EXPIRE_SQL,
  expireLog: EXPIRE_LOG_SQL,
});
