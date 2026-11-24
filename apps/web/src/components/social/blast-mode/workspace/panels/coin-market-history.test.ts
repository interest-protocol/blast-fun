import assert from "node:assert/strict";
import test from "node:test";
import { coinMarketHistory, estimateUsdPrice, tradeQuote } from "./coin-market-history";
import { parseCoinCandlePage } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { candleFixtureBody } from "../../../../../../../../packages/core/test/fixtures/modules/launchpad-coin/chart-fixtures.ts";
import { chartVisual } from "./chart-visual";

const asset = {
  chain: "sui",
  network: "mainnet",
  coin_type: `0x${"2".repeat(64)}::coin::A`,
  presale_id: null,
} as const;
const now = Date.now();
const body = (): Record<string, unknown> => {
  const page = candleFixtureBody("curve", "live", { interval: "1m" }, now);
  return {
    ...page,
    provenance: { ...(page.provenance as object), network: "mainnet" },
  };
};

test("coin candle contract keeps true OHLC and integer volume; malformed trades, interval and ordering are refused", () => {
  const wire = body();
  const page = parseCoinCandlePage(asset.coin_type, "1m", wire);
  assert.equal(page.candles[0]!.volumeQuote, 5_000_000_000n);
  assert.equal(page.candles[0]!.open, "0.0025");
  assert.equal(page.candles[0]!.high, "0.0026");
  const rows = wire.candles as object[];
  for (const change of [
    { high: "0.0001" },
    { trades: 0 },
    { volume_quote: "2.5" },
    { interval: "1s" },
  ]) {
    assert.throws(() =>
      parseCoinCandlePage(asset.coin_type, "1m", {
        ...wire,
        candles: [{ ...rows[0], ...change }],
      }),
    );
  }
  assert.throws(() =>
    parseCoinCandlePage(asset.coin_type, "1m", {
      ...wire,
      candles: [...rows].reverse(),
    }),
  );
});

test("production candle reader stays same-origin, binds the network, propagates cancellation and preserves a successful empty page", async () => {
  const original = globalThis.fetch;
  const requests: URL[] = [];
  let network = "mainnet";
  let empty = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://blast.test");
    requests.push(url);
    if (!url.pathname.endsWith("/candles"))
      return Response.json({}, { status: 503 });
    const page = body();
    return Response.json({
      ...page,
      provenance: { ...(page.provenance as object), network },
      ...(empty ? { candles: [] } : {}),
    });
  };
  try {
    const signal = new AbortController().signal;
    const history = await coinMarketHistory(asset, "1h", signal, "1m");
    assert.equal(history?.kind, "market");
    assert.equal(history?.page.candles[0]!.volumeQuote, 5_000_000_000n);
    assert.match(
      requests[0]!.pathname,
      /^\/api\/launchpad\/market\/coins\/.+\/candles$/,
    );
    assert.equal(requests[0]!.searchParams.get("interval"), "1m");
    assert.ok(requests[0]!.searchParams.has("from"));
    assert.equal(
      history?.decimals,
      null,
      "missing metadata cannot imply USD or known decimals",
    );
    network = "testnet";
    assert.equal(await coinMarketHistory(asset, "1h", signal, "1m"), null);
    network = "mainnet";
    empty = true;
    assert.deepEqual(
      (await coinMarketHistory(asset, "1h", signal, "1m"))?.page.candles,
      [],
      "a successful empty read stays empty",
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(
      coinMarketHistory(asset, "1h", controller.signal, "1m"),
      /cancelled/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("candle geometry includes wicks beyond closes while same-bucket pool observations retain exact volume", () => {
  const visual = chartVisual(
    [
      {
        at: 0,
        value: "1.00000000000000000002",
        source: "curve",
        candle: { open: "1", low: "0.5", high: "3" },
        volume: "2.000000000000000001",
      },
      {
        at: 0,
        value: "2",
        source: "venue",
        candle: { open: "1.00000000000000000002", low: "0.75", high: "4" },
        volume: "7",
      },
    ],
    60_000,
  )!;
  assert.equal(visual.ticks[0]!.value, "4");
  assert.equal(visual.ticks.at(-1)!.value, "0.5");
  assert.deepEqual(
    visual.segments.map((segment) => segment[0]!.volume),
    ["2.000000000000000001", "7"],
  );
  assert.equal(visual.coordinate("4"), 282);
  assert.equal(visual.coordinate("0.5"), 18);
});

test("the streamed USD price is the catalog's: mark × 10^(meme − quote decimals) × Pyth price × 10^expo, every digit kept", () => {
  // A trade frame's pool summary as blast-infra writes it (FROGGY on SUI, the partner gate's recorded pool),
  // and the catalog's `trim_scale(mark * 1e(6 - 9) * 345210000 * 1e-8)` for the same inputs.
  const summary = { quote: "0x2::sui::SUI", price: "0.002528735632183908045977011494252873", inputs: { meme_decimals: "6", quote_decimals: "9" }, quote_usd: { price: "345210000", expo: -8, publish_time: 1790235060, age_ms: 1218 } };
  const quote = tradeQuote(summary)!;
  assert.deepEqual(quote, { quote: "0x2::sui::SUI", price: "0.002528735632183908045977011494252873", memeDecimals: 6, quoteDecimals: 9, quoteUsd: "3.4521" });
  assert.equal(estimateUsdPrice(quote.price!, quote.memeDecimals, quote.quoteDecimals, quote.quoteUsd!), "0.0000087294482758620689655172413793103428833");
  // Meme decimals above the quote's scale the price up; an unlisted quote (Test SUI) carries no USD stamp.
  assert.equal(estimateUsdPrice("2", 9, 6, "1.5"), "3000");
  assert.equal(tradeQuote({ ...summary, quote_usd: null })?.quoteUsd, null);
  assert.equal(tradeQuote({ ...summary, inputs: { meme_decimals: "6", quote_decimals: null } }), null, "unknown quote decimals cannot be priced");
  assert.equal(tradeQuote({ ...summary, inputs: { meme_decimals: 6, quote_decimals: 9 } }), null, "decimals are digit strings on the wire");
});
