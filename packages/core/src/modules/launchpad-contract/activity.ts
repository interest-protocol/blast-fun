import { matchesSchema, listSchema, contractObject, contractValue, recordSchema, ContractViolation, parseAtomic, parseCount, parseSignedAtomic } from "./decimal.ts";
import { z } from "zod";
import type { MarketDataDependencies } from "../read-routing/market-data.ts";
import { CursorError, EVENT_CURSOR, compareKeys, decodeCursor, encodeCursor, type CursorPosition, type CursorShape } from "./cursor.ts";
import type { RoutedRead } from "./read.ts";
import { readV1, type V1Answer } from "./v1.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { MIGRATOR_POOL_KEY, type MigratorVenue } from "./venues.ts";

/**
 * The opening-round and core activity reads of blast-infra's `/v1` (its
 * docs/api.md "Pool summary", "GET /v1/launches/{launch_id}/activity" with
 * `view=classified`, and "GET /v1/launches/{launch_id}/opening-round/bidders"):
 *
 * - `parseOpeningRound`: a curve summary's `opening_round` object, its timing
 *   null before `LaunchShared`, never inferred;
 * - `parseWindowFlow`: a curve summary's windows' `net_quote_flow`, `buyers`
 *   and `sellers`, which never count the opening-round settlement;
 * - the bidders list and the classified activity, each checked whole against
 *   its order, vocabulary and next cursor before any projection uses it, so a
 *   broken answer is Unavailable, never a reordered or relabelled list.
 *
 * The settlement's curve buy is an `opening_settlement` row with source
 * `opening_round_settlement`: `countsAsUserTrade` is false for it. The two
 * settlement rows differ by amounts: the curve buy has `quote`, the close
 * `bids`. Actors (contract revision 4): a delivery's `bidder`; a join's
 * sender, whom the contract keys the bid by; a curve trade's executing signer
 * (not necessarily the coins' final recipient); `null` on settlement,
 * lifecycle and migration rows. Page tokens are bound to their launch. The
 * rules mirror blast-infra `src/activity/`, `src/opening/` and `src/flow/` at
 * `lst/T-025-1`.
 */

const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const POSITION_WIDTH = 20;
const PAGE_CEILING = 100;

/**
 * blast-infra's default page bounds for launch collections: its
 * `DISCOVERY_PAGE_DEFAULT` and `DISCOVERY_PAGE_MAX` bound the discovery views,
 * the bidders and the classified activity alike. A deployment that changes them
 * there passes its own bounds to the path builders and readers.
 */
export const LAUNCH_PAGE: Readonly<{ default: number; max: number }> = { default: 25, max: 100 };

/** A launch's bidders list page token: no key, the first join's `(checkpoint, tx, event)`. */
export function biddersCursor(launchId: string): CursorShape {
  return { scope: `opening_round_bidders:${launchId}`, key: [], tie: 3 };
}

/** A launch's classified activity page token: no key, the row's `(checkpoint, tx, event, sub)`. */
export function activityCursor(launchId: string): CursorShape {
  return { scope: `launch_activity:${launchId}`, key: [], tie: 4 };
}

/**
 * Where a durable activity link (`position`, a launch row's or a pool trade's
 * `"<checkpoint>:<tx_slot>:<event_slot>:<sub>"`) starts reading: the launch
 * activity page token and the pool-trade `before` just newer than the
 * position, so the record itself is the first row of both. CursorError when
 * the position is not one.
 */
export function activityAnchor(launchId: string, position: string): Readonly<{ position: string; cursor: string; before: string }> {
  if (!SUI_OBJECT_ID_PATTERN.test(launchId)) throw new CursorError("launch_id must be a canonical object id");
  if (!EVENT_CURSOR.test(position)) throw new CursorError("an activity link must be a position <checkpoint>:<tx>:<event>:<sub>");
  const [checkpoint, tx, event, sub] = position.split(":");
  const next = (BigInt(sub) + 1n).toString();
  const tie = [checkpoint, tx, event, next].map((part) => part.padStart(POSITION_WIDTH, "0"));
  if (tie.some((part) => part.length > POSITION_WIDTH)) throw new CursorError("an activity link's position is out of range");
  return { position, cursor: encodeCursor(activityCursor(launchId), [], tie), before: `${checkpoint}:${tx}:${event}:${next}` };
}

