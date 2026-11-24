import { z } from "zod";
import { EVENT_CURSOR } from "@blast/core/modules/launchpad-contract/cursor.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { PRESALE_LIFECYCLE_STATES, type FeedEntrySource } from "../contracts/feed-entries.ts";
import { SHOWN_ACTIVITY, SHOWN_FEED_ENTRIES } from "./chain-presales.ts";
import { namedOwnerSql, personEntrySql, presalePostSql, visibleEntrySql } from "./naming.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The feed's entry selections over `social_feed_entries`, with the naming
 * rule (`naming.ts`) applied at read time. Every selection orders by
 * `occurred_at_ms` descending, then `entry_id` descending (bytewise,
 * `COLLATE "C"`), and pages by keyset.
 *
 * Every selection, and `isVisible` / `visibleEntry`, keeps only entries of a
 * sale the web shows (inside the shared reader), in its `WHERE` before the
 * `LIMIT`: blast-infra hides T-043's test sales from its presale views but
 * not from `chain_read_v1.activity`, which this view's activity branch reads
 * unfiltered, so a named account's commit to a hidden sale would otherwise
 * be a person entry like any other.
 */

/** A `social_feed_entries` row and the account that names it, if any. */
export type FeedEntry = Readonly<{
  entryId: string;
  source: FeedEntrySource;
  /** Open set: an activity kind blast-infra adds later appears unchanged. */
  kind: string;
  product: string;
  occurredAtMs: number;
  /** The commit or trade sender, or the claim participant; null for lifecycle and milestone entries. */
  actor: string | null;
  presaleId: string | null;
  coinType: string | null;
  digest: string | null;
  activityId: string | null;
  quoteType: string | null;
  /** Numeric atoms and USD values as decimal strings. */
  quoteAmount: string | null;
  coinAmount: string | null;
  quoteRefund: string | null;
  usdValue: string | null;
  usdPriceAsOfMs: number | null;
  milestoneValue: string | null;
  /** The account the naming rule attributes the entry to now; null when the entry is not named. */
  namedAccountId: string | null;
}>;

/** A keyset position: the last entry of the previous page. */
export type EntryCursor = Readonly<{ occurredAtMs: number; entryId: string }>;

export type EntryWindow = Readonly<{
  /** Page size, 1 to `MAX_ENTRY_PAGE`. */
  limit: number;
  /** Only entries strictly after this position in the order (older, or as old with a smaller id). */
  before?: EntryCursor | null;
  /** Only entries with `occurred_at_ms >= sinceMs`. */
  sinceMs?: number | null;
}>;

/** USD values (decimal strings) at or above which a commit or a trade is a presale post. */
export type PresalePostThresholds = Readonly<{ bigCommitUsd: string; bigTradeUsd: string }>;

export const MAX_ENTRY_PAGE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USD = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const MAX_ENTRY_ID_LENGTH = 512;

export class EntryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntryQueryError";
  }
}

function checkTime(name: string, value: number): number {
  if (!z.number().int().nonnegative().safeParse(value).success) throw new EntryQueryError(`${name} must be a non-negative integer of milliseconds.`);
  return value;
}

function checkWindow(window: EntryWindow): EntryWindow {
  if (!z.number().int().min(1).max(MAX_ENTRY_PAGE).safeParse(window.limit).success) {
    throw new EntryQueryError(`The page size must be an integer from 1 to ${MAX_ENTRY_PAGE}.`);
  }
  if (window.before) {
    checkTime("The cursor time", window.before.occurredAtMs);
    if (!z.string().min(1).max(MAX_ENTRY_ID_LENGTH).safeParse(window.before.entryId).success) {
      throw new EntryQueryError("The cursor entry id is invalid.");
    }
  }
  if (window.sinceMs !== undefined && window.sinceMs !== null) checkTime("The window start", window.sinceMs);
  return window;
}

function checkThresholds(thresholds: PresalePostThresholds): PresalePostThresholds {
  for (const value of [thresholds.bigCommitUsd, thresholds.bigTradeUsd]) {
    if (!z.string().regex(USD).safeParse(value).success) throw new EntryQueryError("A post threshold must be a non-negative decimal.");
  }
  return thresholds;
}

const SELECT_ENTRY = `SELECT e.entry_id, e.source, e.kind, e.product, e.occurred_at_ms, e.actor, e.presale_id, e.coin_type,
    e.digest, e.activity_id, e.quote_type, e.quote_amount, e.coin_amount, e.quote_refund, e.usd_value,
    e.usd_price_as_of_ms, e.milestone_value, named.account_id AS named_account_id
  FROM ${SHOWN_FEED_ENTRIES} e
  CROSS JOIN LATERAL (SELECT ${namedOwnerSql("e")} AS account_id) named`;

