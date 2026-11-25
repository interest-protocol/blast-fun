import { recordMetric } from "@blast/core/lib/metrics.ts";
import { z } from "zod";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import { TRADE_ENTRY_KINDS, namedOwnerSql, namedWalletsOfSql, personEntrySql, presalePostSql, visibleEntrySql } from "@blast/core/modules/social/read-model/naming.ts";
import { EntryQueryError, MAX_ENTRY_PAGE, entryFromRow, type FeedEntry } from "@blast/core/modules/social/read-model/entries.ts";
import { PUBLIC_PRESALES, PUBLIC_FEED_ENTRIES, pinnablePresaleSql } from "@blast/core/modules/social/read-model/chain-presales.ts";

/**
 * The For You selection: one public list, the same for every reader.
 *
 * Candidates, all within `for_you_window_days` of now:
 * - every named person entry (commit, claim, trade) of every sharing account,
 *   through the read model's naming rule (default accounts included: they
 *   follow the same rule);
 * - every presale post (lifecycle, milestone, big commit or trade) of a live
 *   presale (`pending`, `open`, `funded`) or of one that migrated within
 *   `for_you_migrated_days`, named or not (an unnamed one shows its address
 *   only, as the mapper decides).
 *
 * Manual pins come first: one latest public post per sale, latest pin first.
 * Ordinary rank: `occurred_at_ms + (active why ? why_boost_ms : 0) + (big ? big_boost_ms : 0)`,
 * descending, then `entry_id` descending (bytewise). The keyset is
 * `(rank, entry_id)`. Every tuning value comes from the `config` of this
 * read, so a change applies on the next uncached read.
 *
 * `hiddenKinds` leaves kinds out of the selection altogether (the trade kinds
 * while trading surfaces are hidden, OA-7), so pages stay full.
 *
 * Entries and pins are scoped to public markets before ranking or LIMIT.
 */

const DAY_MS = 86_400_000;
/** Presale lifecycles whose posts are always For You candidates. */
export const FOR_YOU_LIVE_LIFECYCLES = ["pending", "open", "funded"] as const;

/** A For You keyset position: the last entry of the previous page. */
export type ForYouCursor = Readonly<{ rankMs: number; entryId: string }>;

/** A candidate with its boosted rank. */
export type RankedEntry = FeedEntry & Readonly<{ rankMs: number; pinned?: boolean }>;

export type ForYouWindow = Readonly<{
  config: SocialConfig;
  /** The read's clock: the window and the migrated cut-off count back from it. */
  nowMs: number;
  /** 1 to `MAX_ENTRY_PAGE`. */
  limit: number;
  before?: ForYouCursor | null;
  /** Kinds left out of the selection. */
  hiddenKinds: readonly string[];
  /** Raw entries per scan step (default `FOR_YOU_SCAN_BATCH`; tests use small steps). */
  scanBatch?: number;
}>;

