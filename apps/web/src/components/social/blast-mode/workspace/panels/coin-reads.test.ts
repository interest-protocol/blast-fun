import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStructTag } from "@mysten/sui/utils";
import type { HomeCoin } from "@blast/core/modules/social/contracts/home.ts";
import { coinFacts } from "./coin-facts";
import { tradeRequest, amountInAtoms } from "./trade-model";
import { fixtureMarket } from "../../../../../../test/fixtures/presale-pages/market-fixtures.ts";
import { fixtureWallet } from "../../../../../../test/fixtures/social/trade/trade-fixtures.ts";
import { loadPrice } from "#web/components/social/prices/price-client.ts";
import { candleFixtureBody } from "../../../../../../../../packages/core/test/fixtures/modules/launchpad-coin/chart-fixtures.ts";
import { CURVE_POOL_KEY, VENUE_POOL_KEY, wireProvenance } from "../../../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { CANDLE_INTERVALS, candleIntervalMs, type CandleInterval } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { browserMarketDependencies } from "#web/components/launchpad/blast-infra-browser.ts";
import { WorkspaceDataUnavailable } from "../live-read";
import { createCoinReads, nativeCoinChartReader } from "./coin-reads";
import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { proofMarket } from "../../../../../../test/fixtures/workspace/redesign-fixtures.ts";

const asset = {
  chain: "sui",
  network: "mainnet",
  coin_type: normalizeStructTag("0x2::coin::A"),
  presale_id: null,
} as const;
const row: HomeCoin = {
  ...fixtureMarket(0),
  coin_type: asset.coin_type,
  symbol: "A",
  name: "Coin A",
  decimals: 9,
  price_usd: null,
  presale_id: null,
};

// Trading catalog responses use usd_price, not Discover's price_usd field.
const catalogCoin = (price: string | null) => ({
  coin_type: asset.coin_type, symbol: "A", name: "Coin A", decimals: 9,
  icon_url: null, usd_price: price, presale_id: null, in_presale: false,
});
const listed = (coins: readonly HomeCoin[], read_ms = 5000, window = "24h") => [{ coins, window, read_ms }];
const asOf = { checkpoint: 1, timestamp_ms: 1000, lag_ms: 0 };
const discoverPage = {
  coins: [],
  window: "24h",
  clock_ms: 1000,
  as_of: asOf,
  page: 1,
  pages: 1,
  total: 0,
  next_cursor: null,
};

test("production resolution falls back to loaded identity without an old price and never reads a different network", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).includes("/trades/coins")
    ? Response.json({ coins: [], next_cursor: null })
    : Response.json(discoverPage);
  try {
    const reads = createCoinReads(() => listed([row]));
    const signal = new AbortController().signal;
    const fallback = await reads.coin(asset, signal);
    assert.equal(fallback?.symbol, row.symbol);
    assert.equal(fallback?.price_usd, null);
    assert.equal(fallback?.holders, row.holders);
    assert.equal(fallback?.holders_read_ms, 5000);
    const other = { ...asset, network: "testnet" as const };
    assert.equal(await reads.coin(other, signal), null);
    await assert.rejects(reads.chart(other, "24h", signal), WorkspaceDataUnavailable);
    assert.equal(await reads.holders(other, signal), null);
    assert.equal(await reads.activity(other, signal), null);
  } finally {
    globalThis.fetch = original;
  }
});

test("a loaded Discover row does not freeze a presented coin's live price", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    coins: [catalogCoin("2.5")],
    next_cursor: null,
  });
  try {
    const reads = createCoinReads(() => listed([{ ...row, price_usd: "1.0" }]));
    assert.equal((await reads.coin(asset, new AbortController().signal))?.price_usd, "2.5");
  } finally {
    globalThis.fetch = original;
  }
});