/** The window's conditions and ORDER/LIMIT, with parameters numbered from `values.length + 1`. */
function windowSql(window: EntryWindow, values: unknown[]): { where: string; tail: string } {
  const conditions: string[] = [];
  if (window.before) {
    values.push(window.before.occurredAtMs, window.before.entryId);
    conditions.push(`(e.occurred_at_ms, e.entry_id COLLATE "C") < ($${values.length - 1}::bigint, $${values.length}::text COLLATE "C")`);
  }
  if (window.sinceMs !== undefined && window.sinceMs !== null) {
    values.push(window.sinceMs);
    conditions.push(`e.occurred_at_ms >= $${values.length}::bigint`);
  }
  values.push(window.limit);
  return {
    where: conditions.map((condition) => ` AND ${condition}`).join(""),
    tail: ` ORDER BY e.occurred_at_ms DESC, e.entry_id COLLATE "C" DESC LIMIT $${values.length}`,
  };
}

type EntryRow = Readonly<{
  entry_id: string;
  source: FeedEntrySource;
  kind: string;
  product: string;
  occurred_at_ms: string;
  actor: string | null;
  presale_id: string | null;
  coin_type: string | null;
  digest: string | null;
  activity_id: string | null;
  quote_type: string | null;
  quote_amount: string | null;
  coin_amount: string | null;
  quote_refund: string | null;
  usd_value: string | null;
  usd_price_as_of_ms: string | null;
  milestone_value: string | null;
  named_account_id: string | null;
}>;

export function entryFromRow(row: EntryRow): FeedEntry {
  return {
    entryId: row.entry_id,
    source: row.source,
    kind: row.kind,
    product: row.product,
    occurredAtMs: Number(row.occurred_at_ms),
    actor: row.actor,
    presaleId: row.presale_id,
    coinType: row.coin_type,
    digest: row.digest,
    activityId: row.activity_id,
    quoteType: row.quote_type,
    quoteAmount: row.quote_amount,
    coinAmount: row.coin_amount,
    quoteRefund: row.quote_refund,
    usdValue: row.usd_value,
    usdPriceAsOfMs: row.usd_price_as_of_ms === null ? null : Number(row.usd_price_as_of_ms),
    milestoneValue: row.milestone_value,
    namedAccountId: row.named_account_id,
  };
}

/**
 * The person entries (commits, claims, trades) of `accountIds` that are named
 * for one of those accounts now: never an unnamed entry, never one of a sale
 * the web does not show. The actor filter goes through the accounts' wallets
 * so the activity `(actor, timestamp_ms DESC)` index serves it.
 */
export async function personEntriesOf(
  db: ReadableDatabase,
  accountIds: readonly string[],
  window: EntryWindow,
): Promise<FeedEntry[]> {
  checkWindow(window);
  if (!z.array(z.string().regex(UUID)).safeParse(accountIds).success) throw new EntryQueryError("An account id is not a uuid.");
  if (accountIds.length === 0) return [];
  const values: unknown[] = [[...new Set(accountIds)]];
  const { where, tail } = windowSql(window, values);
  const result = await db.read<EntryRow>(
    `${SELECT_ENTRY}
     WHERE ${personEntrySql("e")}
       AND e.actor IN (SELECT o.address FROM social_wallet_owners o WHERE o.account_id = ANY($1::uuid[]))
       AND named.account_id = ANY($1::uuid[])${where}${tail}`,
    values,
  );
  return result.rows.map(entryFromRow);
}

/**
 * The presale-post candidates of `presaleIds` (or of every presale): every
 * lifecycle and milestone entry and every big commit or trade, named or not,
 * of a sale the web shows. `namedAccountId` says whether a big item's actor
 * may be shown by account; when null the payload shows the address only.
 */
export async function presalePostEntriesOf(
  db: ReadableDatabase,
  presaleIds: readonly string[] | "all",
  thresholds: PresalePostThresholds,
  window: EntryWindow,
): Promise<FeedEntry[]> {
  checkWindow(window);
  checkThresholds(thresholds);
  if (presaleIds !== "all") {
    if (!z.array(z.string().regex(SUI_OBJECT_ID_PATTERN)).safeParse(presaleIds).success) throw new EntryQueryError("A presale id is invalid.");
    if (presaleIds.length === 0) return [];
  }
  const values: unknown[] = [thresholds.bigCommitUsd, thresholds.bigTradeUsd];
  let presales = "";
  if (presaleIds !== "all") {
    values.push([...new Set(presaleIds)]);
    presales = ` AND e.presale_id = ANY($${values.length}::text[])`;
  }
  const { where, tail } = windowSql(window, values);
  const result = await db.read<EntryRow>(
    `${SELECT_ENTRY}
     WHERE ${presalePostSql("e", "$1", "$2")}${presales}${where}${tail}`,
    values,
  );
  return result.rows.map(entryFromRow);
}

/**
 * Which branch of `social_feed_entries` an entry id belongs to, and the key
 * that branch can filter by (so the lookup does not scan the union); null for
 * an id no branch can hold.
 */