function record(value: unknown, field: string): Record<string, unknown> {
  return contractValue(recordSchema, value, field, "must be an object");
}

function matching(value: unknown, pattern: RegExp, field: string, what: string): string {
  return contractValue(z.string().regex(pattern), value, field, `must be ${what}`);
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  contractObject(value, field, keys, []);
}

/** A chain event's checkpoint, checkpoint time and transaction digest. */
export type EventStamp = Readonly<{ checkpoint: number; timestampMs: number; digest: string }>;

function parseStamp(value: Record<string, unknown>, field: string): EventStamp {
  return {
    checkpoint: parseCount(value.checkpoint, `${field}.checkpoint`),
    timestampMs: parseCount(value.timestamp_ms, `${field}.timestamp_ms`),
    digest: matching(value.digest, DIGEST, `${field}.digest`, "a transaction digest"),
  };
}

/** A native position `c:t:e:p` and its padded tie-break parts. */
function positionParts(position: string, parts: number): string[] {
  return position.split(":").slice(0, parts).map((part) => part.padStart(POSITION_WIDTH, "0"));
}

export const OPENING_STATES = ["pending", "open", "ended_unsettled", "settled"] as const;
export type OpeningState = (typeof OPENING_STATES)[number];

/** A launch's opening round as its summary's checkpoint leaves it. */
export type OpeningRound = Readonly<{
  durationMs: bigint;
  /** `public_start_ms`; null before `LaunchShared`. */
  startsAtMs: bigint | null;
  /** `startsAtMs + durationMs`; null before `LaunchShared`. */
  endsAtMs: bigint | null;
  totalCommittedQuote: bigint;
  bidderCount: number;
  settlement: EventStamp | null;
  deliveredCount: number;
  undeliveredCount: number;
  state: OpeningState;
}>;

const ROUND_KEYS = [
  "duration_ms", "starts_at_ms", "ends_at_ms", "total_committed_quote", "bidder_count", "settlement",
  "delivered_count", "undelivered_count", "state",
];

/** A curve summary's `opening_round`; its timing, counts and state must agree. */
export function parseOpeningRound(value: unknown, field: string): OpeningRound {
  const round = record(value, field);
  exactKeys(round, ROUND_KEYS, field);
  const durationMs = parseAtomic(round.duration_ms, `${field}.duration_ms`, 64);
  const startsAtMs = nullable(round.starts_at_ms, (ms) => parseAtomic(ms, `${field}.starts_at_ms`, 64));
  const endsAtMs = nullable(round.ends_at_ms, (ms) => parseAtomic(ms, `${field}.ends_at_ms`));
  if (endsAtMs !== (startsAtMs === null ? null : startsAtMs + durationMs)) {
    throw new ContractViolation(`${field}.ends_at_ms`, "is starts_at_ms + duration_ms, and null with it");
  }
  const bidderCount = parseCount(round.bidder_count, `${field}.bidder_count`);
  const deliveredCount = parseCount(round.delivered_count, `${field}.delivered_count`);
  const undeliveredCount = parseCount(round.undelivered_count, `${field}.undelivered_count`);
  if (deliveredCount + undeliveredCount !== bidderCount) {
    throw new ContractViolation(`${field}.undelivered_count`, "is bidder_count less delivered_count");
  }
  const settlement = nullable(round.settlement, (stamp) => {
    const at = `${field}.settlement`;
    const value = record(stamp, at);
    exactKeys(value, ["checkpoint", "timestamp_ms", "digest"], at);
    return parseStamp(value, at);
  });
  const state = round.state as OpeningState;
  if (!matchesSchema(z.enum(OPENING_STATES), state)) throw new ContractViolation(`${field}.state`, "is unknown");
  if ((state === "settled") !== (settlement !== null)) {
    throw new ContractViolation(`${field}.state`, "is settled exactly when there is a settlement");
  }
  if (state !== "settled" && (state === "pending") !== (startsAtMs === null)) {
    throw new ContractViolation(`${field}.state`, "is pending exactly before the round starts");
  }
  return {
    durationMs,
    startsAtMs,
    endsAtMs,
    totalCommittedQuote: parseAtomic(round.total_committed_quote, `${field}.total_committed_quote`, 64),
    bidderCount,
    settlement,
    deliveredCount,
    undeliveredCount,
    state,
  };
}

