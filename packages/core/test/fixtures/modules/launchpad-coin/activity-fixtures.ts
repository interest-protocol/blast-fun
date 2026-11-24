// The coin fixture's launch activity as blast-infra serves it, for tests and
// the dev fixture server only: the classified launch activity
// (`GET /v1/launches/{launch_id}/activity?view=classified`, schema
// activity_classified) and the Bluefin pool's trades
// (`GET /v1/pools/bluefin/{pool_id}/trades`, schema trades). Every activity
// kind is here: the creator's pre-share buy,
// opening-round joins, the settlement (its pot's curve buy, the lifecycle
// change it causes and the round's close), deliveries, user buys and sells,
// the graduating buy, the migration's allocation, the migration, the curve's
// creator and protocol claims, and (LP-07) the venue swaps blast-infra merges
// into the same list after migration. Several rows share a
// checkpoint (equal time), one group straddling a live launch's first page
// of 25; the settlement and lifecycle rows name no actor. One swap carries a
// `whale` label supplied on requests for wallet labels.

import { toBase58 } from "@mysten/sui/utils";

import { activityCursor } from "../../../../src/modules/launchpad-contract/activity.ts";
import { decodeCursor, encodeCursor } from "../../../../src/modules/launchpad-contract/cursor.ts";
import type { LaunchLifecycle } from "../../../../src/modules/launchpad-contract/discovery.ts";
import { COIN_FIXTURE, VENUE_POOL_KEY, wireProvenance } from "./fixtures.ts";

const BIDDER_A = `0x${"a7".repeat(32)}`;
const BIDDER_B = `0x${"b8".repeat(32)}`;
const TRADER = (index: number) => `0x${(0x30 + index).toString(16).repeat(32)}`;

/** A transaction digest that is valid base58 of 32 bytes, unique per checkpoint and slot. */
export function fixtureDigest(checkpoint: number, tx: number): string {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setBigUint64(1, BigInt(checkpoint));
  bytes[9] = tx;
  bytes[0] = 0x5a;
  bytes[31] = 7;
  return toBase58(bytes);
}

/** A checkpoint's timestamp: the creation checkpoint's plus 100 ms a checkpoint. */
function timestampOf(checkpoint: number): number {
  return 1_790_200_000_000 + (checkpoint - 325_874_009) * 100;
}

type Row = Readonly<{
  position: string;
  kind: string;
  source: string | null;
  actor: string | null;
  lifecycle: string | null;
  amounts: Readonly<Record<string, string>>;
}>;

function row(position: string, kind: string, fields: Partial<Row> = {}): Row {
  return { position, kind, source: null, actor: null, lifecycle: null, amounts: {}, ...fields };
}

const trade = (position: string, kind: "curve_buy" | "curve_sell", actor: string, quote: string, meme: string) =>
  row(position, kind, { source: "user", actor, amounts: { quote, meme } });

/** Settlement: past the round's end (public start 1790200000000 + 1 h). */
const SETTLEMENT_CHECKPOINT = 325_910_100;
/** The graduating buy. */
const GRADUATION_CHECKPOINT = 326_050_000;
/** `Migrated` (the coin fixture's migration cursor). */
const MIGRATION_CHECKPOINT = 326_100_000;
/** The equal-time group the first page of 25 ends inside. */
export const TIE_CHECKPOINT = 325_990_000;

const VENUE_TRADERS = [TRADER(2), TRADER(7), TRADER(8)];
const VENUE_INPUTS = {
  virtual_quote: null,
  meme_reserve: null,
  quote_reserve: null,
  graduation_target: null,
  sqrt_price_x64: "147573952589676412928",
  meme_is_coin_a: false,
  currency_supply: "999998000000000",
  pending_burn_total: "0",
  balance_0x0: "0",
  meme_decimals: "6",
  quote_decimals: "9",
};

/** The newest venue swap's checkpoint: the newest row of a migrated launch. */
const VENUE_LAST_CHECKPOINT = 326_274_000;

