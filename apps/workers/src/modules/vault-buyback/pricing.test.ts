import assert from "node:assert/strict";
import test from "node:test";

import {
  PRICE_SCALE,
  atomsWorth,
  decideBuyback,
  minimumMemeOut,
  quoteCap,
  scaledPrice,
  twapPrice,
  withinTolerance,
  worthAtLeast,
  type BuybackFacts,
} from "./pricing.ts";

const MINUTE = 60_000;
const scaled = (price: string) => scaledPrice(price);
/** The owner's defaults: $50, 1% of the pool's Quote, 10% slippage. */
const POLICY = { minUsdCents: 5_000n, maxPoolShareBps: 100n, slippageBps: 1_000n };
/** SUI at $3.50 (Pyth-style: 350000000 × 10^-8), 9 decimals. */
const SUI_USD = { price: 350_000_000n, expo: -8, decimals: 9 };
const REFERENCE = scaled("0.0025");

function facts(overrides: Partial<BuybackFacts> = {}): BuybackFacts {
  return {
    heldQuote: 20_000_000_000n, // 20 SUI = $70
    poolQuote: 10_000_000_000_000n, // 10,000 SUI: the cap is 100 SUI
    spot: { numerator: 25n, denominator: 10_000n }, // 0.0025
    reference: { status: "fresh", price: REFERENCE },
    quoteUsd: SUI_USD,
    ...overrides,
  };
}

test("the reference is a time-weighted step over the window's 1m closes, seeded by the previous close", () => {
  const start = 100 * MINUTE;
  const end = start + 30 * MINUTE;
  // Before the window the price closed at 1; it trades at 4 for the last 10 minutes.
  const candles = [
    { bucketStart: start - 5 * MINUTE, open: "1", close: "1" },
    { bucketStart: start + 20 * MINUTE, open: "1", close: "4" },
  ];
  assert.equal(twapPrice(candles, start, end), scaled("2")); // (20×1 + 10×4) / 30
  // No candle before the window: the first candle's open is the previous close.
  assert.equal(twapPrice([{ bucketStart: start + 20 * MINUTE, open: "1", close: "4" }], start, end), scaled("2"));
  // No trade in the window: the last close held all along.
  assert.equal(twapPrice([{ bucketStart: start - 60 * MINUTE, open: "3", close: "5" }], start, end), scaled("5"));
  // One manipulated last minute moves a 30-minute reference by a thirtieth.
  const spike = [...candles.slice(0, 1), { bucketStart: end - MINUTE, open: "1", close: "31" }];
  assert.equal(twapPrice(spike, start, end), scaled("2"));
  assert.equal(twapPrice([], start, end), null);
});

test("a deviation under the tolerance is ignored; at the tolerance or beyond, on either side, it is not", () => {
  const at = (numerator: bigint, denominator: bigint) => withinTolerance({ numerator, denominator }, scaled("1"), 1_000n);
  assert.equal(at(10_999n, 10_000n), true);
  assert.equal(at(9_001n, 10_000n), true);
  assert.equal(at(110n, 100n), false);
  assert.equal(at(90n, 100n), false);
  assert.equal(at(1_101n, 1_000n), false);
});

test("min_meme_out is the Quote at the reference less the tolerance, rounded down", () => {
  // 20 SUI at 0.0025 SUI atoms per Meme atom buys 8e12 Meme atoms; less 10%: 7.2e12.
  assert.equal(minimumMemeOut(20_000_000_000n, REFERENCE, 1_000n), 7_200_000_000_000n);
  assert.equal(minimumMemeOut(3n, scaled("2"), 0n), 1n);
  assert.equal(quoteCap(10_000_000_000_000n, 100n), 100_000_000_000n);
});

test("the $50 minimum uses the Quote's decimals and the price's exponent exactly", () => {
  // 14.285714286 SUI at $3.50 is $50.0000000001; one atom less is under $50.
  assert.equal(atomsWorth(5_000n, SUI_USD), MIN_PIECE);
  assert.equal(worthAtLeast(MIN_PIECE, SUI_USD, 5_000n), true);
  assert.equal(worthAtLeast(MIN_PIECE - 1n, SUI_USD, 5_000n), false);
  // USDC: 6 decimals, $1.00 as 100000000 × 10^-8.
  const usdc = { price: 100_000_000n, expo: -8, decimals: 6 };
  assert.equal(atomsWorth(5_000n, usdc), 50_000_000n);
  assert.equal(worthAtLeast(50_000_000n, usdc, 5_000n), true);
  assert.equal(worthAtLeast(49_999_999n, usdc, 5_000n), false);
  // A positive exponent: one atom is worth $50.
  assert.equal(atomsWorth(5_000n, { price: 5n, expo: 1, decimals: 0 }), 1n);
});

/** The draw's two extremes, standing in for the CSPRNG. */
const lowest = (low: bigint) => low;
const highest = (_low: bigint, high: bigint) => high;
/** $50 of SUI at $3.50. */
const MIN_PIECE = 14_285_714_286n;