export const WINDOW_NAMES = ["5m", "1h", "6h", "24h", "all"] as const;
export type WindowName = (typeof WINDOW_NAMES)[number];

/** One window's flow: the curve buys' trader-side Quote less the sells', and distinct traders. */
export type WindowFlow = Readonly<{ netQuoteFlow: bigint; buyers: number; sellers: number }>;

/** The flow fields of a curve summary's windows, every named window present. */
export function parseWindowFlow(value: unknown, field: string): Readonly<Record<WindowName, WindowFlow>> {
  const windows = record(value, field);
  const flow = {} as Record<WindowName, WindowFlow>;
  for (const name of WINDOW_NAMES) {
    const at = `${field}.${name}`;
    const window = record(windows[name], at);
    flow[name] = {
      netQuoteFlow: parseSignedAtomic(window.net_quote_flow, `${at}.net_quote_flow`),
      buyers: parseCount(window.buyers, `${at}.buyers`),
      sellers: parseCount(window.sellers, `${at}.sellers`),
    };
  }
  return flow;
}

/** A launch curve's windowed flow, as its pool summary's checkpoint leaves it. */
export type CurveFlow = Readonly<{ windows: Readonly<Record<WindowName, WindowFlow>> }>;

/**
 * `GET /v1/pools/blast_curve/{launch_id}`'s flow: the launch's own curve
 * summary's windows, each with its flow fields. The web app computes none of
 * them; a summary of another pool, or without them, is a contract violation.
 */
export function parseCurveFlow(launchId: string, body: unknown): CurveFlow {
  const pool = record(record(body, "body").pool, "pool");
  if (pool.pool_key !== `blast_curve:${launchId}` || pool.pool_id !== launchId || pool.venue !== "blast_curve") {
    throw new ContractViolation("pool.pool_key", "must be the requested launch's curve");
  }
  return { windows: parseWindowFlow(pool.windows, "pool.windows") };
}

/** Reads the launch curve's windowed flow from blast-infra, validated, with its provenance. */
export function readCurveFlow(
  launchId: string,
  dependencies: MarketDataDependencies,
): Promise<RoutedRead<V1Answer<CurveFlow>>> {
  if (!SUI_OBJECT_ID_PATTERN.test(launchId)) throw new CursorError("launch_id must be a canonical object id");
  return readV1("market", `/v1/pools/blast_curve/${launchId}`, (body) => parseCurveFlow(launchId, body), dependencies);
}

// --- Bidders ---------------------------------------------------------------------------------------

/** One bidder of an opening round: the address the contract keyed its bid by. */
export type OpeningBidder = Readonly<{
  bidder: string;
  contributedQuote: bigint;
  joinCount: number;
  firstJoin: EventStamp & Readonly<{ position: string }>;
  delivery: (EventStamp & Readonly<{ meme: bigint; refundQuote: bigint }>) | null;
}>;

export type BiddersPage = Readonly<{ launchId: string; bidders: readonly OpeningBidder[]; nextCursor: string | null }>;

