import assert from "node:assert/strict";
import test from "node:test";

import type { TradeRoute } from "@blast/server/modules/social/trades/aggregator.ts";
import { AGGREGATOR_PACKAGE, SALE_B, SALE_B_POOL, SENDER, SUI, USDC } from "../../../../test/fixtures/modules/social/trades/fixtures.ts";
import { openTradeQuote, sealTradeQuote, TRADE_QUOTE_ID_MAX_LENGTH, tradeQuoteKey, type SealedTradeQuote } from "@blast/server/modules/social/trades/quote-token.ts";

/**
 * Social feed R3-30: the `quote_id` is the offered quote sealed — opaque,
 * bound to the account, the wallet and the route, and refused when edited.
 */

const KEY = tradeQuoteKey("trade-quote-fixture-pepper-0123456789abcdef");

function leg(n: number) {
  return {
    poolId: SALE_B_POOL,
    provider: n % 2 ? "BLUEFIN" : "CETUS",
    direction: n % 2 === 0,
    from: n === 0 ? USDC : SUI,
    target: SALE_B,
    feeRate: "0.0025",
    amountIn: 18_000_000_000_000_000_000n - BigInt(n),
    amountOut: 332_001_975_262_684_891n,
    publishedAt: AGGREGATOR_PACKAGE,
  };
}

function quote(paths = 1): SealedTradeQuote {
  const route: TradeRoute = {
    requestId: "d2e1e029-8fe6-4f7b-bce6-121e755eaa00",
    amountIn: 100_000_000n,
    amountOut: 332_001_975_262_684_891n,
    paths: Array.from({ length: paths }, (_, n) => leg(n)),
    aggregatorPackage: AGGREGATOR_PACKAGE,
    deviationRatio: "",
    blastFee: 1_668_351_634_485_853n,
  };
  return {
    accountId: "00000000-0000-4000-8000-000000000001",
    sender: SENDER,
    side: "buy",
    inCoin: SUI,
    outCoin: SALE_B,
    amountIn: 100_000_000n,
    amountOut: 332_001_975_262_684_891n,
    minOut: 330_341_965_386_371_466n,
    slippageBps: 50,
    priceImpactBps: 8_233,
    blastFeeBps: 50,
    issuedAtMs: 1_791_000_000_000,
    expiresAtMs: 1_791_000_020_000,
    route,
  };
}

test("a sealed quote opens to exactly what was sealed, u64 amounts included", () => {
  const sealed = sealTradeQuote(KEY, quote(3));
  assert.match(sealed, /^q1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(openTradeQuote(KEY, sealed), quote(3));
  assert.notEqual(sealTradeQuote(KEY, quote(3)), sealed, "a fresh nonce each time");
});

test("the price impact a quote showed is sealed with it (OA-29); one sealed before it opens with none", () => {
  assert.equal(openTradeQuote(KEY, sealTradeQuote(KEY, { ...quote(), priceImpactBps: null }))!.priceImpactBps, null);
  assert.equal(openTradeQuote(KEY, sealTradeQuote(KEY, { ...quote(), priceImpactBps: 10_000 }))!.priceImpactBps, 10_000);
  // A quote id issued before the impact was sealed has no such field; it still opens within its 20 s.
  const before = { ...quote() } as Record<string, unknown>;
  delete before.priceImpactBps;
  assert.deepEqual(openTradeQuote(KEY, sealTradeQuote(KEY, before as SealedTradeQuote)), { ...quote(), priceImpactBps: null });
  // An impact out of range is not one this service sealed.
  for (const bad of [10_001, -1, 1.5]) assert.equal(openTradeQuote(KEY, sealTradeQuote(KEY, { ...quote(), priceImpactBps: bad })), null, String(bad));
});

test("Blast's fee rate and amount are sealed with the quote; one sealed before the fee opens at 0 bps", () => {
  const opened = openTradeQuote(KEY, sealTradeQuote(KEY, quote()))!;
  assert.deepEqual([opened.blastFeeBps, opened.route.blastFee], [50, 1_668_351_634_485_853n]);
  assert.equal(openTradeQuote(KEY, sealTradeQuote(KEY, { ...quote(), blastFeeBps: 0 }))!.blastFeeBps, 0);
  const before = { ...quote(), route: { ...quote().route, blastFee: 0n } } as Record<string, unknown>;
  delete before.blastFeeBps;
  assert.equal(openTradeQuote(KEY, sealTradeQuote(KEY, before as SealedTradeQuote))!.blastFeeBps, 0, "the swap then refuses it under a fee");
  for (const bad of [1_001, -1, 0.5]) assert.equal(openTradeQuote(KEY, sealTradeQuote(KEY, { ...quote(), blastFeeBps: bad })), null, String(bad));
});

test("an edited, foreign or malformed quote id does not open", () => {
  const sealed = sealTradeQuote(KEY, quote());
  const flip = (text: string, at: number) => `${text.slice(0, at)}${text[at] === "A" ? "B" : "A"}${text.slice(at + 1)}`;
  assert.equal(openTradeQuote(KEY, flip(sealed, 10)), null, "an edited nonce");
  assert.equal(openTradeQuote(KEY, flip(sealed, sealed.length - 5)), null, "an edited tag");
  assert.equal(openTradeQuote(KEY, flip(sealed, 40)), null, "edited content");
  assert.equal(openTradeQuote(tradeQuoteKey("another-instance-pepper-0123456789abcdefgh"), sealed), null, "another key");
  for (const bad of ["", "q1.", "q2.abc", sealed.slice(3), "q1.!!!!", `q1.${"A".repeat(TRADE_QUOTE_ID_MAX_LENGTH)}`]) {
    assert.equal(openTradeQuote(KEY, bad), null, bad.slice(0, 12));
  }
});

test("the longest offered route seals within the swap request's room", () => {
  assert.ok(sealTradeQuote(KEY, quote(8)).length < TRADE_QUOTE_ID_MAX_LENGTH);
  assert.throws(() => tradeQuoteKey("short"));
});
