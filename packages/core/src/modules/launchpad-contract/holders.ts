import { z } from "zod";
import { matchesSchema, listSchema, contractObject, contractValue, recordSchema, ContractViolation, parseAtomic, parseCount } from "@blast/core/modules/launchpad-contract/decimal.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { LAUNCH_PAGE, type LaunchPageRequest } from "@blast/core/modules/launchpad-contract/activity.ts";
import { CursorError, decodeCursor, type CursorShape } from "@blast/core/modules/launchpad-contract/cursor.ts";
import type { RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import { readV1, type V1Answer } from "@blast/core/modules/launchpad-contract/v1.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The native holder snapshot of blast-infra's `/v1` (its docs/api.md
 * "GET /v1/coins/{coin_type}/holders", `view=snapshot`): a coin's holder
 * facts from native balances alone, never from trades, at one identified
 * checkpoint, with an explicit completeness state.
 *
 * - `complete`: every native balance change of the coin from its first
 *   appearance through `checkpoint`; `behind`: complete but older than the
 *   engine's committed market checkpoint, served and labelled stale. Both carry
 *   every fact.
 * - `incomplete`: some history is missing, so every fact is null. A parser
 *   that met a partial or zeroed incomplete body refuses it: it is never read
 *   as zero holders.
 * - A genuine zero is `complete` with `holder_count` 0 and no shares.
 *
 * Shares are `floor(amount × 10000 ÷ held_supply)`, null when nothing is held;
 * `held_supply` sums the holders' address balances (never `0x0`'s, never
 * object-held reserves). Rows run balance descending, then address ascending,
 * and carry no labels: a row with any other field, such as blast-infra's
 * `labels`, is refused. Page tokens are bound to the requested launch (scope
 * `coin_holders:<launch_id>`, no key, the tie-break the 20-digit balance and
 * the address). The rules mirror blast-infra `src/holders/` at `lst/T-027-1`.
 */

const ZERO_ADDRESS = `0x${"0".repeat(64)}`;
const TOKEN = /^[A-Za-z0-9_-]+$/;
const BALANCE_WIDTH = 20;
const PAGE_CEILING = 100;
const BPS = 10_000n;

/** A coin's holder snapshot page token, bound to its launch: the last row's balance and address. */
export function holdersCursor(launchId: string): CursorShape {
  return { scope: `coin_holders:${launchId}`, key: [], tie: 2 };
}

export const SNAPSHOT_STATES = ["complete", "incomplete", "behind"] as const;
export type SnapshotState = (typeof SNAPSHOT_STATES)[number];

/** Which native holder state an answer reflects, at its checkpoint. */
export type HolderSnapshotStamp = Readonly<{ state: SnapshotState; checkpoint: number; timestampMs: number }>;

/** A summed balance and its share of the held supply, in basis points; null when nothing is held. */
export type HolderConcentration = Readonly<{ amount: bigint; shareBps: bigint | null }>;

/** One holder: an address and its native balance. No labels. */
export type HolderRow = Readonly<{ address: string; balance: bigint; shareBps: bigint }>;

/** A complete or behind snapshot's facts: whole-coin aggregates and one page of holders. */
export type HolderFacts = Readonly<{
  holderCount: bigint;
  heldSupply: bigint;
  top1: HolderConcentration;
  top10: HolderConcentration;
  holders: readonly HolderRow[];
  nextCursor: string | null;
}>;

/** A holder snapshot page: `facts` is null exactly when the snapshot is incomplete. */
export type HoldersSnapshotPage = Readonly<{
  coin: string;
  snapshot: HolderSnapshotStamp;
  facts: HolderFacts | null;
}>;

const FACT_KEYS = ["holder_count", "held_supply", "top_1", "top_10", "holders", "next_cursor"] as const;
const BODY_KEYS = ["coin", "snapshot", ...FACT_KEYS];

const objectIdSchema = z.string().regex(SUI_OBJECT_ID_PATTERN);
const tokenSchema = z.string().regex(TOKEN);