function list(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

/** True when the entry aliased `e` is big now: a commit or trade of a presale at or over its threshold (`isBigEntry`). */
function bigEntrySql(bigCommitUsd: string, bigTradeUsd: string): string {
  return `(e.source = 'activity' AND e.presale_id IS NOT NULL AND (
      (e.kind = 'presale_commit' AND e.usd_value >= ${bigCommitUsd}::numeric)
      OR (e.kind IN (${list(TRADE_ENTRY_KINDS)}) AND e.usd_value >= ${bigTradeUsd}::numeric)
    ))`;
}

/** Raw entries read per scan step: bounds each statement's work and its plan (no JIT, whatever the volume). */
export const FOR_YOU_SCAN_BATCH = 400;

type ScanPosition = "none" | "at_or_before" | "before" | "after";

function scanBatchSql(position: ScanPosition, unusedRankBinds = ""): string {
  const bound = {
    none: "",
    at_or_before: " AND e.occurred_at_ms <= $9::bigint",
    before: ` AND (e.occurred_at_ms, e.entry_id COLLATE "C") < ($9::bigint, $10::text COLLATE "C")`,
    after: " AND e.occurred_at_ms > $9::bigint",
  }[position];
  return `SELECT e.*${unusedRankBinds}
    FROM ${PUBLIC_FEED_ENTRIES} e
    WHERE e.occurred_at_ms >= $3::bigint AND e.kind <> ALL($5::text[])${bound}
    ORDER BY e.occurred_at_ms DESC, e.entry_id COLLATE "C" DESC
    LIMIT $8`;
}

function candidateSql(namedAccount: string): string {
  return `(
    (${personEntrySql("e")} AND ${namedAccount} IS NOT NULL)
    OR (${presalePostSql("e", "$1", "$2")} AND (
      p.lifecycle IN (${list(FOR_YOU_LIVE_LIFECYCLES)})
      OR (p.lifecycle = 'migrated' AND EXISTS (
        SELECT 1 FROM chain_read_v1.presale_lifecycle l
        WHERE l.presale_id = e.presale_id AND l.state = 'migrated' AND l.timestamp_ms >= $4::bigint
      ))
    ))
  )`;
}

/** The chronological count has no rank boosts or display payload. */
function scanSql(position: ScanPosition): string {
  return `SELECT e.entry_id, e.occurred_at_ms, named.account_id AS named_account_id,
      ${candidateSql("named.account_id")} AS candidate
    FROM (${scanBatchSql(position, ", $6::bigint AS why_boost_ms, $7::bigint AS big_boost_ms")}) e
    CROSS JOIN LATERAL (SELECT ${namedOwnerSql("e")} AS account_id) named
    LEFT JOIN ${PUBLIC_PRESALES} p ON p.presale_id = e.presale_id
    ORDER BY e.occurred_at_ms DESC, e.entry_id COLLATE "C" DESC`;
}

/**
 * Resolve naming once per wallet in the bounded raw batch. Keep only the
 * page's worth of ranked keys, then return their display fields from that
 * same batch. The extra unranked row advances a full batch even if no entry
 * qualified. Its raw time is also the ceiling for unseen boosted ranks.
 */
function rankedScanSql(position: Exclude<ScanPosition, "after">, firstExtraBind: number): string {
  const pins = `$${firstExtraBind}`;
  const cursorRank = `$${firstExtraBind + 1}`;
  const cursorId = `$${firstExtraBind + 2}`;
  const limit = `$${firstExtraBind + 3}`;
  return `SELECT result.* FROM (
    WITH batch AS MATERIALIZED (${scanBatchSql(position)}),
    wallets AS MATERIALIZED (
      ${namedWalletsOfSql("ARRAY(SELECT DISTINCT actor FROM batch WHERE actor IS NOT NULL)")}
    ),
    ranked AS (
      SELECT e.entry_id, e.occurred_at_ms, named.account_id AS named_account_id,
        e.occurred_at_ms
          + CASE WHEN EXISTS (SELECT 1 FROM social_whys w WHERE w.entry_id = e.entry_id AND w.state = 'active')
              THEN $6::bigint ELSE 0 END
          + CASE WHEN ${bigEntrySql("$1", "$2")} THEN $7::bigint ELSE 0 END AS rank_ms
      FROM batch e
      LEFT JOIN wallets named ON named.address = e.actor AND named.named_from_ms <= e.occurred_at_ms
      LEFT JOIN ${PUBLIC_PRESALES} p ON p.presale_id = e.presale_id
      WHERE e.entry_id <> ALL(${pins}::text[]) AND ${candidateSql("named.account_id")}
    ),
    chosen AS (
      SELECT entry_id, occurred_at_ms, named_account_id, rank_ms FROM ranked
      WHERE ${cursorRank}::bigint IS NULL
        OR (rank_ms, convert_to(entry_id, 'UTF8')) < (${cursorRank}::bigint, ${cursorId}::bytea)
      ORDER BY rank_ms DESC, entry_id COLLATE "C" DESC
      LIMIT ${limit}::int
    )
    SELECT e.*, chosen.named_account_id, chosen.rank_ms
    FROM chosen JOIN batch e USING (entry_id, occurred_at_ms)
    UNION ALL
    SELECT last_row.*, NULL::uuid, NULL::bigint
    FROM (
      SELECT e.* FROM batch e
      ORDER BY e.occurred_at_ms DESC, e.entry_id COLLATE "C" DESC
      OFFSET ($8::int - 1) LIMIT 1
    ) last_row
  ) result`;
}

type RankedScanRow = Parameters<typeof entryFromRow>[0] & Readonly<{ rank_ms: string | null }>;
type NewHeadRow = Pick<RankedScanRow, "entry_id" | "occurred_at_ms" | "named_account_id"> & Readonly<{ candidate: boolean }>;

/** One latest public post per eligible pinned sale. Pins override post age, never sale eligibility or visibility. */
async function pinnedEntries(db: ReadableDatabase, config: SocialConfig, nowMs: number, hiddenKinds: readonly string[]): Promise<RankedEntry[]> {
  const { rows } = await db.read<Parameters<typeof entryFromRow>[0] & { rank_ms: string }>(
    `SELECT e.*, ${namedOwnerSql("e")} AS named_account_id,
       (9007199254740991 - row_number() OVER (ORDER BY pin.pinned_at DESC, pin.presale_id COLLATE "C" DESC))::text AS rank_ms
     FROM social_presale_pins pin
     JOIN ${PUBLIC_PRESALES} p ON p.presale_id = pin.presale_id
     CROSS JOIN LATERAL (
       SELECT * FROM ${PUBLIC_FEED_ENTRIES} e WHERE e.presale_id = pin.presale_id
         AND e.kind <> ALL($3::text[]) AND ${visibleEntrySql("e", "$1", "$2")}
       ORDER BY e.occurred_at_ms DESC, e.entry_id COLLATE "C" DESC LIMIT 1
     ) e
     WHERE ${pinnablePresaleSql("p", "$4::bigint")}
     ORDER BY pin.pinned_at DESC, pin.presale_id COLLATE "C" DESC`,
    [config.big_commit_usd, config.big_trade_usd, [...hiddenKinds], nowMs],
  );
  return rows.map((row) => ({ ...entryFromRow(row), rankMs: Number(row.rank_ms), pinned: true }));
}

function checkWindow(window: ForYouWindow): void {
  if (!z.number().int().min(1).max(MAX_ENTRY_PAGE).safeParse(window.limit).success) {
    throw new EntryQueryError(`The page size must be an integer from 1 to ${MAX_ENTRY_PAGE}.`);
  }
  if (!z.number().int().nonnegative().safeParse(window.nowMs).success) throw new EntryQueryError("The clock must be a non-negative integer.");
  if (window.before) {
    if (!z.number().int().nonnegative().safeParse(window.before.rankMs).success) throw new EntryQueryError("The cursor rank is invalid.");
    if (!z.string().min(1).safeParse(window.before.entryId).success) throw new EntryQueryError("The cursor entry id is invalid.");
  }
}

/** $1 to $7 of a scan step for this read. */
function scanValues(config: SocialConfig, nowMs: number, hiddenKinds: readonly string[]): unknown[] {
  return [
    config.big_commit_usd,
    config.big_trade_usd,
    Math.max(nowMs - config.for_you_window_days * DAY_MS, 0),
    Math.max(nowMs - config.for_you_migrated_days * DAY_MS, 0),
    [...hiddenKinds],
    config.why_boost_ms,
    config.big_boost_ms,
  ];
}

/** Bytewise (`COLLATE "C"`) order of two entry ids, as the SQL keysets compare them. */
function compareIds(a: string, b: string): number {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return Buffer.compare(left, right);
}

/** Rank order: rank descending, then `entry_id` descending (bytewise). */
function byRank(a: RankedEntry, b: RankedEntry): number {
  return b.rankMs - a.rankMs || compareIds(b.entryId, a.entryId);
}

/** Whether `entry` comes strictly after the cursor in rank order. */
function afterCursor(entry: RankedEntry, cursor: ForYouCursor): boolean {
  return entry.rankMs < cursor.rankMs || (entry.rankMs === cursor.rankMs && compareIds(entry.entryId, cursor.entryId) < 0);
}

/**
 * One page of For You candidates in rank order, each with its rank.
 *
 * After pinned posts (excluded from the ordinary scan), rank is time plus at most `why_boost_ms + big_boost_ms`, so the page is found
 * by reading the window newest first in bounded steps: once `limit`
 * candidates rank above every entry not read yet (whose rank is at most the
 * last read time plus the largest boost), the page is final. A page after a
 * cursor starts at the cursor's rank, since nothing newer can rank below it.
 * The work is proportional to the entries within one boost of the page, not
 * to the window.
 */
export async function forYouEntries(db: ReadableDatabase, window: ForYouWindow): Promise<RankedEntry[]> {
  checkWindow(window);
  const { config, nowMs, limit } = window;
  const before = window.before ?? null;
  const maxBoost = config.why_boost_ms + config.big_boost_ms;
  const values = scanValues(config, nowMs, window.hiddenKinds);
  const batch = window.scanBatch ?? FOR_YOU_SCAN_BATCH;
  const pins = await pinnedEntries(db, config, nowMs, window.hiddenKinds);
  const pinnedIds = pins.map((entry) => entry.entryId);
  const found: RankedEntry[] = pins.filter((entry) => !before || afterCursor(entry, before));
  let position: Exclude<ScanPosition, "after"> = "none";
  let bound: readonly unknown[] = [];
  let beforeId: Buffer | null = null;
  if (before) {
    position = "at_or_before";
    bound = [before.rankMs];
    // The cursor compares UTF-8 bytes and may name a string Postgres cannot bind as text.
    beforeId = Buffer.from(before.entryId, "utf8");
  }
  for (;;) {
    const { rows } = await db.read<RankedScanRow>(rankedScanSql(position, 9 + bound.length), [
      ...values, batch, ...bound, pinnedIds, before?.rankMs ?? null, beforeId, limit,
    ]);
    let last: RankedScanRow | undefined;
    for (const row of rows) {
      if (row.rank_ms === null) {
        last = row;
        continue;
      }
      found.push({ ...entryFromRow(row), rankMs: Number(row.rank_ms) });
    }
    found.sort(byRank);
    if (found.length > limit) found.length = limit;
    if (!last) break;
    // Everything not read yet ranks at most the last read time plus the largest boost.
    const ceiling = Number(last.occurred_at_ms) + maxBoost;
    if (found.length === limit && found[limit - 1]!.rankMs > ceiling) break;
    position = "before";
    bound = [Number(last.occurred_at_ms), last.entry_id];
  }
  return found;
}

/** What the "N new posts" pill needs: how many candidates are newer, and the newest named actors among them. */
export type ForYouNewEntries = Readonly<{
  /** Candidates with `occurred_at_ms > sinceMs`, at most `max`. */
  count: number;
  more: boolean;
  /** The newest distinct named accounts among them, newest first, at most `actors`. */
  actorIds: readonly string[];
}>;

/** A bounded chronological prefix; the extra entry distinguishes a full cap from more. */
export type ForYouNewHead = Readonly<{
  max: number;
  entries: readonly Readonly<{ entryId: string; occurredAtMs: number; namedAccountId: string | null }>[];
}>;

type NewHeadRequest = Readonly<{
  config: SocialConfig;
  nowMs: number;
  max: number;
  hiddenKinds: readonly string[];
  scanBatch?: number;
}>;

function checkNewWindow(sinceMs: number, max: number): void {
  if (!z.number().int().nonnegative().safeParse(sinceMs).success) throw new EntryQueryError("The window start must be a non-negative integer of milliseconds.");
  if (!z.number().int().min(1).max(MAX_ENTRY_PAGE).safeParse(max).success) throw new EntryQueryError(`The cap must be an integer from 1 to ${MAX_ENTRY_PAGE}.`);
}

async function newEntryHead(db: ReadableDatabase, request: NewHeadRequest, sinceMs: number, mode: "head" | "since"): Promise<ForYouNewHead> {
  const { config, nowMs, max } = request;
  checkNewWindow(sinceMs, max);
  const values = scanValues(config, nowMs, request.hiddenKinds);
  const batch = request.scanBatch ?? FOR_YOU_SCAN_BATCH;
  const started = performance.now();
  let steps = 0;
  let rows = 0;
  let outcome: "ok" | "error" = "error";
  try {
    const candidates: NewHeadRow[] = [];
    let position: { sql: string; values: unknown[] } = { sql: scanSql("after"), values: [sinceMs] };
    for (;;) {
      steps += 1;
      const result = await db.read<NewHeadRow>(position.sql, [...values, batch, ...position.values]);
      rows += result.rows.length;
      candidates.push(...result.rows.filter((row) => row.candidate && Number(row.occurred_at_ms) > sinceMs));
      const last = result.rows.at(-1);
      if (candidates.length > max || !last || result.rows.length < batch || Number(last.occurred_at_ms) <= sinceMs) break;
      position = { sql: scanSql("before"), values: [Number(last.occurred_at_ms), last.entry_id] };
    }
    const head = {
      max,
      entries: candidates.slice(0, max + 1).map((row) => ({
        entryId: row.entry_id,
        occurredAtMs: Number(row.occurred_at_ms),
        namedAccountId: row.named_account_id,
      })),
    };
    outcome = "ok";
    return head;
  } finally {
    // Telemetry is value-free and must never replace a source result or failure.
    try {
      if (outcome === "error" || Math.random() < 0.02) {
        recordMetric("social.feed_new.scan", {
          mode, steps, rows, durationMs: Math.round(performance.now() - started), outcome,
          ...(outcome === "ok" ? { sampleRate: 0.02 } : {}),
        });
      }
    } catch { /* The metrics sink does not own the read. */ }
  }
}

/**
 * Newest `max + 1` eligible entries, without pins or rank boosts. A bounded
 * output can still require several raw scan steps when candidates are sparse.
 */
export function forYouNewHead(db: ReadableDatabase, request: NewHeadRequest): Promise<ForYouNewHead> {
  return newEntryHead(db, request, 0, "head");
}

/** A lower time bound selects a prefix of the same chronological head. */
export function forYouNewEntriesFromHead(head: ForYouNewHead, sinceMs: number, actors: number): ForYouNewEntries {
  checkNewWindow(sinceMs, head.max);
  const candidates = head.entries.filter((entry) => entry.occurredAtMs > sinceMs);
  const named = [...new Set(candidates.slice(0, head.max).flatMap((entry) => entry.namedAccountId ? [entry.namedAccountId] : []))];
  return { count: Math.min(candidates.length, head.max), more: candidates.length > head.max, actorIds: named.slice(0, actors) };
}

/** Direct reads retain the since-bound SQL scan; shared readers use one complete head. */
export async function forYouNewEntries(
  db: ReadableDatabase,
  request: NewHeadRequest & Readonly<{ sinceMs: number; actors: number }>,
): Promise<ForYouNewEntries> {
  return forYouNewEntriesFromHead(await newEntryHead(db, request, request.sinceMs, "since"), request.sinceMs, request.actors);
}
