import assert from "node:assert/strict";
import { test } from "node:test";

import type { TradeRoute, TradeRouteRequest } from "@blast/core/modules/social/trades/cetus-route.ts";
import { SOCIAL_TRADE_BASE_COINS, type SocialTradeQuote, type SocialTradeQuoteRequest } from "@blast/core/web/contracts/trades.ts";

import { tradeEstimateReader, usdPriceText, type EstimateCoin } from "./trade-estimate.ts";
import type { TradeQuoteRead } from "./trade-quotes.ts";

const MEME = `0x${"ab".repeat(32)}::meme::MEME`;
const USDC: EstimateCoin = { coinType: SOCIAL_TRADE_BASE_COINS.usdc, symbol: "USDC", decimals: 6, price: 1 };
const COIN: EstimateCoin = { coinType: MEME, symbol: "MEME", decimals: 9, price: 0.000_000_5 };
const REQUEST: SocialTradeQuoteRequest = { side: "buy", in_coin: USDC.coinType, out_coin: MEME, amount_in: "10000000", slippage_bps: 100 };

const route: TradeRoute = {
  requestId: "r",
  amountIn: 10_000_000n,
  amountOut: 19_900_000_000_000n,
  paths: [{ poolId: "0x1", provider: "CETUS", direction: true, from: USDC.coinType, target: MEME, feeRate: "0.0025", amountIn: 10_000_000n, amountOut: 20_000_000_000_000n, publishedAt: "0x2" }],
  aggregatorPackage: "0x3",
  deviationRatio: "0.003",
  blastFee: 100_000_000_000n,
};

/** The server's answer, offered: the estimate shows it without its id. */
const offered = { status: "ok" as const, quote: { quote_id: "q1", expires_at_ms: 1, amount_out: "7" } as unknown as SocialTradeQuote };

function reader(coins: readonly EstimateCoin[], answer: Awaited<ReturnType<Parameters<typeof tradeEstimateReader>[0]["findRoute"]>>) {
  const asked: TradeRouteRequest[] = [];
  const served: SocialTradeQuoteRequest[] = [];
  const fallback: TradeQuoteRead = async (request) => (served.push(request), offered);
  const read = tradeEstimateReader({ findRoute: async (request) => (asked.push(request), answer), coins, fallback });
  return { read, asked, served };
}

test("a routed pair is priced in the browser and never offered", async () => {
  const { read, asked, served } = reader([USDC, COIN], { status: "route", route });
  const answer = await read(REQUEST);
  assert.equal(answer.status, "ok");
  const quote = (answer as { quote: SocialTradeQuote }).quote;
  assert.deepEqual(asked.map(({ from, target, amount, byAmountIn }) => ({ from, target, amount, byAmountIn })), [{ from: USDC.coinType, target: MEME, amount: 10_000_000n, byAmountIn: true }]);
  assert.equal(served.length, 0);
  assert.equal(quote.quote_id, null);
  assert.equal(quote.amount_out, "19900000000000");
  assert.equal(quote.min_out, "19701000000000");
  assert.equal(quote.blast_fee_amount, "100000000000");
  assert.equal(quote.amount_in_usd, "10.00");
  assert.equal(quote.route_label?.includes("MEME"), true);
});

test("the server answers, shown only, where the browser cannot route", async () => {
  const aftermath = { ...COIN, presale: { venue: "aftermath" } };
  for (const [coins, answer] of [
    [[USDC, aftermath], { status: "route", route }],
    [[USDC], { status: "route", route }],
    [[USDC, COIN], { status: "no_route" }],
  ] as const) {
    const { read, served } = reader(coins, answer);
    const shown = await read(REQUEST);
    assert.equal(served.length, 1);
    assert.equal(shown.status === "ok" && shown.quote.quote_id, null);
    assert.equal(shown.status === "ok" && shown.quote.expires_at_ms, null);
  }
  const { read, served } = reader([USDC, COIN], { status: "unavailable", reason: "aborted" });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await read(REQUEST, controller.signal), { status: "error" });
  assert.equal(served.length, 0);
});

test("a USD price is a plain decimal", () => {
  assert.equal(usdPriceText(0.000_000_5), "0.0000005");
  assert.equal(usdPriceText(1), "1");
  assert.equal(usdPriceText(null), null);
  assert.equal(usdPriceText(Number.NaN), null);
});