function parseBidder(value: unknown, field: string): OpeningBidder {
  const row = record(value, field);
  exactKeys(row, ["bidder", "contributed_quote", "join_count", "first_join", "delivery"], field);
  const first = record(row.first_join, `${field}.first_join`);
  exactKeys(first, ["position", "checkpoint", "timestamp_ms", "digest"], `${field}.first_join`);
  const position = matching(first.position, EVENT_CURSOR, `${field}.first_join.position`, "a position");
  const firstJoin = { ...parseStamp(first, `${field}.first_join`), position };
  if (position.split(":")[0] !== String(firstJoin.checkpoint) || !position.endsWith(":0")) {
    throw new ContractViolation(`${field}.first_join.position`, "is its event's position in its checkpoint");
  }
  const joinCount = parseCount(row.join_count, `${field}.join_count`);
  if (joinCount < 1) throw new ContractViolation(`${field}.join_count`, "is at least 1");
  return {
    bidder: matching(row.bidder, SUI_OBJECT_ID_PATTERN, `${field}.bidder`, "an address"),
    contributedQuote: parseAtomic(row.contributed_quote, `${field}.contributed_quote`, 64),
    joinCount,
    firstJoin,
    delivery: nullable(row.delivery, (value) => {
      const at = `${field}.delivery`;
      const delivery = record(value, at);
      exactKeys(delivery, ["meme", "refund_quote", "checkpoint", "timestamp_ms", "digest"], at);
      return {
        ...parseStamp(delivery, at),
        meme: parseAtomic(delivery.meme, `${at}.meme`, 64),
        refundQuote: parseAtomic(delivery.refund_quote, `${at}.refund_quote`, 64),
      };
    }),
  };
}

/** Checks rows are in `direction` order by `place` and that `nextCursor` is the last row's place. */
function checkPage(
  shape: CursorShape,
  places: readonly CursorPosition[],
  ascending: boolean,
  nextCursor: string | null,
  field: string,
): void {
  places.slice(1).forEach((place, index) => {
    const order = compareKeys(shape, places[index], place);
    if (ascending ? order >= 0 : order <= 0) throw new ContractViolation(`${field}[${index + 1}]`, "is out of order");
  });
  if (nextCursor === null) return;
  let after: CursorPosition;
  try {
    after = decodeCursor(nextCursor, shape);
  } catch (error) {
    if (error instanceof CursorError) throw new ContractViolation("next_cursor", error.message);
    throw error;
  }
  const last = places.at(-1);
  if (!last || compareKeys(shape, last, after) !== 0) throw new ContractViolation("next_cursor", "must be the page's last place");
}

/** A validated bidders page: distinct bidders in first-join order, the next cursor at the last. */
export function parseBiddersPage(body: unknown): BiddersPage {
  const answer = record(body, "body");
  const rows = answer.bidders;
  if (!matchesSchema(listSchema.max(PAGE_CEILING), rows)) throw new ContractViolation("bidders", `must be a list of at most ${PAGE_CEILING}`);
  const bidders = rows.map((row, index) => parseBidder(row, `bidders[${index}]`));
  if (new Set(bidders.map((bidder) => bidder.bidder)).size !== bidders.length) {
    throw new ContractViolation("bidders", "lists each bidder once");
  }
  const nextCursor = nullable(answer.next_cursor, (token) => matching(token, /^[A-Za-z0-9_-]+$/, "next_cursor", "a page token"));
  const launchId = matching(answer.launch_id, SUI_OBJECT_ID_PATTERN, "launch_id", "an object id");
  checkPage(
    biddersCursor(launchId),
    bidders.map((bidder) => ({ key: [], tie: positionParts(bidder.firstJoin.position, 3) })),
    true,
    nextCursor,
    "bidders",
  );
  return { launchId, bidders, nextCursor };
}

// --- Classified activity ---------------------------------------------------------------------------