/** The Bluefin pool's swaps, newest first; the newest is the venue summary's last trade. */
const VENUE_TRADES = Array.from({ length: 8 }, (_, index) => {
  const checkpoint = index === 0 ? VENUE_LAST_CHECKPOINT : VENUE_LAST_CHECKPOINT - index * 20_000;
  const tx = index === 0 ? 1 : 0;
  const buy = index % 3 !== 1;
  const quote = String(1_000_000_000 + index * 100_000_000);
  const meme = String(64_000_000_000 + index * 6_400_000_000);
  const fee = String(3_000_000 + index * 300_000);
  return {
    cursor: `${checkpoint}:${tx}:1:0`,
    checkpoint,
    timestamp_ms: timestampOf(checkpoint),
    digest: fixtureDigest(checkpoint, tx),
    pool_key: VENUE_POOL_KEY,
    venue: "bluefin",
    coin: COIN_FIXTURE.coinType,
    quote: COIN_FIXTURE.quoteType,
    trader: VENUE_TRADERS[index % 3],
    side: buy ? "buy" : "sell",
    kind: "swap",
    quote_amount: quote,
    meme_amount: meme,
    meme_fee: buy ? "0" : fee,
    quote_fee: buy ? fee : "0",
    curve: null,
    opening_round: null,
    venue_swap: {
      amount_in: buy ? String(BigInt(quote) + BigInt(fee)) : String(BigInt(meme) + BigInt(fee)),
      amount_out: buy ? meme : quote,
      ref_amount: null,
      before_sqrt_price: "147573952589676412928",
      after_sqrt_price: "147573952589676412928",
      a_to_b: buy,
    },
    price: "0.015625",
    market_cap: "15624968750000",
    inputs: VENUE_INPUTS,
    usd: { price: "345210000", expo: -8, publish_time: Math.floor(timestampOf(checkpoint) / 1000), age_ms: 1218 },
    volume_usd: "3.4521",
    labels: index === 0 ? ["whale"] : [],
  };
});

/** Where the curve's protocol claim and the migration's allocation pay. */
export const FIXTURE_TREASURY = `0x${"7e".repeat(32)}`;
export const FIXTURE_ALLOCATION_DESTINATION = `0x${"d1".repeat(32)}`;
/** The curve's claims, after migration, between the venue swaps. */
const CLAIM_CHECKPOINT = 326_150_000;

/** Oldest first. */
const CURVE_ROWS: readonly Row[] = [
  row("325874009:1:2:1", "lifecycle", { lifecycle: "opening_round" }),
  row("325874009:1:3:0", "curve_buy", {
    source: "creator_pre_share",
    actor: COIN_FIXTURE.creator,
    amounts: { quote: "1000000000", meme: "393700787401" },
  }),
  row("325880000:0:1:0", "opening_join", { actor: BIDDER_A, amounts: { quote: "1500000000", bids: "1500000000" } }),
  row("325890000:0:0:0", "opening_join", { actor: BIDDER_B, amounts: { quote: "1000000000", bids: "2500000000" } }),
  row(`${SETTLEMENT_CHECKPOINT}:0:1:0`, "opening_settlement", {
    source: "opening_round_settlement",
    amounts: { quote: "2500000000", meme: "830000000000" },
  }),
  row(`${SETTLEMENT_CHECKPOINT}:0:1:1`, "lifecycle", { lifecycle: "live" }),
  row(`${SETTLEMENT_CHECKPOINT}:0:2:0`, "opening_settlement", {
    source: "opening_round_settlement",
    amounts: { bids: "2500000000", meme: "830000000000", refund_quote: "0" },
  }),
  row("325910200:0:0:0", "opening_delivery", { actor: BIDDER_A, amounts: { bid: "1500000000", meme: "498000000000", refund_quote: "0" } }),
  row("325910200:1:0:0", "opening_delivery", { actor: BIDDER_B, amounts: { bid: "1000000000", meme: "332000000000", refund_quote: "0" } }),
  ...Array.from({ length: 16 }, (_, index) =>
    trade(
      `${325_920_000 + index * 1_000}:0:0:0`,
      index % 4 === 3 ? "curve_sell" : "curve_buy",
      TRADER(index % 5),
      String(200_000_000 + index * 10_000_000),
      String(78_000_000_000 + index * 1_000_000_000),
    ),
  ),
  // Four trades in one checkpoint: equal time, ordered by transaction.
  ...[0, 1, 2, 3].map((tx) => trade(`${TIE_CHECKPOINT}:${tx}:0:0`, tx === 2 ? "curve_sell" : "curve_buy", TRADER(tx), "300000000", "117000000000")),
  ...Array.from({ length: 23 }, (_, index) =>
    trade(`${326_000_000 + index * 900}:0:0:0`, index % 3 === 2 ? "curve_sell" : "curve_buy", TRADER(index % 6), "250000000", "98000000000"),
  ),
  trade(`${GRADUATION_CHECKPOINT}:0:0:0`, "curve_buy", TRADER(1), "2737000000000", "296000000000000"),
  row(`${GRADUATION_CHECKPOINT}:0:0:1`, "lifecycle", { lifecycle: "migration_ready" }),
  row(`${MIGRATION_CHECKPOINT}:2:3:0`, "migration_allocation", {
    source: FIXTURE_ALLOCATION_DESTINATION,
    amounts: { meme: "8000000000000", quote: "0" },
  }),
  row(`${MIGRATION_CHECKPOINT}:2:5:0`, "migration", {
    amounts: { meme: "190000000000000", quote: "2940000000000", disposed_meme: "2000000000", total_supply_after: "999998000000000" },
  }),
  row(`${MIGRATION_CHECKPOINT}:2:5:1`, "lifecycle", { lifecycle: "migrated" }),
  row(`${CLAIM_CHECKPOINT}:0:1:0`, "creator_fees_claimed", {
    actor: COIN_FIXTURE.creator,
    amounts: { meme: "4200000000", quote: "61000000" },
  }),
  row(`${CLAIM_CHECKPOINT}:1:1:0`, "protocol_fees_paid", {
    source: FIXTURE_TREASURY,
    amounts: { meme: "3600000000", quote: "52000000", sui: "1800000000", partner_meme: "0", partner_quote: "0", partner_sui: "0" },
  }),
];

