import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import {
  assertReadOnlyStatement,
  type ReadableDatabase,
} from "@blast/core/modules/database/transaction.ts";
import {
  parseTradeCandlesQuery,
  readTradeCandles,
  TRADE_CANDLE_MARKET_SQL,
  TRADE_CANDLES_SQL,
  BALANCE_CANDLES_SQL,
} from "@blast/server/modules/social/prices/trade-candles.ts";
import {
  TRADE_TICK_LIMIT,
  TRADE_CANDLE_LIMIT,
  tradeCandlePageSchema,
} from "@blast/core/modules/social/contracts/trade-candles.ts";

const coin = `0x${"1".repeat(64)}::coin::A`;
const presale = `0x${"2".repeat(64)}`;
const url = (query = "") =>
  new URL(
    `https://blast.test/api/social/prices?format=ohlcv&source=pool_swaps&coin=${coin}${query}`,
  );
const now = 1_800_000_000_000;
const market = {
  presale_id: presale,
  sale_token: coin,
  quote_type: "SUI",
  quote_symbol: "SUI",
  sale_decimals: 9,
  quote_decimals: 9,
  launched_ms: String(now - 120_000),
  unavailable: false,
  pool_id: `0x${"3".repeat(64)}`,
  venue: "cetus",
};

test("migrated Blast charts use individual pool swaps rather than net wallet balances", async () => {
  const page = await readTradeCandles(
    database(),
    parseTradeCandlesQuery(url()),
    now,
  );
  assert.equal(page.source, "chain_pool_swaps");
  assert.equal(page.price_basis, "pool_swap");
  assert.deepEqual(page.pool, { id: market.pool_id, venue: "cetus" });
  assert.match(TRADE_CANDLES_SQL, /chain_read_v1\.presale_pool_swaps/);
  assert.doesNotMatch(TRADE_CANDLES_SQL, /chain_read_v1\.activity/);
});
const candle = {
  at_ms: now - 60_000,
  open: "1",
  high: "3",
  low: "1",
  close: "2",
  volume: "0.000000001",
  trades: 3,
};

function database(
  options: {
    rows?: object[];
    network?: string;
    missingStamp?: boolean;
    ticks?: number;
    candles?: (typeof candle)[];
    excluded?: number;
    priorClose?: string;
  } = {},
): ReadableDatabase {
  return {
    read: async (sql, values) => {
      assertChainReadThroughViews(sql);
      assertReadOnlyStatement(sql);
      if (sql === TRADE_CANDLE_MARKET_SQL)
        return { rows: options.rows ?? [market] } as never;
      if (sql === TRADE_CANDLES_SQL || sql === BALANCE_CANDLES_SQL) {
        assert.ok(Number(values![2]) <= now, "never read past the watermark");
        assert.equal(values![3], 100);
        return {
          rows: [
            {
              tick_count: options.ticks ?? 3,
              excluded_trades: options.excluded ?? 0,
              prior_close: options.priorClose,
              candles: options.candles ?? [candle],
            },
          ],
        } as never;
      }
      return {
        rows: options.missingStamp
          ? []
          : [
              {
                network: options.network ?? "mainnet",
                checkpoint: "100",
                timestamp_ms: String(now),
                observed_ms: String(now + 5000),
              },
            ],
      } as never;
    },
  };
}

test("execution history query validates one exact market, supported ranges and intervals", () => {
  assert.equal(parseTradeCandlesQuery(url()).interval, "5m");
  assert.equal(
    parseTradeCandlesQuery(url("&window=launch&interval=1s")).interval,
    "1s",
  );
  for (const suffix of [
    "&coin=x",
    "&presale=x",
    "&interval=2m",
    "&interval=1s&interval=1m",
    "&window=bad",
    "&format=ohlcv",
    "&points=50",
    "&from=1",
    "&at=100", // Checkpoint reads must name the presale.
    `&presale=${presale}&at=100&at=101`,
    `&presale=${presale}&at=-1`,
    `&presale=${presale}&at=9007199254740992`,
  ]) {
    assert.throws(() => parseTradeCandlesQuery(url(suffix)), suffix);
  }
});

