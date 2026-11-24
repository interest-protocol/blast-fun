import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { seedChainRead, type ChainPresaleRow, type ChainPriceHistoryRow } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { advanceWatermark, urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { PRICE_TIER_SPAN_MS, type PricePoint, type SocialPriceHistory, type SocialPricesResponse } from "@blast/core/modules/social/contracts/prices.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { v1Prices } from "@blast/server/modules/partner-api/v1/presales.ts";
import { PRICE_FIGURES_SQL, PRICE_SERIES_SQL } from "@blast/server/modules/social/prices/history.ts";
import { createSocialPricesRoute } from "@blast/server/modules/social/prices/route.ts";
import { hex } from "../../../../../core/test/kit.ts";

/**
 * R3-20's web consumer over a disposable database with the fixture
 * `chain_read_v1` (`price_history` mirrors blast-infra's view):
 * `GET /api/social/prices` as `blast_replica`, public and cached, every
 * window ending at the chain clock.
 *
 * The clock is pinned to yesterday 13:07:30 UTC, so the instants the read
 * looks up are fixed: T (24 h before, 13:07:30 the day before) and D (the day
 * open, yesterday 00:00 UTC). Buckets hold the last price in them and that
 * price's own time, as blast-infra writes them.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-prices-app";
const PEPPER = "social-prices-fixture-pepper-0123456789abcdef";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 8, statementTimeoutMs: 10_000 };
const PUBLIC = "public, s-maxage=10, stale-while-revalidate=20";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const M5 = PRICE_TIER_SPAN_MS["5m"];

const USDC = `${hex("dba3")}::usdc::USDC`;
const SUI = `${hex("2")}::sui::SUI`;
const DEEP = `${hex("dee9")}::deep::DEEP`;
const NONE = `${hex("404")}::none::NONE`;
const OLD = `${hex("01d")}::old::OLD`;
const P = {
  trading: hex("d0"), // launched 50 h before the clock: hourly buckets only
  young: hex("d1"), // launched 3 h before the clock: 5m buckets
  bare: hex("d2"), // trading, priced, no history at all
  unpriced: hex("d3"), // trading, no price, no history
  pending: hex("b0"),
  hidden: hex("e1"), // its coin's metadata has not arrived: not shown
} as const;
const coinOf = (id: string, symbol: string) => `${id}::coin::${symbol}`;

const BASE = Math.floor(Date.now() / DAY) * DAY - 2 * DAY; // two days ago, 00:00 UTC
const CLOCK = BASE + DAY + 13 * HOUR + 7 * MINUTE + 30_000; // yesterday 13:07:30
const T = CLOCK - DAY; // the day before, 13:07:30
const D = BASE + DAY; // yesterday 00:00 UTC

function presale(id: string, symbol: string, lifecycle: ChainPresaleRow["lifecycle"], row: Partial<ChainPresaleRow> = {}): ChainPresaleRow {
  return {
    presale_id: id, sale_token: coinOf(id, symbol), quote_type: USDC, sale_symbol: symbol, sale_name: `Sale ${symbol}`,
    sale_icon_url: `https://cdn.blast.fun/${symbol}.png`, sale_decimals: 9, quote_symbol: "USDC", quote_decimals: 6, lifecycle,
    start_ms: BASE - 9 * DAY, end_ms: BASE - 6 * DAY, raise_target: "100000000000", min_commitment: "10000000", wallet_cap: null,
    total_commitments: "0", participants: 0, venue: "cetus", pool_id: null, updated_checkpoint: 1, ...row,
  };
}

const bucket = (coin_type: string, resolution: ChainPriceHistoryRow["resolution"], bucket_ms: number, usd_price: string, asOfOffset: number): ChainPriceHistoryRow => ({
  coin_type, resolution, bucket_ms, usd_price, as_of_ms: bucket_ms + asOfOffset, source: coin_type === SUI || coin_type === USDC ? "pyth" : "pool",
});

/**
 * SUI's 5m buckets after the one holding T, to the one holding the clock: a
 * price a minute into each, except the clock's own (published 10 s after the
 * clock) and the two around the day open, seeded on their own below.
 */
const SUI_AFTER_T = Array.from({ length: (Math.floor(CLOCK / M5) - Math.floor(T / M5)) }, (_, n) => (Math.floor(T / M5) + n + 1) * M5)
  .filter((start) => start !== D - M5 && start !== D)
  .map((start, n) => bucket(SUI, "5m", start, (3.4 + (n % 7) * 0.01).toFixed(2), start === Math.floor(CLOCK / M5) * M5 ? CLOCK - start + 10_000 : MINUTE));

const TRADING_LAUNCH = CLOCK - 50 * HOUR;
/** The trading sale's hourly buckets from the one holding its launch to the last full hour: 0.0010, 0.0011, … */
const TRADING_HOURS = Array.from({ length: 50 }, (_, n) => Math.floor(TRADING_LAUNCH / HOUR) * HOUR + n * HOUR)
  .map((start, n) => bucket(coinOf(P.trading, "TRD"), "1h", start, (0.001 + n * 0.0001).toFixed(4), start === Math.floor(TRADING_LAUNCH / HOUR) * HOUR ? TRADING_LAUNCH - start + 1_000 : 10 * MINUTE));

const YOUNG_LAUNCH = CLOCK - 3 * HOUR;
const YOUNG_5M = Array.from({ length: 36 }, (_, n) => Math.floor(YOUNG_LAUNCH / M5) * M5 + n * M5)
  .map((start, n) => bucket(coinOf(P.young, "YNG"), "5m", start, (0.5 + n * 0.01).toFixed(2), start === Math.floor(YOUNG_LAUNCH / M5) * M5 ? YOUNG_LAUNCH - start + 1_000 : MINUTE))
  .filter((row) => row.as_of_ms <= CLOCK);

const HISTORY: readonly ChainPriceHistoryRow[] = [
  // SUI. Out of the 5m tier's hour before T: never the 24 h price, though it is the newest 5m bucket older than the hour.
  bucket(SUI, "5m", Math.floor(T / M5) * M5 - 2 * HOUR, "9.99", MINUTE),
  // The bucket holding T was published after T (13:07:50): not the price at T.
  bucket(SUI, "5m", Math.floor(T / M5) * M5, "8.88", 2 * MINUTE + 50_000),
  // The newest bucket published at or before T: the 24 h price.
  bucket(SUI, "5m", Math.floor(T / M5) * M5 - M5, "3.5", 4 * MINUTE + 10_000),
  ...SUI_AFTER_T,
  // The day open: 23:55's bucket (published 23:58); 00:00's was published after the open.
  bucket(SUI, "5m", D - M5, "3.47", 3 * MINUTE),
  bucket(SUI, "5m", D, "3.61", 2 * MINUTE),
  // Coarser tiers of the same coin are never mixed into a 24 h series.
  bucket(SUI, "1h", Math.floor(T / HOUR) * HOUR, "7.77", 5 * MINUTE),
  bucket(SUI, "1d", BASE, "6.66", HOUR),
  ...TRADING_HOURS,
  ...YOUNG_5M,
  // DEEP: one 5m price 50 minutes before T and nothing since: inside the hour the price at T looks back.
  bucket(DEEP, "5m", Math.floor((T - 50 * MINUTE) / M5) * M5, "0.0412", MINUTE),
  // OLD: one 5m price 70 minutes before T: outside it, so no price at T.
  bucket(OLD, "5m", Math.floor((T - 70 * MINUTE) / M5) * M5, "0.5", MINUTE),
];

/** SUI's 5m prices published after `after` and by the clock, oldest first. */
const suiAfter = (after: number) =>
  HISTORY.filter((row) => row.coin_type === SUI && row.resolution === "5m" && row.as_of_ms > after && row.as_of_ms <= CLOCK)
    .sort((a, b) => a.bucket_ms - b.bucket_ms);

type Fixture = Readonly<{ admin: Pool; replica: Pool; get(query: string): Promise<Response> }>;

async function withFixture(run: (fixture: Fixture) => Promise<void>, history: readonly ChainPriceHistoryRow[] = HISTORY): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  await seedChainRead(admin, {
    presales: [
      presale(P.trading, "TRD", "migrated"),
      presale(P.young, "YNG", "migrated"),
      presale(P.bare, "BAR", "migrated"),
      presale(P.unpriced, "UNP", "migrated"),
      presale(P.pending, "PND", "pending", { start_ms: CLOCK + DAY, end_ms: CLOCK + 3 * DAY }),
      presale(P.hidden, "HID", "migrated", { sale_symbol: null, sale_name: null, sale_icon_url: null, sale_decimals: null }),
    ],
    presale_lifecycle: [
      { presale_id: P.trading, state: "migrated", digest: "LcTrd".padEnd(44, "2"), timestamp_ms: TRADING_LAUNCH, checkpoint: 40_001 },
      { presale_id: P.young, state: "migrated", digest: "LcYng".padEnd(44, "2"), timestamp_ms: YOUNG_LAUNCH, checkpoint: 40_002 },
      { presale_id: P.bare, state: "migrated", digest: "LcBar".padEnd(44, "2"), timestamp_ms: CLOCK - 5 * DAY, checkpoint: 40_003 },
      { presale_id: P.hidden, state: "migrated", digest: "LcHid".padEnd(44, "2"), timestamp_ms: CLOCK - 5 * DAY, checkpoint: 40_004 },
    ],
    prices: [
      { coin_type: SUI, usd_price: "3.43627", as_of_ms: CLOCK - 5_000, source: "pyth" },
      { coin_type: USDC, usd_price: "1", as_of_ms: CLOCK - 5_000, source: "pyth" },
      { coin_type: DEEP, usd_price: "0.0412", as_of_ms: T - 49 * MINUTE, source: "pool" },
      { coin_type: OLD, usd_price: "0.5", as_of_ms: T - 69 * MINUTE, source: "pool" },
      { coin_type: coinOf(P.trading, "TRD"), usd_price: "0.0021", as_of_ms: CLOCK - MINUTE, source: "pool" },
      { coin_type: coinOf(P.young, "YNG"), usd_price: "0.88", as_of_ms: CLOCK - MINUTE, source: "pool" },
      { coin_type: coinOf(P.bare, "BAR"), usd_price: "0.25", as_of_ms: CLOCK - MINUTE, source: "pool" },
      { coin_type: coinOf(P.hidden, "HID"), usd_price: "9", as_of_ms: CLOCK - MINUTE, source: "pool" },
    ],
    price_history: history,
  });
  await admin.query(advanceWatermark(50_000, -MINUTE, "presale"));
  await admin.query(advanceWatermark(50_000, -MINUTE, "market"));
  const replicaPool = createRuntimePool(urlAs(url, "blast_replica"), POOL, "social-prices-replica");
  const webPool = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-prices-web");
  try {
    assert.equal((await replicaPool.query("SELECT current_user AS role")).rows[0]?.role, "blast_replica");
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString() }),
      limiter: new PostgresRateLimitEnforcer({ pool: webPool, subjectPepper: PEPPER }),
      accounts: new PostgresSocialAccounts(() => webPool),
      primary: () => webPool,
    });
    const route = createSocialPricesRoute({ kit, database: () => autocommitReader(replicaPool, "social"), now: () => CLOCK });
    await run({
      admin,
      replica: replicaPool,
      get: (query) => route.GET(new Request(`${ORIGIN}/api/social/prices?${query}`, { headers: { "x-forwarded-for": "203.0.113.9" } }), testClient("203.0.113.9")),
    });
  } finally {
    await Promise.all([admin.end(), replicaPool.end(), webPool.end()]);
    await database.drop();
  }
}