export function entryIdBranch(entryId: string):
  | Readonly<{ source: "activity"; activityId: string }>
  | Readonly<{ source: "lifecycle"; presaleId: string }>
  | Readonly<{ source: "milestone"; presaleId: string }>
  | null {
  if (!z.string().max(MAX_ENTRY_ID_LENGTH).safeParse(entryId).success) return null;
  const [prefix, ...rest] = entryId.split(":");
  if (prefix === "a") {
    const activityId = rest.join(":");
    return z.string().regex(EVENT_CURSOR).safeParse(activityId).success ? { source: "activity", activityId } : null;
  }
  if (prefix === "l") {
    const [presaleId, state] = rest;
    if (!z.tuple([z.string().regex(SUI_OBJECT_ID_PATTERN), z.enum(PRESALE_LIFECYCLE_STATES)]).safeParse(rest).success) return null;
    return z.enum(PRESALE_LIFECYCLE_STATES).safeParse(state).success ? { source: "lifecycle", presaleId } : null;
  }
  if (prefix === "m") {
    const [presaleId] = rest;
    return z.tuple([z.string().regex(SUI_OBJECT_ID_PATTERN), z.string(), z.string()]).safeParse(rest).success ? { source: "milestone", presaleId } : null;
  }
  return null;
}

/**
 * The branch filter of a single-entry read, over the entry aliased `e`.
 * `keyParameter` carries the branch's key (an activity id, or a presale id)
 * and `entryParameter` the entry id itself.
 *
 * For activity, `activity_id` (`<checkpoint>:<tx_slot>:<event_slot>:<part>`)
 * is also pinned to its row's time, read by the activity key (AC-144's total
 * order), so the read is an index lookup whether blast-infra stores
 * `activity_id` or derives it. **A derived one alone scans every row** — 3 s
 * at a million rows — which is why every single-entry reader goes through
 * this, including the worker's (T-026 measured 188 ms p50 without it).
 */
export function entryBranchFilterSql(
  branch: NonNullable<ReturnType<typeof entryIdBranch>>,
  keyParameter: string,
  entryParameter: string,
): string {
  const key = checkParameter(keyParameter);
  const entry = checkParameter(entryParameter);
  if (branch.source !== "activity") return `e.source = '${branch.source}' AND e.presale_id = ${key} AND e.entry_id = ${entry}`;
  return `e.source = 'activity' AND e.activity_id = ${key} AND e.entry_id = ${entry}
       AND e.occurred_at_ms = (
         SELECT keyed.timestamp_ms FROM ${SHOWN_ACTIVITY} keyed
         WHERE keyed.checkpoint = split_part(${key}, ':', 1)::bigint AND keyed.tx_slot = split_part(${key}, ':', 2)::bigint
           AND keyed.event_slot = split_part(${key}, ':', 3)::bigint AND keyed.part = split_part(${key}, ':', 4)::bigint
       )`;
}

const PARAMETER = /^\$[1-9][0-9]*$/;
function checkParameter(placeholder: string): string {
  if (!PARAMETER.test(placeholder)) throw new EntryQueryError(`Not a SQL parameter: ${JSON.stringify(placeholder)}.`);
  return placeholder;
}

function branchFilterSql(branch: NonNullable<ReturnType<typeof entryIdBranch>>): string {
  return entryBranchFilterSql(branch, "$3", "$4");
}

/**
 * Whether the entry may be shown, reacted to or explained now: it exists and
 * is a named person entry or a presale post of a shown sale
 * (`visibleEntrySql`). An unknown id is not visible.
 */
export async function isVisible(db: ReadableDatabase, entryId: string, thresholds: PresalePostThresholds): Promise<boolean> {
  checkThresholds(thresholds);
  const branch = entryIdBranch(entryId);
  if (!branch) return false;
  // The source is a literal so the planner drops the other branches of the union.
  const result = await db.read<{ visible: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ${SHOWN_FEED_ENTRIES} e
       WHERE ${branchFilterSql(branch)}
         AND ${visibleEntrySql("e", "$1", "$2")}
     ) AS visible`,
    [thresholds.bigCommitUsd, thresholds.bigTradeUsd,
      branch.source === "activity" ? branch.activityId : branch.presaleId, entryId],
  );
  return result.rows[0]?.visible === true;
}

/**
 * The entry `entryId` if it may be shown now (exactly `isVisible`), with the
 * account that names it; null for an unknown, malformed or invisible id. One
 * branch-keyed read, like `isVisible`: a post permalink's item.
 */
export async function visibleEntry(db: ReadableDatabase, entryId: string, thresholds: PresalePostThresholds): Promise<FeedEntry | null> {
  checkThresholds(thresholds);
  const branch = entryIdBranch(entryId);
  if (!branch) return null;
  const result = await db.read<EntryRow>(
    `${SELECT_ENTRY}
     WHERE ${branchFilterSql(branch)}
       AND ${visibleEntrySql("e", "$1", "$2")}`,
    [thresholds.bigCommitUsd, thresholds.bigTradeUsd,
      branch.source === "activity" ? branch.activityId : branch.presaleId, entryId],
  );
  const row = result.rows[0];
  return row ? entryFromRow(row) : null;
}
