import assert from "node:assert/strict";
import test from "node:test";

import type { HomeCoinMarket } from "@blast/core/web/contracts/coin-market.ts";
import type { TradeCandlePage } from "@blast/core/web/contracts/trade-candles.ts";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";
import { fixtureDetail } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { infraProvenanceFixture } from "../../../../../packages/server/test/fixtures/modules/launchpad-contract/fixtures.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, settleQueries, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { PresalePoolChart } = await import("./PresalePoolChart");
const { subscribeChartPrice } = await import("#web/components/launchpad/chart/chart-live-price.ts");

test("a matching trade hint updates the migration pool's candles in the open chart", async (t) => {
  const clock = 1_800_000_020_000;
  let now = clock;
  t.mock.method(Date, "now", () => now);
  t.mock.method(Math, "random", () => 0);
  const streams: EventStream[] = [];
  class EventStream {
    private readonly listeners = new Map<string, (event: { data: string }) => void>();
    constructor(readonly url: string) { streams.push(this); }
    close() {}
    addEventListener(type: string, receive: (event: { data: string }) => void) {
      this.listeners.set(type, receive);
    }
    receive(frame: unknown, type = "hint") {
      this.listeners.get(type)?.({ data: JSON.stringify(frame) });
    }
  }
  const sourceProperty = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: EventStream });

  const { presale: sale } = fixtureDetail("kstl");
  const bucket = clock - clock % 300_000;
  const pool = { id: `0x${"3".repeat(64)}`, venue: "bluefin", coin_atoms: "1", quote_atoms: "2", as_of_ms: clock };
  const quote = { type: sale.quote_type, symbol: sale.quote_symbol, decimals: sale.quote_decimals };
  const window = {
    from_ms: clock - 300_000, to_ms: clock, open_usd: null, open_as_of_ms: null, change_bps: null, change_usd: null,
    buys: 0, sells: 0, bought_atoms: "0", sold_atoms: "0", bought_usd: null, sold_usd: null,
    unpriced_buys: 0, unpriced_sells: 0, buyers: 0, sellers: 0,
  };
  const market: HomeCoinMarket = {
    coin_type: sale.sale_token, presale_id: sale.presale_id, decimals: sale.sale_decimals,
    price_usd: null, price_as_of_ms: null, clock_ms: clock, pool, quote, supply: null,
    fdv_usd: null, market_cap_usd: null, liquidity_usd: null,
    windows: { "5m": window, "1h": window, "4h": window, "24h": window },
    as_of: { checkpoint: 100, timestamp_ms: clock, lag_ms: 0 },
  };
  const open = { at_ms: bucket, open: "1", high: "1", low: "1", close: "1", volume: "2", trades: 1 };
  const earlier = { ...open, at_ms: bucket - 7_200_000 };
  const filled = { ...open, close: "2", high: "2", volume: "5", trades: 2 };
  const reads: URLSearchParams[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://blast.test");
    assert.equal(url.pathname, "/api/social/prices");
    reads.push(url.searchParams);
    const tail = url.searchParams.get("window") === "1h";
    const checkpoint = Number(url.searchParams.get("at") ?? 100);
    const to = clock + checkpoint - 100;
    const crowded = checkpoint === 104;
    const page: TradeCandlePage = {
      format: "ohlcv", source: "chain_pool_swaps", price_basis: "pool_swap", pool: { id: pool.id, venue: "bluefin" },
      network: "mainnet", coin_type: sale.sale_token, presale_id: sale.presale_id,
      window: tail ? "1h" : "24h", interval: "5m", status: crowded ? "too_many_trades" : "available", quote: { coin_type: quote.type, symbol: quote.symbol },
      from_ms: bucket - (tail ? 3_600_000 : 86_400_000), to_ms: to,
      candles: crowded ? [] : tail ? [filled] : [earlier, open], excluded_trades: 0, truncated: false,
      as_of: { checkpoint, timestamp_ms: to, lag_ms: 0 },
    };
    return Response.json(page);
  });

  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    if (sourceProperty) Object.defineProperty(globalThis, "EventSource", sourceProperty);
    else Reflect.deleteProperty(globalThis, "EventSource");
  });

  const settle = () => act(async () => settleQueries(client));
  const page = () => client.getQueriesData<TradeCandlePage>({ queryKey: ["presale-pool-candles"] })[0]?.[1];
  const emit = (checkpoint: number, presaleId: string, kind: "trade_buy" | "trade_sell") =>
    act(async () => streams[0]!.receive({ type: "activity", activity_id: `${checkpoint}:0:4294967295:0`, kind, presale_id: presaleId }));

  await act(async () => root.render(withQueryClient(client, <PresalePoolChart sale={sale} market={market} pool={pool} />)));
  await settle();
  assert.deepEqual(page()?.candles, [earlier, open]);
  assert.equal(streams.length, 1);
  await act(async () => {
    streams[0]!.receive({ type: "hello", provenance: infraProvenanceFixture({ deployment_fingerprint: null }) });
    streams[0]!.receive({ type: "pong" });
  });
  await settle();
  const chart = container.querySelector("[data-compact-chart]");
  assert.ok(chart, "the real chart root is mounted");
  const baseline = reads.length;

  now += 6_000;
  await emit(101, pool.id, "trade_buy");
  await settle();
  assert.equal(reads.length, baseline, "another coin's hint never fetches");

  await emit(102, sale.presale_id, "trade_buy");
  await settle();
  assert.equal(reads.at(-1)?.get("at"), "102");
  assert.equal(reads.at(-1)?.get("window"), "1h");
  assert.deepEqual(page()?.candles, [earlier, filled], "replace the open bucket and preserve older history");
  assert.strictEqual(container.querySelector("[data-compact-chart]"), chart);

  now += 6_000;
  await emit(103, sale.presale_id, "trade_sell");
  await settle();
  assert.equal(page()?.as_of.checkpoint, 103);
  assert.deepEqual(page()?.candles, [earlier, filled], "a hint without a pool fill cannot change OHLC or add volume");
  const afterHint = reads.length;
  await emit(101, sale.presale_id, "trade_sell");
  await settle();
  assert.equal(reads.length, afterHint, "an already indexed event never re-reads or doubles the fill");

  now += 6_000;
  await emit(104, sale.presale_id, "trade_buy");
  await settle();
  assert.equal(page()?.window, "24h");
  assert.equal(page()?.status, "too_many_trades", "an overflowing tail also exceeds the longer range's limit");

  now += 6_000;
  await emit(105, sale.presale_id, "trade_buy");
  await settle();
  assert.equal(page()?.as_of.checkpoint, 105);
  const poolKey = `${pool.venue}:${pool.id}`;
  const prices: (string | null)[] = [];
  const off = subscribeChartPrice(poolKey, null, (value) => prices.push(value?.price ?? null));
  t.after(off);
  const swap = (checkpoint: number, key: string, quoteAtoms: string, coinAtoms = "100") =>
    act(async () => streams[0]!.receive({
      type: "presale_pool_swap", presale_id: sale.presale_id, cursor: `${checkpoint}:0:1:0`,
      timestamp_ms: clock + checkpoint - 100, side: "buy", pool_key: key, coin_atoms: coinAtoms, quote_atoms: quoteAtoms,
    }, "presale"));
  await act(async () => streams[0]!.receive({ type: "pong", presale_checkpoint: 105 }));
  assert.equal(prices.at(-1), "0.001", "the fenced history supplies the current close");
  const readout = () => container.querySelector("[data-chart-latest-price]")?.textContent;
  const confirmed = readout();
  assert.ok(confirmed && confirmed !== "—", "the confirmed price is visible");
  const advanced = { ...market, as_of: { checkpoint: 106, timestamp_ms: clock + 6, lag_ms: 0 } };
  const showMarket = (latest: HomeCoinMarket, observedPool: typeof pool) =>
    act(async () => root.render(withQueryClient(client, <PresalePoolChart sale={sale} market={latest} pool={observedPool} />)));
  await showMarket(advanced, pool);
  assert.equal(readout(), confirmed, "unrelated indexer progress cannot blank a confirmed close");
  const changedPool = { ...pool, as_of_ms: clock + 5 };
  await showMarket({ ...advanced, pool: changedPool }, changedPool);
  assert.equal(readout(), "—", "a pool mutation at the same chain time may be newer than the proof");
  await showMarket(market, pool);
  prices.length = 0;
  const beforeSwaps = reads.length;
  await swap(106, `cetus:${pool.id}`, "264");
  await emit(106, sale.presale_id, "trade_buy");
  assert.deepEqual(prices, [], "an external venue cannot price the chart");
  await swap(107, poolKey, "199");
  await swap(108, poolKey, "123");
  await swap(108, poolKey, "123");
  await settle();
  assert.deepEqual(prices, ["1.99", "1.23"], "each distinct selected pool fill reaches the headline");
  assert.equal(reads.length, beforeSwaps, "live fills and related hints make no candle requests");
  await swap(109, poolKey, "1167", "10000000000");
  assert.equal(readout(), "0.000117", "the current chart close rounds the same way as the headline");
  const low = [...container.querySelectorAll("dt")].find((term) => term.textContent === "Low");
  assert.equal(low?.nextElementSibling?.textContent, readout(), "the current low and close are equal and use the same precision");
  now += 61_000;
  await swap(110, poolKey, "456");
  assert.equal(prices.at(-1), null, "a delayed fill clears the price until history catches up");
});