async function pricesOf(response: Response): Promise<SocialPricesResponse> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("prices-response", v1Prices(body)).errors, []);
  assert.equal(response.headers.get("cache-control"), PUBLIC);
  return body as SocialPricesResponse;
}

const entry = (body: SocialPricesResponse, key: string): SocialPriceHistory => {
  const found = body.prices.find((price) => price.presale_id === key || (price.presale_id === null && price.coin_type === key));
  assert.ok(found, `no entry for ${key}`);
  return found;
};

test("pool quote history is genuine, separate from USD, and readable by the replica role", { skip }, () => withFixture(async ({ admin, get }) => {
  const quote = `${hex("9633")}::test_sui::TEST_SUI`;
  const at = CLOCK - 60_000;
  await admin.query(`INSERT INTO blast_infra_fixture.presale_pool_prices VALUES ($1,$2,$3,'TSUI',0.000088098231292,$4)`, [P.unpriced, coinOf(P.unpriced, "UNP"), quote, at]);
  await admin.query(`INSERT INTO blast_infra_fixture.presale_pool_price_history VALUES
    ($1,'5m',$2,0.000000163333333,$3), ($1,'5m',$4,0.000088098231292,$5)`,
  [P.unpriced, Math.floor((CLOCK - HOUR) / M5) * M5, CLOCK - HOUR, Math.floor(at / M5) * M5, at]);
  const price = entry(await pricesOf(await get(`presale=${P.unpriced}`)), P.unpriced);
  assert.equal(price.price_usd, null);
  assert.deepEqual(price.points, []);
  assert.equal(price.quote!.symbol, "TSUI");
  assert.equal(price.quote!.coin_type, quote);
  assert.equal(price.quote!.price, "0.000088098231292");
  assert.deepEqual(price.quote!.points, [[CLOCK - HOUR, "0.000000163333333"], [at, "0.000088098231292"]]);
  assert.equal(price.quote!.change_24h_bps, null);
}));

