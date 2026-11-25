import assert from "node:assert/strict";
import test from "node:test";
import { applyStreamedFill, tradeCoinHistory, tradePoolKey, type TradeCoinHistory } from "./trade-coin-history";
import { createCoinReads } from "./coin-reads";
import type { TradeCandlePage } from "@blast/core/modules/social/contracts/trade-candles.ts";

const asset = {
  chain: "sui",
  network: "mainnet",
  coin_type: `0x${"1".repeat(64)}::coin::A`,
  presale_id: `0x${"2".repeat(64)}`,
} as const;
const candle = {
  at_ms: 60_000,
  open: "0.0000000001",
  high: "0.0000000003",
  low: "0.0000000001",
  close: "0.0000000002",
  volume: "9007199254740993.000000001",
  trades: 3,
};
const page: TradeCandlePage = {
  format: "ohlcv",
  source: "chain_trade_activity",
  price_basis: "transaction_balance_change",
  network: "mainnet",
  coin_type: asset.coin_type,
  presale_id: asset.presale_id,
  window: "7d",
  interval: "1m",
  quote: { coin_type: "SUI", symbol: "SUI" },
  status: "available",
  from_ms: 0,
  to_ms: 120_000,
  candles: [candle],
  excluded_trades: 0,
  truncated: false,
  as_of: { checkpoint: 100, timestamp_ms: 120_000, lag_ms: 0 },
};

test("production chart reader uses real execution candles before launchpad or sampled history", async () => {
  const original = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = async (input) => {
    urls.push(new URL(String(input), "https://blast.test"));
    return Response.json(page);
  };
  try {
    const result = await createCoinReads().chart(
      asset,
      "7d",
      new AbortController().signal,
      "1m",
    );
    assert.ok(result && "kind" in result && result.kind === "trades");
    assert.deepEqual(result.page.candles, [candle]);
    assert.equal(urls.length, 1, "no broken launchpad dependency");
    assert.equal(urls[0]!.pathname, "/api/social/prices");
    assert.equal(urls[0]!.searchParams.get("format"), "ohlcv");
    assert.equal(urls[0]!.searchParams.get("source"), "pool_swaps");
    assert.equal(urls[0]!.searchParams.get("presale"), asset.presale_id);
  } finally {
    globalThis.fetch = original;
  }
});

test("execution response binds the requested identity, range and interval and rejects malformed OHLC", async () => {
  const original = globalThis.fetch;
  try {
    for (const patch of [
      { network: "testnet" },
      { coin_type: "other" },
      { presale_id: null },
      { window: "24h" },
      { interval: "1s" },
      { quote: null },
      { candles: [{ ...candle, high: "0" }] },
      { candles: [{ ...candle, at_ms: 60_001 }] },
      { candles: [candle, candle] },
      { candles: [{ ...candle, volume: "-1" }] },
      { candles: [{ ...candle, trades: 0 }] },
    ]) {
      globalThis.fetch = async () => Response.json({ ...page, ...patch });
      assert.equal(
        await tradeCoinHistory(asset, "7d", new AbortController().signal, "1m"),
        null,
        JSON.stringify(patch),
      );
    }
    globalThis.fetch = async () => Response.json({ ...page, candles: [] });
    assert.deepEqual(
      (await tradeCoinHistory(asset, "7d", new AbortController().signal, "1m"))
        ?.page.candles,
      [],
    );
    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled"));
    await assert.rejects(
      tradeCoinHistory(asset, "7d", cancelled.signal, "1m"),
      /cancelled/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a streamed swap moves the swap candles by the server's formula, and only a swap it can price", () => {
  const sui = "0x2::sui::SUI";
  const swaps: TradeCoinHistory = {
    kind: "trades",
    coin_type: asset.coin_type,
    page: { ...page, source: "chain_pool_swaps", price_basis: "pool_swap", pool: { id: `0x${"3".repeat(64)}`, venue: "cetus" }, quote: { coin_type: sui, symbol: "SUI" }, candles: [{ ...candle, at_ms: 60_000, open: "2", high: "2", low: "2", close: "2", volume: "4", trades: 2 }] },
  };
  const quote = { quote: `0x${"0".repeat(63)}2::sui::SUI`, price: null, memeDecimals: 6, quoteDecimals: 9, quoteUsd: null };
  // 1 SUI for 3 coins: 0.333… SUI per coin, kept past its first digit, as the server's numeric division does.
  const fill = (timestampMs: number, quoteAmount: bigint, memeAmount: bigint, over = quote) => ({ checkpoint: 101, timestampMs, quoteAmount, memeAmount, quote: over });
  assert.equal(tradePoolKey(swaps), `cetus:0x${"3".repeat(64)}`);
  assert.equal(tradePoolKey({ ...swaps, page: { ...swaps.page, pool: { id: `0x${"3".repeat(64)}`, venue: "aftermath" } } }), null, "the stream serves no Aftermath pool");
  const same = applyStreamedFill(swaps, fill(119_999, 1_000_000_000n, 3_000_000n));
  assert.deepEqual(same.page.candles, [{ ...swaps.page.candles[0]!, low: "0.333333333333333333", close: "0.333333333333333333", volume: "5", trades: 3 }]);
  const next = applyStreamedFill(same, fill(120_000, 4_000_000_000n, 1_000_000n));
  assert.deepEqual(next.page.candles.at(-1), { at_ms: 120_000, open: "4", high: "4", low: "4", close: "4", volume: "4", trades: 1 });
  assert.equal(next.page.to_ms, 120_000);
  assert.equal(applyStreamedFill(next, fill(60_000, 1n, 1n)), next, "a swap before the last candle waits for a read");
  assert.equal(applyStreamedFill(swaps, fill(60_000, 1n, 1n, { ...quote, quote: "0x2::usdc::USDC" })), swaps, "another quote is not on these candles");
  assert.equal(applyStreamedFill(swaps, fill(60_000, 1n, 1n, null as never)), swaps, "no decimals, no price");
  assert.equal(applyStreamedFill(swaps, fill(60_000, 0n, 1n)), swaps, "the server drops empty swaps");
  const balances: TradeCoinHistory = { ...swaps, page: { ...swaps.page, source: "chain_trade_activity", price_basis: "transaction_balance_change" } };
  assert.equal(applyStreamedFill(balances, fill(60_000, 1n, 1n)), balances, "balance-change candles never take a swap");
  assert.equal(applyStreamedFill({ ...swaps, page: { ...swaps.page, status: "too_many_trades", candles: [] } }, fill(60_000, 1n, 1n)).page.candles.length, 0);
});