test("a piece is drawn between the $50 minimum and min(waiting Quote, 1% of the pool), and floored at the reference less 10%", () => {
  // 20 SUI waiting, a 10,000 SUI pool (cap 100 SUI): the piece is at most the 20 SUI waiting.
  assert.deepEqual(decideBuyback(facts(), POLICY, highest), {
    kind: "buy",
    quoteIn: 20_000_000_000n,
    minMemeOut: 7_200_000_000_000n,
    minPiece: MIN_PIECE,
    maxPiece: 20_000_000_000n,
  });
  // The smallest piece: $50 of SUI, floored at 360 Meme atoms per SUI atom (0.0025 less 10%).
  assert.deepEqual(decideBuyback(facts(), POLICY, lowest), {
    kind: "buy",
    quoteIn: MIN_PIECE,
    minMemeOut: MIN_PIECE * 360n,
    minPiece: MIN_PIECE,
    maxPiece: 20_000_000_000n,
  });
  // 100 SUI waiting in a 3,000 SUI pool: the cap (30 SUI) bounds a partial piece; the rest waits.
  const capped = decideBuyback(facts({ heldQuote: 100_000_000_000n, poolQuote: 3_000_000_000_000n }), POLICY, highest);
  assert.deepEqual(capped, { kind: "buy", quoteIn: 30_000_000_000n, minMemeOut: 10_800_000_000_000n, minPiece: MIN_PIECE, maxPiece: 30_000_000_000n });
  // The draw sees exactly those bounds.
  const seen: bigint[][] = [];
  decideBuyback(facts({ heldQuote: 100_000_000_000n, poolQuote: 3_000_000_000_000n }), POLICY, (low, high) => {
    seen.push([low, high]);
    return low + 7n;
  });
  assert.deepEqual(seen, [[MIN_PIECE, 30_000_000_000n]]);
  assert.throws(() => decideBuyback(facts(), POLICY, () => 1n), RangeError, "a draw outside its bounds never buys");
});

test("the decision applies the owner's checks in order", () => {
  const skip = (overrides: Partial<BuybackFacts>) => decideBuyback(facts(overrides), POLICY, highest);
  assert.deepEqual(skip({ heldQuote: 0n }), { kind: "skip", reason: "nothing-held", until: "tomorrow" });
  // Under $50 waiting: waits for later collections.
  assert.deepEqual(skip({ heldQuote: MIN_PIECE - 1n }), { kind: "skip", reason: "below-minimum", until: "tomorrow" });
  assert.equal(skip({ heldQuote: MIN_PIECE }).kind, "buy");
  assert.deepEqual(skip({ quoteUsd: null }), { kind: "skip", reason: "usd-unavailable", until: "retry" });
  // 1% of a 1,000 SUI pool is 10 SUI, under a $50 piece: too thin today, never a sub-minimum piece.
  assert.deepEqual(skip({ poolQuote: 1_000_000_000_000n }), { kind: "skip", reason: "pool-too-thin", until: "tomorrow" });
  // A balance far above the cap still buys, one capped piece at a time.
  assert.equal(skip({ heldQuote: 10n ** 15n }).kind, "buy");
  // A stale or missing reference never buys.
  assert.deepEqual(skip({ reference: { status: "stale" } }), { kind: "skip", reason: "reference-stale", until: "retry" });
  assert.deepEqual(skip({ reference: { status: "unavailable" } }), { kind: "skip", reason: "reference-unavailable", until: "retry" });
  // Spot exactly 10% above or below the reference: refused; 9.6% off: ignored, bought.
  assert.deepEqual(skip({ spot: { numerator: 275n, denominator: 100_000n } }), { kind: "skip", reason: "price-deviation", until: "retry" });
  assert.deepEqual(skip({ spot: { numerator: 225n, denominator: 100_000n } }), { kind: "skip", reason: "price-deviation", until: "retry" });
  assert.equal(skip({ spot: { numerator: 274n, denominator: 100_000n } }).kind, "buy");
  assert.equal(skip({ spot: { numerator: 226n, denominator: 100_000n } }).kind, "buy");
  // Another configured tolerance moves both the deviation limit and the floor.
  assert.deepEqual(decideBuyback(facts({ spot: { numerator: 274n, denominator: 100_000n } }), { ...POLICY, slippageBps: 500n }, highest), {
    kind: "skip",
    reason: "price-deviation",
    until: "retry",
  });
  assert.equal((decideBuyback(facts(), { ...POLICY, slippageBps: 500n }, highest) as { minMemeOut: bigint }).minMemeOut, 7_600_000_000_000n);
  // A price so high the piece buys nothing: never a zero floor.
  assert.deepEqual(skip({ reference: { status: "fresh", price: 10n ** 20n * PRICE_SCALE }, spot: { numerator: 10n ** 20n, denominator: 1n } }), {
    kind: "skip",
    reason: "min-out-zero",
    until: "tomorrow",
  });
});