test("R3-20 web read: SUI's last 24 h, its exact move and the day's open", { skip }, () => withFixture(async ({ get }) => {
  const body = await pricesOf(await get(`coin=${encodeURIComponent(SUI)}&points=288`));
  assert.equal(body.window, "24h");
  assert.equal(body.clock_ms, CLOCK);
  const sui = entry(body, SUI);
  assert.equal(sui.tier, "5m");
  assert.equal(sui.from_ms, T);
  assert.equal(sui.price_usd, "3.43627");
  assert.equal(sui.price_as_of_ms, CLOCK - 5_000);
  // The newest price published by T: 13:00's bucket (13:04:10), not 13:05's (13:07:50, after T) nor the 9.99 two hours before.
  assert.equal(sui.price_24h_usd, "3.5");
  // (3.43627 / 3.5 − 1) × 10000 = −182.08… → −182: the card's −1.82%.
  assert.equal(sui.change_24h_bps, -182);
  assert.equal(sui.day_open_usd, "3.47");
  assert.equal(sui.day_open_ms, D - M5);
  // The line: the price at T, every 5m price published after T and by the clock (oldest first), the price now.
  const published = suiAfter(T);
  const clockBucket = Math.floor(CLOCK / M5) * M5;
  assert.ok(HISTORY.some((row) => row.coin_type === SUI && row.bucket_ms === clockBucket), "seeded");
  assert.ok(!published.some((row) => row.bucket_ms === clockBucket), "the bucket holding the clock was published after it");
  assert.equal(published[0]!.usd_price, "8.88", "13:05's price (13:07:50) is the first after T");
  assert.deepEqual(sui.points, [
    [T, "3.5"],
    ...published.map((row): PricePoint => [row.as_of_ms, String(Number(row.usd_price))]),
    [CLOCK, "3.43627"],
  ]);
  // Never a coarser tier's price, nor one from before the window.
  for (const [, usd] of sui.points) assert.ok(!["9.99", "7.77", "6.66"].includes(usd), usd);
}));