/** The venue pool's swaps as the classified activity merges them: the same trades, by position. */
const VENUE_ROWS: readonly Row[] = VENUE_TRADES.map((trade) =>
  row(trade.cursor, trade.side === "buy" ? "venue_buy" : "venue_sell", {
    source: VENUE_POOL_KEY,
    actor: trade.trader ?? null,
    amounts: { quote: trade.quote_amount, meme: trade.meme_amount },
  }),
);

const tuple = (position: string) => position.split(":").map(BigInt);
function older(left: string, right: readonly bigint[]): boolean {
  const a = tuple(left);
  for (let index = 0; index < 4; index += 1) if (a[index] !== right[index]) return a[index]! < right[index]!;
  return false;
}

/** Every row, oldest first by position. */
const ROWS: readonly Row[] = [...CURVE_ROWS, ...VENUE_ROWS].sort((left, right) =>
  older(left.position, tuple(right.position)) ? -1 : older(right.position, tuple(left.position)) ? 1 : 0,
);

/** The newest row a launch at `lifecycle` has indexed. */
const LAST_CHECKPOINT: Readonly<Record<LaunchLifecycle, number>> = {
  opening_round: 325_890_000,
  live: TIE_CHECKPOINT + 30_000,
  migration_ready: GRADUATION_CHECKPOINT,
  migrated: VENUE_LAST_CHECKPOINT,
};

/** The fixture launch's classified activity at `lifecycle`, newest first. */
export function fixtureActivity(lifecycle: LaunchLifecycle): readonly Row[] {
  return ROWS.filter((item) => Number(item.position.split(":")[0]) <= LAST_CHECKPOINT[lifecycle]).reverse();
}

const pad = (part: string) => part.padStart(20, "0");

/** One classified activity page after `cursor`, `limit` rows. Throws on a cursor of another list. */
export function classifiedActivityBody(
  lifecycle: LaunchLifecycle,
  request: Readonly<{ cursor?: string | null; limit?: number; walletLabels?: boolean }>,
  now: number,
  lagMs?: number,
): Record<string, unknown> {
  const shape = activityCursor(COIN_FIXTURE.launchId);
  const after = request.cursor ? decodeCursor(request.cursor, shape).tie.map(BigInt) : null;
  const rows = fixtureActivity(lifecycle).filter((item) => after === null || older(item.position, after));
  const page = rows.slice(0, request.limit ?? 25);
  const last = page.at(-1);
  const next = last && rows.length > page.length ? encodeCursor(shape, [], last.position.split(":").map(pad)) : null;
  return {
    provenance: wireProvenance(now, lagMs),
    activity: page.map((item) => {
      const checkpoint = Number(item.position.split(":")[0]);
      const tx = Number(item.position.split(":")[1]);
      const labels = request.walletLabels ? { labels: VENUE_TRADES.find((trade) => trade.cursor === item.position)?.labels ?? [] } : {};
      return { ...item, ...labels, checkpoint, timestamp_ms: timestampOf(checkpoint), digest: fixtureDigest(checkpoint, tx) };
    }),
    next_cursor: next,
  };
}

/** One page of the Bluefin pool's trades strictly before `before`, `limit` rows. */
export function venueTradesBody(
  request: Readonly<{ before?: string | null; limit?: number }>,
  now: number,
  lagMs?: number,
): Record<string, unknown> {
  const before = request.before ? request.before.split(":").map(BigInt) : null;
  const trades = VENUE_TRADES.filter((item) => before === null || older(item.cursor, before)).slice(0, request.limit ?? 50);
  return { provenance: wireProvenance(now, lagMs), trades };
}