test("recorded candles retain exact quote units, sparse buckets and partial-coverage counts", async () => {
  const result = await readTradeCandles(
    database({ excluded: 2 }),
    parseTradeCandlesQuery(url("&interval=1m&window=launch")),
    now + 30_000,
  );
  assert.equal(result.to_ms, now);
  assert.deepEqual(result.candles, [candle]);
  assert.equal(result.quote?.symbol, "SUI");
  assert.equal(result.excluded_trades, 2);
  assert.equal(result.price_basis, "pool_swap");
  assert.ok(tradeCandlePageSchema.safeParse(result).success);
});

test("unsupported, incomplete, empty and too-large histories stay distinct", async () => {
  const request = parseTradeCandlesQuery(url());
  assert.equal(
    (await readTradeCandles(database({ rows: [] }), request, now)).status,
    "unsupported",
  );
  assert.equal(
    (
      await readTradeCandles(
        database({ rows: [{ ...market, unavailable: true }] }),
        request,
        now,
      )
    ).status,
    "unavailable",
  );
  assert.equal(
    (
      await readTradeCandles(
        database({ rows: [{ ...market, launched_ms: null }] }),
        request,
        now,
      )
    ).status,
    "unavailable",
  );
  for (const incomplete of [
    { sale_decimals: null },
    { quote_decimals: null },
    { sale_decimals: -1 },
    { quote_decimals: 39 },
    { quote_symbol: null },
    { pool_id: null },
    { venue: null },
  ]) {
    const page = await readTradeCandles(
      database({ rows: [{ ...market, ...incomplete }] }),
      request,
      now,
    );
    assert.equal(page.status, "unavailable");
    assert.ok(tradeCandlePageSchema.safeParse(page).success);
  }
  const empty = await readTradeCandles(
    database({ candles: [], ticks: 0, priorClose: "0.0123" }),
    request,
    now,
  );
  assert.equal(empty.status, "available");
  assert.deepEqual(empty.candles, []);
  assert.equal(empty.prior_close, "0.0123");
  assert.ok(tradeCandlePageSchema.safeParse(empty).success);
  const capped = await readTradeCandles(
    database({ ticks: TRADE_TICK_LIMIT + 1 }),
    request,
    now,
  );
  assert.equal(capped.status, "too_many_trades");
  assert.deepEqual(
    capped.candles,
    [],
    "never show a partially aggregated bucket",
  );
  const many = Array.from({ length: TRADE_CANDLE_LIMIT + 1 }, (_, index) => ({
    ...candle,
    at_ms: index * 60_000,
  }));
  const newest = await readTradeCandles(
    database({ candles: many }),
    request,
    now,
  );
  assert.equal(newest.truncated, true);
  assert.equal(newest.candles.length, TRADE_CANDLE_LIMIT);
  assert.equal(newest.candles[0]!.at_ms, 60_000);
  await assert.rejects(
    readTradeCandles(database({ network: "testnet" }), request, now),
  );
  await assert.rejects(
    readTradeCandles(database({ missingStamp: true }), request, now),
  );
});