test("a standalone coin's header keeps the Discover row's holders and activity beside the live price", async () => {
  const original = globalThis.fetch;
  let price: string | null = "1.0";
  globalThis.fetch = async () => Response.json({ coins: [catalogCoin(price)], next_cursor: null });
  const listedRow = { ...row, price_usd: "1.0", fdv_usd: "6500.00", change_24h_bps: 120, holders: 12, icon_url: "https://example.test/a.png" };
  const older = { ...listedRow, holders: 3 };
  const hourly = { ...listedRow, holders: 99 };
  const pages = [
    ...listed([older], 1000),
    ...listed([listedRow], 4000),
    ...listed([hourly], 9000, "1h"),
  ];
  try {
    const same = await createCoinReads(() => pages, () => 5000).coin(asset, new AbortController().signal);
    assert.equal(same?.price_usd, "1.0");
    assert.equal(same?.fdv_usd, "6500.00", "the list priced the coin as the catalog does, so its FDV holds");
    assert.equal(same?.change_24h_bps, 120);
    assert.equal(same?.holders, 12, "the newest 24 h page wins over an older one and a 1 h one");
    assert.equal(same?.holders_read_ms, 4000, "the holder count carries the list's read time");
    assert.deepEqual(same?.activity, listedRow.activity);
    assert.equal(same?.icon_url, listedRow.icon_url);

    const later = await createCoinReads(() => pages, () => 4000 + 120_001).coin(asset, new AbortController().signal);
    assert.equal(later?.fdv_usd, "6500.00", "an unchanged price keeps its FDV");
    assert.equal(later?.change_24h_bps, undefined, "a 24 h move read over two minutes ago has slid with its window");
    assert.equal(later?.holders, 12);

    price = "2.5";
    const moved = await createCoinReads(() => pages, () => 5000).coin(asset, new AbortController().signal);
    assert.equal(moved?.price_usd, "2.5");
    assert.equal(moved?.fdv_usd, undefined, "an FDV from another price never sits beside the live one");
    assert.equal(moved?.change_24h_bps, undefined);
    assert.equal(moved?.holders, 12);

    price = null;
    const unpriced = await createCoinReads(() => pages).coin(asset, new AbortController().signal);
    assert.equal(unpriced?.price_usd, null, "a list price never stands in for a live one");
    assert.equal(unpriced?.fdv_usd, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("production search requires canonical type matching and a bounded Discover miss stays unresolved", async () => {
  const original = globalThis.fetch;
  const requests: URL[] = [];
  let exact = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://blast.test");
    requests.push(url);
    if (url.pathname === "/api/social/trades/coins")
      return Response.json({
        coins: [
          {
            coin_type: exact
              ? asset.coin_type
              : normalizeStructTag("0x3::coin::A"),
            symbol: "A",
            name: "Coin A",
            decimals: 9,
            icon_url: null,
            usd_price: null,
            presale_id: null,
          },
        ],
        next_cursor: null,
      });
    return Response.json({ ...discoverPage, next_cursor: "more-unloaded" });
  };
  try {
    const reads = createCoinReads();
    const signal = new AbortController().signal;
    assert.equal(await reads.coin(asset, signal), null);
    assert.equal(requests[0]!.searchParams.get("q"), asset.coin_type);
    assert.equal(requests[1]!.searchParams.get("limit"), "50");
    exact = true;
    assert.equal((await reads.coin(asset, signal))?.coin_type, asset.coin_type);
    assert.equal(requests.length, 3);
    assert.equal(await reads.holders(asset, signal), null);
    assert.equal(await reads.activity(asset, signal), null);
    assert.equal(
      requests.length,
      3,
      "standalone holders/activity never invent a sale binding",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("existing discovery recovers a failed coin-picker read and sale holder coverage stays bounded", async () => {
  const original = globalThis.fetch;
  const requests: URL[] = [];
  const sale = { ...asset, presale_id: `0x${"1".repeat(64)}` };
  const holders = { holders: [], share_bps: null };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://blast.test");
    requests.push(url);
    if (url.pathname === "/api/social/trades/coins")
      return Response.json({}, { status: 503 });
    const { window, clock_ms } = discoverPage;
    const byId = url.pathname.endsWith("/coins");
    return Response.json(byId
      ? { coins: [{ ...row, presale_id: sale.presale_id, top_holders: holders }], missing: [], window, clock_ms, as_of: asOf }
      : { ...discoverPage, coins: [row], total: 1 });
  };
  try {
    const reads = createCoinReads();
    const signal = new AbortController().signal;
    assert.equal((await reads.coin(asset, signal))?.coin_type, asset.coin_type);
    assert.deepEqual(await reads.holders(sale, signal), holders);
    assert.equal(requests.at(-1)!.searchParams.get("holder_limit"), "100");
  } finally {
    globalThis.fetch = original;
  }
});


test("timestamp-less catalog metadata cannot authorize typed Sell but exact Max remains available", async () => {
 const original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({coins:[catalogCoin("2.5")],next_cursor:null});
 try {
  const record=await createCoinReads().coin(asset,new AbortController().signal);
  assert.ok(record);assert.equal(record.price_as_of_ms,null);
  const base=fixtureWallet();
  const wallet={...base,as_of_ms:Date.now(),coins:[{...base.coins![0]!,coin_type:asset.coin_type,decimals:9,atoms:"2000000000",usd_price:null}]};
  const facts=coinFacts(asset.coin_type,record,wallet,true);
  assert.equal(tradeRequest({side:"sell",typed:"5",mode:"typed"},facts),null);
  assert.equal(amountInAtoms({side:"sell",typed:"5",mode:"all"},facts),2_000000000n);
 } finally {globalThis.fetch=original;}
});

test("project links require the selected network, sale and canonical token identity", async () => {
  const original = globalThis.fetch;
  const metadata = { site: "https://example.com", x_handle: "example", telegram: "example" };
  let requests = 0;
  let token = asset.coin_type;
  let sale = "sale-A";
  globalThis.fetch = async () => { requests++; return Response.json({ presale: { presale_id: sale, sale_token: token, metadata } }); };
  try {
    const links = createCoinReads().links!;
    const selected = { ...asset, presale_id: "sale-A" };
    const signal = new AbortController().signal;
    assert.equal(await links(asset, signal), null);
    assert.equal(await links({ ...selected, network: "testnet" }, signal), null);
    assert.equal(requests, 0);
    assert.deepEqual(await links(selected, signal), metadata);
    token = "0x2::coin::B";
    assert.equal(await links(selected, signal), null);
    token = asset.coin_type; sale = "sale-B";
    assert.equal(await links(selected, signal), null);
  } finally { globalThis.fetch = original; }
});


test("chart requests use the selected range and tier, keep dense observations and refuse unbounded standalone history", async () => {
  const original = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://blast.test");
    if (url.pathname.startsWith("/api/launchpad/market")) return Response.json({ error: { code: "not_found", message: "Unknown market" } }, { status: 404 });
    if (url.searchParams.get("format") === "ohlcv") return Response.json({}, { status: 503 });
    requests.push(url);
    return Response.json({ window: url.searchParams.get("window"), clock_ms: 1000, prices: [], as_of: asOf });
  };
  try {
    const reads = createCoinReads();
    const signal = new AbortController().signal;
    await reads.chart(asset, "7d", signal, "1h");
    assert.equal(requests[0]!.searchParams.get("window"), "7d");
    assert.equal(requests[0]!.searchParams.get("interval"), "1h");
    assert.equal(requests[0]!.searchParams.get("points"), "288");
    await reads.chart(asset, "1h", signal, "1s");
    assert.equal(requests[1]!.searchParams.has("interval"), false, "indexed reads cannot invent a native candle tier");
    await assert.rejects(reads.chart(asset, "launch", signal), WorkspaceDataUnavailable);
    assert.equal(requests.length, 2);
    assert.equal(await loadPrice({ kind: "coin", id: asset.coin_type, window: "30d" }), null);
    assert.equal(requests.at(-1)!.searchParams.get("window"), "30d", "batched reads flush every supported range");
  } finally {
    globalThis.fetch = original;
  }
});


test("native chart requests propagate every interval and selected range through the validated pool client", async () => {
  const now = 1_790_232_000_000;
  const requests: URL[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input), "https://blast.test");
    requests.push(url);
    if (url.pathname.endsWith("/status")) return Response.json({ provenance: wireProvenance(now) });
    return Response.json(candleFixtureBody(url.pathname.includes("/bluefin/") ? "venue" : "curve", "migrated", {
      interval: url.searchParams.get("interval") as CandleInterval,
      from: Number(url.searchParams.get("from") ?? 0),
      to: Number(url.searchParams.get("to") ?? now),
      limit: Number(url.searchParams.get("limit") ?? 2000),
    }, now));
  };
  const selected = { ...asset, network: "localnet" as const };
  const reader = nativeCoinChartReader({
    asset: selected,
    source: { expected: null, curvePoolKey: CURVE_POOL_KEY, venuePoolKey: VENUE_POOL_KEY, migration: null, symbol: "C", quoteSymbol: "SUI", memeDecimals: 6, quoteDecimals: 9 },
    dependencies: browserMarketDependencies(null, fetcher, () => now),
    now: () => now,
  });
  for (const interval of CANDLE_INTERVALS) {
    const history = await reader(selected, "1h", new AbortController().signal, interval);
    assert.ok(history && "kind" in history && history.kind === "native");
    const section = history.chart.curve;
    assert.ok(section?.state === "available" || section?.state === "stale", section?.state);
    assert.equal(section.data.interval, interval);
    assert.ok(history.request?.from !== undefined);
    assert.ok(history.request.from <= now - 3_600_000);
    assert.ok(history.request.from > now - 3_600_000 - candleIntervalMs(interval));
    assert.equal(history.request?.interval, interval);
    assert.ok(requests.some(url => url.searchParams.get("interval") === interval));
  }
});


test("failed identity lookup plus a bounded discovery miss remains retryable even with a cached row", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => String(input).includes("/trades/coins")
    ? Response.json({ error: { code: "service_unavailable" } }, { status: 503 })
    : Response.json(discoverPage);
  try {
    await assert.rejects(createCoinReads(() => listed([row])).coin(asset, new AbortController().signal));
  } finally { globalThis.fetch = original; }
});

test("a curated ecosystem coin never asks the market service for candles", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://blast.test");
    paths.push(url.pathname);
    if (url.pathname.startsWith("/api/launchpad/market")) return Response.json({ error: { code: "not_found", message: "Unknown market" } }, { status: 404 });
    if (url.searchParams.get("format") === "ohlcv") return Response.json({}, { status: 503 });
    return Response.json({ window: url.searchParams.get("window"), clock_ms: 1000, prices: [], as_of: asOf });
  };
  try {
    const usdc = { ...asset, coin_type: USDC_COIN_TYPE };
    await createCoinReads().chart(usdc, "24h", new AbortController().signal).catch(() => null);
    assert.equal(paths.some((path) => path.includes("/candles")), false);
    await createCoinReads().chart(asset, "24h", new AbortController().signal).catch(() => null);
    assert.equal(paths.some((path) => path.includes("/candles")), true, "a launch coin still reads its merged candles");
  } finally {
    globalThis.fetch = original;
  }
});