test("R3-20 web read: thinned to the points a chart draws, evenly spaced on the epoch-aligned buckets", { skip }, () => withFixture(async ({ get }) => {
  const full = entry(await pricesOf(await get(`coin=${encodeURIComponent(SUI)}&points=288`)), SUI);
  const thin = entry(await pricesOf(await get(`coin=${encodeURIComponent(SUI)}&points=10`)), SUI);
  const step = 29 * M5; // ceil(288 / 10) five-minute buckets
  // Evenly spaced buckets, and the one holding T (13:05, published after it).
  const kept = suiAfter(T).filter((row) => row.bucket_ms % step === 0 || row.bucket_ms <= T);
  assert.deepEqual(thin.points, [[T, "3.5"], ...kept.map((row): PricePoint => [row.as_of_ms, String(Number(row.usd_price))]), [CLOCK, "3.43627"]]);
  // At most the 10 points asked for, plus the window's two ends and the bucket holding its start.
  assert.ok(thin.points.length <= 13 && full.points.length > 3 * thin.points.length, `${thin.points.length} of ${full.points.length}`);
  // The figures do not depend on the thinning.
  assert.deepEqual([thin.change_24h_bps, thin.day_open_usd], [full.change_24h_bps, full.day_open_usd]);
}));

test("R3-20 web read: a sale since launch on the tier its age needs; the 24 h figures from the 5m tier's hour before", { skip }, () => withFixture(async ({ get }) => {
  const launch = await pricesOf(await get(`presale=${P.trading}&presale=${P.young}&window=launch`));
  assert.equal(launch.window, "launch");
  assert.deepEqual(launch.prices.map((price) => price.presale_id), [P.trading, P.young], "in the order asked");
  const trading = entry(launch, P.trading);
  // 50 hours old: the 1h tier, every bucket (50 of them fit in 60 points), from the one holding the launch.
  assert.equal(trading.tier, "1h");
  assert.equal(trading.from_ms, TRADING_LAUNCH);
  assert.deepEqual(trading.points, [
    ...TRADING_HOURS.map((row): PricePoint => [row.as_of_ms, String(Number(row.usd_price))]),
    [CLOCK, "0.0021"],
  ]);
  assert.equal(trading.points[0]![0], TRADING_LAUNCH + 1_000, "the first trade after the launch");
  // No 5m price in the hour before T or D (blast-infra's dense series always has one unless the chain stalled):
  // no 24 h price, no move and no day open — never a coarser tier's guess.
  assert.deepEqual([trading.price_24h_usd, trading.change_24h_bps, trading.day_open_usd, trading.day_open_ms], [null, null, null, null]);
  const young = entry(launch, P.young);
  assert.equal(young.tier, "5m");
  assert.deepEqual(young.points[0], [YOUNG_LAUNCH + 1_000, "0.5"]);
  assert.equal(young.price_24h_usd, null, "younger than a day: no 24 h price");
  assert.equal(young.change_24h_bps, null, "and no move, never a 0");
  assert.equal(young.day_open_usd, null);

  // The price at T is the newest 5m price published by T within the hour before it: 50 minutes back is it…
  const quiet = await pricesOf(await get(`coin=${encodeURIComponent(DEEP)}&coin=${encodeURIComponent(OLD)}`));
  const deep = entry(quiet, DEEP);
  assert.deepEqual([deep.price_24h_usd, deep.change_24h_bps, deep.day_open_usd], ["0.0412", 0, null]);
  assert.deepEqual(deep.points, [[T, "0.0412"], [CLOCK, "0.0412"]]);
  // …70 minutes back is past the bound: no price that old, no move rather than a guess.
  const old = entry(quiet, OLD);
  assert.deepEqual([old.price_usd, old.price_24h_usd, old.change_24h_bps, old.day_open_usd], ["0.5", null, null, null]);
}));