test("OHLCV format uses the public price route, cache and admission without account reads", async () => {
  const { createSocialRouteKit } = await import(
    "@blast/server/modules/social/route-kit/route.ts"
  );
  const { createSocialPricesRoute } = await import(
    "@blast/server/modules/social/prices/route.ts"
  );
  const buckets: string[] = [];
  const kit = createSocialRouteKit({
    tradingVisible: () => true,
    expectedOrigin: "https://blast.test",
    verifyAccessToken: async () => {
      throw new Error("public read must not authenticate");
    },
    accounts: {
      resolve: async () => {
        throw new Error("no account lookup");
      },
      resolveWallet: async () => null,
    },
    primary: () => {
      throw new Error("no primary access");
    },
    limiter: {
      consume: async (bucket) => {
        buckets.push(bucket);
        return {
          allowed: true,
          bucket,
          policyVersion: 1,
          retryAfterSeconds: 0,
        };
      },
    },
  });
  const cacheKeys: string[] = [];
  const route = createSocialPricesRoute({
    kit,
    database,
    now: () => now,
    publicRead: async (key, load, ttl) => {
      cacheKeys.push(key);
      assert.equal(ttl, JSON.parse(key).live ? 1_000 : 10_000);
      return load();
    },
  });
  const response = await route.GET(new Request(url("&window=7d&interval=1m")), testClient());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).price_basis, "pool_swap");
  assert.match(response.headers.get("cache-control")!, /public/);
  assert.deepEqual(buckets, ["social_read_prices"]);
  assert.equal(JSON.parse(cacheKeys[0]!).format, "ohlcv");
  const legacyUrl = url("&window=7d&interval=1m");
  legacyUrl.searchParams.delete("source");
  const legacyResponse = await route.GET(new Request(legacyUrl), testClient());
  assert.equal(
    (await legacyResponse.json()).price_basis,
    "transaction_balance_change",
  );
  assert.notEqual(
    cacheKeys[0],
    cacheKeys[1],
    "pool and wallet candles have separate cache keys",
  );
  const live = await route.GET(new Request(url(`&presale=${presale}&window=1h&at=100`)), testClient());
  assert.equal(live.status, 200);
  assert.equal((await live.json()).as_of.checkpoint, 100);
  const lagging = await route.GET(new Request(url(`&presale=${presale}&window=1h&at=101`)), testClient());
  assert.equal(lagging.status, 503);
  assert.match(lagging.headers.get("cache-control")!, /no-store/);
  assert.equal(cacheKeys[2], cacheKeys[3], "different checkpoint floors share the recent pool aggregate");
  const invalid = await route.GET(new Request(url("&format=ohlcv")), testClient());
  assert.equal(invalid.status, 400);
  assert.match(invalid.headers.get("cache-control")!, /no-store/);
  assert.equal(
    cacheKeys.length,
    4,
    "invalid query never reaches cache/database",
  );
});

test("candle source and pool identity cannot contradict their price basis", () => {
  const page = {
    format: "ohlcv",
    source: "chain_pool_swaps",
    price_basis: "pool_swap",
    pool: { id: market.pool_id, venue: "cetus" },
    network: "mainnet",
    coin_type: coin,
    presale_id: presale,
    window: "24h",
    interval: "1m",
    quote: { coin_type: "SUI", symbol: "SUI" },
    status: "available",
    from_ms: 0,
    to_ms: now,
    candles: [candle],
    excluded_trades: 0,
    truncated: false,
    as_of: { checkpoint: 100, timestamp_ms: now, lag_ms: 0 },
  };
  assert.ok(tradeCandlePageSchema.safeParse(page).success);
  for (const invalid of [
    { pool: null },
    { pool: { id: "wrong", venue: "cetus" } },
    { price_basis: "transaction_balance_change" },
    { source: "chain_trade_activity" },
  ])
    assert.equal(
      tradeCandlePageSchema.safeParse({ ...page, ...invalid }).success,
      false,
    );
  assert.ok(
    tradeCandlePageSchema.safeParse({
      ...page,
      source: "chain_trade_activity",
      price_basis: "transaction_balance_change",
      pool: undefined,
    }).success,
    "rolling deployment compatibility",
  );
});

test("existing chart clients retain balance candles until they opt into pool swaps", async () => {
  const legacy = url();
  legacy.searchParams.delete("source");
  const page = await readTradeCandles(
    database(),
    parseTradeCandlesQuery(legacy),
    now,
  );
  assert.equal(page.source, "chain_trade_activity");
  assert.equal(page.price_basis, "transaction_balance_change");
  assert.match(BALANCE_CANDLES_SQL, /chain_read_v1\.activity/);
  for (const suffix of ["&source=other", "&source=pool_swaps"])
    assert.throws(() => parseTradeCandlesQuery(url(suffix)));
});