export const ACTIVITY_KINDS = [
  "curve_buy", "curve_sell", "opening_join", "opening_settlement", "opening_delivery", "lifecycle", "migration",
  "migration_allocation", "creator_fees_claimed", "owner_balances_claimed", "protocol_fees_claimed", "reward_claimed", "venue_buy", "venue_sell",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
const activityKindSchema = z.enum(ACTIVITY_KINDS);
const activityKindNameSchema = z.string().min(1);
/** A trade's origin by name. */
export type ActivityOrigin = "user" | "creator_pre_share" | "opening_round_settlement";
/**
 * A row's source: a trade's origin, a venue swap's pool key
 * (`cetus:0x…`, `bluefin:0x…`), or the address a payment went to (a protocol
 * claim's treasury, an allocation's destination), or the relayer of a vault reward claim.
 */
export type ActivitySource = ActivityOrigin | `${MigratorVenue}:0x${string}` | `0x${string}`;

type SourceForm = "venue_pool" | "payee" | "optional_relayer";

/**
 * Each kind's sources, whether it names an actor, and its amounts; a settlement
 * row's amounts are its curve buy's or its close's. LP-07 (blast-infra
 * `src/activity/`): the curve's claims and the migration's allocations, and
 * the venue pool's swaps after migration, merged by blast-infra from its trade
 * tape.
 */
const KIND_RULES: Readonly<
  Record<ActivityKind, Readonly<{ sources: readonly (ActivityOrigin | null)[] | SourceForm; actor: boolean; amounts: readonly (readonly string[])[] }>>
> = {
  curve_buy: { sources: ["user", "creator_pre_share"], actor: true, amounts: [["quote", "meme"]] },
  curve_sell: { sources: ["user"], actor: true, amounts: [["quote", "meme"]] },
  opening_join: { sources: [null], actor: true, amounts: [["quote", "bids"]] },
  opening_settlement: { sources: ["opening_round_settlement"], actor: false, amounts: [["quote", "meme"], ["bids", "meme", "refund_quote"]] },
  opening_delivery: { sources: [null], actor: true, amounts: [["bid", "meme", "refund_quote"]] },
  lifecycle: { sources: [null], actor: false, amounts: [[]] },
  migration: { sources: [null], actor: false, amounts: [["meme", "quote", "disposed_meme", "total_supply_after"]] },
  migration_allocation: { sources: "payee", actor: false, amounts: [["meme", "quote"]] },
  creator_fees_claimed: { sources: [null], actor: true, amounts: [["meme", "quote"]] },
  owner_balances_claimed: { sources: [null], actor: true, amounts: [["meme", "quote"]] },
  protocol_fees_claimed: { sources: "payee", actor: false, amounts: [["meme", "quote", "sui", "partner_meme", "partner_quote", "partner_sui"]] },
  reward_claimed: { sources: "optional_relayer", actor: true, amounts: [["meme", "quote"]] },
  venue_buy: { sources: "venue_pool", actor: true, amounts: [["quote", "meme"]] },
  venue_sell: { sources: "venue_pool", actor: true, amounts: [["quote", "meme"]] },
};

/** Whether `source` is one `kind` takes. */
function sourceOf(kind: ActivityKind, source: unknown, field: string): ActivitySource | null {
  const sources = KIND_RULES[kind].sources;
  let valid: boolean;
  switch (sources) {
    case "payee":
    case "optional_relayer":
      valid = (source === null && sources === "optional_relayer") ||
        (typeof source === "string" && SUI_OBJECT_ID_PATTERN.test(source));
      break;
    case "venue_pool":
      valid = typeof source === "string" && MIGRATOR_POOL_KEY.test(source);
      break;
    default:
      valid = sources.includes(source as ActivityOrigin | null);
  }
  if (!valid) throw new ContractViolation(field, `is not a source of ${kind}`);
  return source as ActivitySource | null;
}

/** Whether a row is a swap in the coin's venue pool after migration. */
export function isVenueSwap(row: Pick<ActivityRow, "kind">): boolean {
  return row.kind === "venue_buy" || row.kind === "venue_sell";
}

export function isActivityTrade(row: Pick<ActivityRow, "kind">): boolean {
  return row.kind === "curve_buy" || row.kind === "curve_sell" || isVenueSwap(row);
}

const tradeLabelsSchema = z.array(z.enum(["whale", "sniper"])).max(2);
export type IndexedTradeLabel = z.infer<typeof tradeLabelsSchema>[number];

export type ActivityRow = Readonly<{
  /** `"<checkpoint>:<tx_slot>:<event_slot>:<sub>"`; sub 0 for an event, 1 and up for its lifecycle changes. */
  position: string;
  checkpoint: number;
  timestampMs: number;
  digest: string;
  kind: ActivityKind | "unrecognized";
  source: ActivitySource | null;
  /**
   * A delivery's bidder; a join's sender; a curve trade's executing signer
   * (not necessarily the coins' recipient); a creator claim's signer, who
   * presented the cap; a venue swap's trader; a vault reward's beneficiary;
   * null on settlement, lifecycle,
   * migration, allocation and protocol-claim rows.
   */
  actor: string | null;
  labels?: readonly IndexedTradeLabel[];
  lifecycle: "opening_round" | "live" | "migration_ready" | "migrated" | null;
  amounts: Readonly<Record<string, bigint>>;
}>;

export type ClassifiedActivityPage = Readonly<{ activity: readonly ActivityRow[]; nextCursor: string | null }>;

const LIFECYCLES = ["opening_round", "live", "migration_ready", "migrated"] as const;

function parseActivityRow(value: unknown, field: string): ActivityRow {
  const row = record(value, field);
  const stamp = parseStamp(row, field);
  const position = matching(row.position, EVENT_CURSOR, `${field}.position`, "a position");
  const [checkpoint, , , sub] = position.split(":");
  if (checkpoint !== String(stamp.checkpoint)) throw new ContractViolation(`${field}.position`, "is in its checkpoint");
  const wireKind = contractValue(activityKindNameSchema, row.kind, `${field}.kind`, "must be a non-empty string");
  const kind = wireKind === "protocol_fees_paid" ? "protocol_fees_claimed" : wireKind;
  if (!matchesSchema(activityKindSchema, kind)) {
    // Keep its place in the page so a new kind cannot break trade reads or pagination.
    return { position, ...stamp, kind: "unrecognized", source: null, actor: null, lifecycle: null, amounts: {} };
  }
  contractObject(row, field, ["position", "checkpoint", "timestamp_ms", "digest", "kind", "source", "actor", "lifecycle", "amounts"], ["labels"]);
  const rules = KIND_RULES[kind];
  const source = sourceOf(kind, row.source, `${field}.source`);
  const actor = nullable(row.actor, (value) => matching(value, SUI_OBJECT_ID_PATTERN, `${field}.actor`, "an address"));
  if ((actor !== null) !== rules.actor) {
    throw new ContractViolation(`${field}.actor`, rules.actor ? `is required on ${kind}` : `is null on ${kind}`);
  }
  const lifecycle = row.lifecycle as ActivityRow["lifecycle"];
  if (lifecycle !== null && !matchesSchema(z.enum(LIFECYCLES), lifecycle)) throw new ContractViolation(`${field}.lifecycle`, "is unknown");
  if ((kind === "lifecycle") !== (lifecycle !== null) || (kind === "lifecycle") !== (sub !== "0")) {
    throw new ContractViolation(`${field}.lifecycle`, "is set on lifecycle rows, at sub 1 and up, only");
  }
  const amountsValue = record(row.amounts, `${field}.amounts`);
  const names = Object.keys(amountsValue).sort();
  if (!rules.amounts.some((allowed) => [...allowed].sort().join() === names.join())) {
    throw new ContractViolation(`${field}.amounts`, `are not ${kind}'s`);
  }
  const amounts: Record<string, bigint> = {};
  for (const name of names) amounts[name] = parseAtomic(amountsValue[name], `${field}.amounts.${name}`, 64);
  const labels = row.labels === undefined ? [] : contractValue(tradeLabelsSchema, row.labels, `${field}.labels`, "must list known trade labels");
  if (labels.length && (!isActivityTrade({ kind }) || new Set(labels).size !== labels.length)) {
    throw new ContractViolation(`${field}.labels`, "must list each label once on a trade");
  }
  return { position, ...stamp, kind, source, actor, lifecycle, amounts, ...(labels.length ? { labels } : {}) };
}

/**
 * A validated classified activity page of `launchId`: newest first by native
 * position, the next cursor at the last and bound to the launch.
 */
export function parseClassifiedActivityPage(launchId: string, body: unknown): ClassifiedActivityPage {
  const answer = record(body, "body");
  const rows = answer.activity;
  if (!matchesSchema(listSchema.max(PAGE_CEILING), rows)) throw new ContractViolation("activity", `must be a list of at most ${PAGE_CEILING}`);
  const activity = rows.map((row, index) => parseActivityRow(row, `activity[${index}]`));
  const nextCursor = nullable(answer.next_cursor, (token) => matching(token, /^[A-Za-z0-9_-]+$/, "next_cursor", "a page token"));
  checkPage(
    activityCursor(launchId),
    activity.map((row) => ({ key: [], tie: positionParts(row.position, 4) })),
    false,
    nextCursor,
    "activity",
  );
  return { activity, nextCursor };
}

/** Whether a row is an ordinary trade by a user: a curve buy or sell, never the opening settlement. */
export function countsAsUserTrade(row: ActivityRow): boolean {
  return row.kind === "curve_buy" || row.kind === "curve_sell";
}

// --- Requests --------------------------------------------------------------------------------------

export type LaunchPageRequest = Readonly<{ limit?: string | null; cursor?: string | null }>;

function launchPath(launchId: string): string {
  if (!SUI_OBJECT_ID_PATTERN.test(launchId)) throw new CursorError("launch_id must be a canonical object id");
  return `/v1/launches/${launchId}`;
}

/** A page request's `limit` and `cursor` as query parameters: a bad limit or another list's token is a CursorError. */
export function pageParams(request: LaunchPageRequest, shape: CursorShape, bounds: Readonly<{ default: number; max: number }>): URLSearchParams {
  let limit = bounds.default;
  if (request.limit !== undefined && request.limit !== null) {
    limit = /^[0-9]{1,15}$/.test(request.limit) ? Number(request.limit) : 0;
    if (limit < 1 || limit > bounds.max) throw new CursorError(`limit must be a whole number from 1 to ${bounds.max}`);
  }
  const params = new URLSearchParams({ limit: String(limit) });
  if (request.cursor !== undefined && request.cursor !== null) {
    decodeCursor(request.cursor, shape);
    params.set("cursor", request.cursor);
  }
  return params;
}

/** The classified activity page's path; a bad limit or another list's cursor is a CursorError. */
export function classifiedActivityPath(
  launchId: string,
  request: LaunchPageRequest & Readonly<{ walletLabels?: boolean }>,
  bounds: Readonly<{ default: number; max: number }> = LAUNCH_PAGE,
): string {
  launchPath(launchId);
  const params = pageParams(request, activityCursor(launchId), bounds);
  if (request.walletLabels) params.set("wallet_labels", "true");
  return `${launchPath(launchId)}/activity?view=classified&${params.toString()}`;
}

/** The bidders page's path; `wallet` takes no cursor. */
export function biddersPath(
  launchId: string,
  request: LaunchPageRequest & Readonly<{ wallet?: string | null }>,
  bounds: Readonly<{ default: number; max: number }> = LAUNCH_PAGE,
): string {
  launchPath(launchId);
  const params = pageParams(request, biddersCursor(launchId), bounds);
  if (request.wallet !== undefined && request.wallet !== null) {
    if (params.has("cursor")) throw new CursorError("wallet takes no cursor");
    if (!SUI_OBJECT_ID_PATTERN.test(request.wallet)) throw new CursorError("wallet must be a canonical address");
    params.set("wallet", request.wallet);
  }
  return `${launchPath(launchId)}/opening-round/bidders?${params.toString()}`;
}

/** Reads one classified activity page from blast-infra, validated, with its provenance. */
export function readClassifiedActivity(
  launchId: string,
  request: LaunchPageRequest & Readonly<{ walletLabels?: boolean }>,
  dependencies: MarketDataDependencies,
  bounds?: Readonly<{ default: number; max: number }>,
): Promise<RoutedRead<V1Answer<ClassifiedActivityPage>>> {
  return readV1(
    "market",
    classifiedActivityPath(launchId, request, bounds),
    (body) => parseClassifiedActivityPage(launchId, body),
    dependencies,
  );
}

/** Reads one bidders page from blast-infra, validated, with its provenance. */
export function readOpeningBidders(
  launchId: string,
  request: LaunchPageRequest & Readonly<{ wallet?: string | null }>,
  dependencies: MarketDataDependencies,
  bounds?: Readonly<{ default: number; max: number }>,
): Promise<RoutedRead<V1Answer<BiddersPage>>> {
  return readV1("market", biddersPath(launchId, request, bounds), parseBiddersPage, dependencies);
}