function record(value: unknown, field: string): Record<string, unknown> {
  return contractValue(recordSchema, value, field, "must be an object");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string, optional: readonly string[] = []): void {
  contractObject(value, field, keys, optional);
}

function share(amount: bigint, heldSupply: bigint): bigint | null {
  return heldSupply === 0n ? null : (amount * BPS) / heldSupply;
}

function parseShare(value: unknown, field: string): bigint | null {
  return value === null ? null : parseAtomic(value, field);
}

function parseConcentration(value: unknown, heldSupply: bigint, field: string): HolderConcentration {
  const concentration = record(value, field);
  exactKeys(concentration, ["amount", "share_bps"], field);
  const amount = parseAtomic(concentration.amount, `${field}.amount`);
  if (amount > heldSupply) throw new ContractViolation(`${field}.amount`, "is at most held_supply");
  const shareBps = parseShare(concentration.share_bps, `${field}.share_bps`);
  if (shareBps !== share(amount, heldSupply)) {
    throw new ContractViolation(`${field}.share_bps`, "is floor(amount × 10000 ÷ held_supply), null when nothing is held");
  }
  return { amount, shareBps };
}

function parseRow(value: unknown, heldSupply: bigint, field: string): HolderRow {
  const row = record(value, field);
  exactKeys(row, ["address", "balance", "share_bps"], field);
  const address = row.address;
  if (!matchesSchema(objectIdSchema, address) || address === ZERO_ADDRESS) {
    throw new ContractViolation(`${field}.address`, "must be an address other than 0x0");
  }
  const balance = parseAtomic(row.balance, `${field}.balance`, 64);
  if (balance === 0n || balance > heldSupply) throw new ContractViolation(`${field}.balance`, "is above 0 and at most held_supply");
  const shareBps = parseAtomic(row.share_bps, `${field}.share_bps`);
  if (shareBps !== share(balance, heldSupply)) throw new ContractViolation(`${field}.share_bps`, "is floor(balance × 10000 ÷ held_supply)");
  return { address, balance, shareBps };
}

/** The cursor place of a row: its balance zero-padded to 20 digits, and its address. */
function place(row: HolderRow): string[] {
  return [row.balance.toString().padStart(BALANCE_WIDTH, "0"), row.address];
}

/** Balance descending, then address ascending; a strict order. */
function before(left: HolderRow, right: HolderRow): boolean {
  return left.balance > right.balance || (left.balance === right.balance && left.address < right.address);
}

function parseFacts(launchId: string, answer: Record<string, unknown>): HolderFacts {
  const holderCount = parseAtomic(answer.holder_count, "holder_count");
  const heldSupply = parseAtomic(answer.held_supply, "held_supply");
  const top1 = parseConcentration(answer.top_1, heldSupply, "top_1");
  const top10 = parseConcentration(answer.top_10, heldSupply, "top_10");
  if (top1.amount > top10.amount) throw new ContractViolation("top_10.amount", "is at least top_1's");
  if ((holderCount === 0n) !== (heldSupply === 0n) || (holderCount === 0n) !== (top1.amount === 0n)) {
    throw new ContractViolation("holder_count", "is 0 exactly when nothing is held");
  }
  if (holderCount <= 10n && top10.amount !== heldSupply) {
    throw new ContractViolation("top_10.amount", "is the whole held supply with ten holders or fewer");
  }
  const rows = answer.holders;
  if (!matchesSchema(listSchema.max(PAGE_CEILING), rows)) throw new ContractViolation("holders", `must be a list of at most ${PAGE_CEILING}`);
  const holders = rows.map((row, index) => parseRow(row, heldSupply, `holders[${index}]`));
  if (BigInt(holders.length) > holderCount) throw new ContractViolation("holders", "has at most holder_count rows");
  holders.slice(1).forEach((row, index) => {
    if (!before(holders[index], row)) throw new ContractViolation(`holders[${index + 1}]`, "is out of order");
  });
  const top = holders[0];
  if (top && top.balance > top1.amount) throw new ContractViolation("top_1.amount", "is the largest balance");
  const nextCursor = answer.next_cursor;
  if (nextCursor === null) return { holderCount, heldSupply, top1, top10, holders, nextCursor };
  if (!matchesSchema(tokenSchema, nextCursor)) throw new ContractViolation("next_cursor", "must be a page token");
  let after;
  try {
    after = decodeCursor(nextCursor, holdersCursor(launchId));
  } catch (error) {
    if (error instanceof CursorError) throw new ContractViolation("next_cursor", error.message);
    throw error;
  }
  const last = holders.at(-1);
  if (!last || after.tie.join() !== place(last).join()) throw new ContractViolation("next_cursor", "must be the page's last place");
  return { holderCount, heldSupply, top1, top10, holders, nextCursor };
}