test("a graduated sale charts its pool's candles route only, retries a failed read and is unavailable without coverage", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  let venue = "bluefin";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://blast.test");
    paths.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/social/home/market") {
      const market = proofMarket(url.searchParams.get("coin")!);
      return Response.json({ ...market, pool: { ...market.pool!, venue } });
    }
    if (url.pathname.endsWith("/candles")) return Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
    return Response.json({ window: url.searchParams.get("window"), clock_ms: 1000, prices: [], as_of: asOf });
  };
  try {
    const sale = { ...asset, presale_id: "0x" + "e".repeat(64) };
    const signal = new AbortController().signal;
    const reads = createCoinReads();
    const failed = await reads.chart(sale, "24h", signal).then(() => null, (error: unknown) => error);
    assert.ok(failed instanceof Error && !(failed instanceof WorkspaceDataUnavailable), "a failed candles read stays retryable");
    assert.ok(paths.some((path) => path.startsWith("/api/launchpad/market/pools/bluefin/") && path.includes("/candles")), "the pool's own candles are read");
    await reads.chart(sale, "24h", signal).catch(() => null);
    assert.equal(paths.filter((path) => path.startsWith("/api/social/home/market")).length, 1, "the sale's pool is read once per reader");
    venue = "aftermath";
    const before = paths.length;
    await assert.rejects(createCoinReads().chart(sale, "24h", signal), WorkspaceDataUnavailable);
    assert.equal(paths.slice(before).some((path) => path.includes("/candles")), false, "a pool the market service does not cover reads no candles");
    assert.equal(paths.some((path) => path.includes("pool_swaps") || path.includes("format=ohlcv") || path.includes("prices")), false, "never the old swap or price-line reads");
  } finally {
    globalThis.fetch = original;
  }
});