test("R3-20 web read: empty states — no entry without a price, no line without a history, nothing for a sale that does not trade or is not shown", { skip }, () => withFixture(async ({ get }) => {
  const body = await pricesOf(await get(
    [P.trading, P.bare, P.unpriced, P.pending, P.hidden].map((id) => `presale=${id}`).join("&") + `&coin=${encodeURIComponent(NONE)}&coin=${encodeURIComponent(USDC)}`,
  ));
  assert.deepEqual(body.prices.map((price) => price.presale_id ?? price.coin_type), [P.trading, P.bare, USDC]);
  const bare = entry(body, P.bare);
  assert.deepEqual(bare.points, [], "a single price is no line");
  assert.deepEqual([bare.price_usd, bare.price_24h_usd, bare.change_24h_bps, bare.day_open_usd, bare.day_open_ms], ["0.25", null, null, null, null]);
  const usdc = entry(body, USDC);
  assert.deepEqual([usdc.price_usd, usdc.points, usdc.change_24h_bps], ["1", [], null]);
  // Nothing at all asked for exists: an empty answer, still a 200.
  assert.deepEqual((await pricesOf(await get(`presale=${P.pending}&coin=${encodeURIComponent(NONE)}`))).prices, []);
  // A malformed ask is refused, uncached.
  const refused = await get("window=launch");
  assert.equal(refused.status, 400);
  assert.equal(refused.headers.get("cache-control"), "no-store");
  assert.equal(((await refused.json()) as { error: { parameter: string } }).error.parameter, "presale");
}, []));

test("R3-20 web read: every statement is an index range on the view's key", { skip }, () => withFixture(async ({ replica }) => {
  const client = await replica.connect();
  try {
    // The fixture is small, so the planner would scan it whole; at launch scale the key is the only path
    // (loadtest/social-prices-scale.ts measures blast-infra's own view there).
    await client.query("SET enable_seqscan = off");
    const plans = [
      [PRICE_FIGURES_SQL, [[SUI, DEEP], T, D]],
      [PRICE_SERIES_SQL, [[SUI], ["5m"], [T - M5], [CLOCK], [M5], [T], [T]]],
    ] as const;
    for (const [text, values] of plans) {
      const plan = (await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${text}`, [...values])).rows.map((row) => row["QUERY PLAN"]).join("\n");
      assert.match(plan, /Index (Only )?Scan( Backward)? using price_history_pkey on price_history/);
      assert.doesNotMatch(plan, /Seq Scan on price_history/);
    }
  } finally {
    client.release();
  }
}));