/**
 * A validated holder snapshot page of `coinType`, requested through its launch
 * `launchId`: the coin must be the requested one, an incomplete snapshot has
 * no fact, and a complete or behind one has every fact, consistent shares, rows
 * in order and a next cursor at the last row, bound to the launch.
 */
export function parseHoldersSnapshotPage(launchId: string, coinType: string, body: unknown): HoldersSnapshotPage {
  const answer = record(body, "body");
  exactKeys(answer, BODY_KEYS, "body", ["provenance"]);
  if (answer.coin !== coinType) throw new ContractViolation("coin", "must be the requested coin");
  const stamp = record(answer.snapshot, "snapshot");
  exactKeys(stamp, ["state", "checkpoint", "timestamp_ms"], "snapshot");
  const state = stamp.state as SnapshotState;
  if (!matchesSchema(z.enum(SNAPSHOT_STATES), state)) throw new ContractViolation("snapshot.state", "is unknown");
  const snapshot = {
    state,
    checkpoint: parseCount(stamp.checkpoint, "snapshot.checkpoint"),
    timestampMs: parseCount(stamp.timestamp_ms, "snapshot.timestamp_ms"),
  };
  if (state === "incomplete") {
    const partial = FACT_KEYS.find((key) => answer[key] !== null);
    if (partial) throw new ContractViolation(partial, "is null on an incomplete snapshot: never a partial or zero fact");
    return { coin: coinType, snapshot, facts: null };
  }
  return { coin: coinType, snapshot, facts: parseFacts(launchId, answer) };
}

/**
 * The holder snapshot page's path for `coinType` on launch `launchId`; a bad
 * limit or a cursor of another list (another launch's included) is a CursorError.
 */
export function holdersSnapshotPath(
  coinType: string,
  launchId: string,
  request: LaunchPageRequest,
  bounds: Readonly<{ default: number; max: number }> = LAUNCH_PAGE,
): string {
  if (!matchesSchema(z.string().regex(COIN_TYPE), coinType)) throw new CursorError("coin_type must be a canonical coin type");
  if (!matchesSchema(z.string().regex(SUI_OBJECT_ID_PATTERN), launchId)) throw new CursorError("launch_id must be a canonical object id");
  let limit = bounds.default;
  if (request.limit !== undefined && request.limit !== null) {
    limit = matchesSchema(z.string().regex(/^[0-9]{1,15}$/), request.limit) ? Number(request.limit) : 0;
    if (limit < 1 || limit > bounds.max) throw new CursorError(`limit must be a whole number from 1 to ${bounds.max}`);
  }
  const params = new URLSearchParams({ view: "snapshot", limit: String(limit) });
  if (request.cursor !== undefined && request.cursor !== null) {
    decodeCursor(request.cursor, holdersCursor(launchId));
    params.set("cursor", request.cursor);
  }
  return `/v1/coins/${coinType}/holders?${params.toString()}`;
}

/** Reads one holder snapshot page from blast-infra, validated, with its provenance. */
export function readHoldersSnapshot(
  coinType: string,
  launchId: string,
  request: LaunchPageRequest,
  dependencies: MarketDataDependencies,
  bounds?: Readonly<{ default: number; max: number }>,
): Promise<RoutedRead<V1Answer<HoldersSnapshotPage>>> {
  return readV1(
    "market",
    holdersSnapshotPath(coinType, launchId, request, bounds),
    (body) => parseHoldersSnapshotPage(launchId, coinType, body),
    dependencies,
  );
}
