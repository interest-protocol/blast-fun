import assert from "node:assert/strict";
import test from "node:test";

import type { TradeRoute } from "@blast/server/modules/social/trades/aggregator.ts";
import { dryRunVerdict } from "@blast/server/modules/social/trades/chain.ts";
import { AGGREGATOR_PACKAGE, dryRunRecording, recordedDryRun, replayRouter, SALE_B, SENDER, SUI, USDC } from "../../../../test/fixtures/modules/social/trades/fixtures.ts";
import { impactFromReference, referenceAmountIn, referenceRoute } from "@blast/server/modules/social/trades/reference.ts";

/**
 * Social feed OA-29: a sale coin's price impact from a second dry run of the
 * same route at a reference size. The size rule, the route it runs, and the
 * exact arithmetic over real mainnet dry runs (`fixtures/dry-runs.json`: the
 * recorded routes simulated on the mainnet fullnode at both sizes).
 */

async function recordedRoute(from: string, target: string, amount: bigint): Promise<TradeRoute> {
  const answer = await replayRouter().router.findRoute({ from, target, amount, byAmountIn: true });
  if (answer.status !== "route") throw new Error("no recorded route");
  return answer.route;
}

/** What a recorded dry run gave its sender in `outCoin`, read the way the quote service reads it. */
function received(name: string, outCoin: string): bigint {
  const verdict = dryRunVerdict(recordedDryRun(name), { aggregatorPackage: AGGREGATOR_PACKAGE, sender: SENDER, outCoin });
  assert.equal(verdict.status, "passed", name);
  return (verdict as { received: bigint }).received;
}

test("the reference is 1% of the trade, at least 100,000 atoms in and expected out, and at most a tenth of the trade", () => {
  // 0.1 SUI for SALE_B (the recorded route): 1% is 0.001 SUI.
  assert.equal(referenceAmountIn(100_000_000n, 332_001_975_262_684_891n), 1_000_000n);
  // ⌈1% ⌉, never rounded down to below it.
  assert.equal(referenceAmountIn(10_000_001n, 10n ** 18n), 100_001n);
  // 1 USDC: 1% is 10,000 atoms, under the floor, so 100,000 — exactly a tenth, still measured.
  assert.equal(referenceAmountIn(1_000_000n, 389_820_224_645_925_583n), 100_000n);
  assert.equal(referenceAmountIn(999_999n, 389_820_224_645_925_583n), null, "the floor would be more than a tenth: too small");
  // Selling 0.1 of SALE_B for 3,982,156 MIST: 1% would expect 39,821 MIST out, under the floor, so enough in for 100,000 out.
  assert.equal(referenceAmountIn(100_000_000_000_000_000n, 3_982_156n), 2_511_202_474_237_574n);
  // The holder-sized sell recorded on mainnet expects 14,898 MIST in all: no reference above rounding fits in a tenth of it.
  assert.equal(referenceAmountIn(300_000_000_000_000n, 14_898n), null);
  assert.equal(referenceAmountIn(0n, 1n), null);
  assert.equal(referenceAmountIn(1n, 0n), null);
});

test("the reference route is the trade's own legs, in order, each scaled down: the same pools, directions and split", async () => {
  const usdc = await recordedRoute(USDC, SALE_B, 1_000_000n);
  const reference = referenceRoute(usdc, 100_000n, null)!;
  assert.deepEqual(
    reference.paths.map((path) => [path.poolId, path.provider, path.direction, path.from, path.target, path.feeRate, path.publishedAt]),
    usdc.paths.map((path) => [path.poolId, path.provider, path.direction, path.from, path.target, path.feeRate, path.publishedAt]),
  );
  assert.deepEqual(reference.paths.map((path) => [path.amountIn, path.amountOut]), [
    [100_000n, 80_934_799n],
    [80_934_799n, 84_068_324n],
    [84_068_324n, 38_982_022_464_592_558n],
  ]);
  assert.equal(reference.amountIn, 100_000n);
  assert.equal(reference.amountOut, 38_982_022_464_592_558n, "the trade's rate at the reference size, rounded down");
  assert.equal(reference.requestId, usdc.requestId);
  assert.equal(reference.aggregatorPackage, usdc.aggregatorPackage);

  // An 8-leg split stays the same split: every leg takes 1% of what it took.
  const split = await recordedRoute(SUI, USDC, 1_000_000_000n);
  const scaled = referenceRoute(split, 10_000_000n, null)!;
  assert.equal(scaled.paths.length, 8);
  for (const [at, path] of scaled.paths.entries()) assert.equal(path.amountIn, split.paths[at]!.amountIn / 100n);

  // A leg the scale would empty cannot run: too small, not a different route.
  const dusty = { ...split, paths: split.paths.map((path, at) => (at === 1 ? { ...path, amountIn: 50n } : path)) };
  assert.equal(referenceRoute(dusty, 10_000_000n, null), null);
  assert.equal(referenceRoute(split, split.amountIn, null), null, "the reference is smaller than the trade");
  assert.equal(referenceRoute(split, 0n, null), null);
});

test("the impact of recorded mainnet pairs: the trade's rate against the reference's, from the dry runs' own fills", () => {
  // 0.1 SUI → 332,001,975,262,684,891 SALE_B; 0.001 SUI → 18,793,099,960,001,698 (simulated on mainnet, same pool state).
  const trade = { amountIn: BigInt(dryRunRecording("sui-sale-b").amount_in), amountOut: received("sui-sale-b", SALE_B) };
  const reference = { amountIn: BigInt(dryRunRecording("sui-sale-b-reference").amount_in), amountOut: received("sui-sale-b-reference", SALE_B) };
  assert.deepEqual([trade.amountIn, trade.amountOut], [100_000_000n, 332_001_975_262_684_891n]);
  assert.deepEqual([reference.amountIn, reference.amountOut], [1_000_000n, 18_793_099_960_001_698n]);
  // 1 − (332,001,975,262,684,891 × 1,000,000) ÷ (18,793,099,960,001,698 × 100,000,000)
  //   = 1,547,308,020,737,484,909,000,000 ÷ 1,879,309,996,000,169,800,000,000 = 0.823338… → 8233 bp.
  // SALE_B's test pool is that thin: the trade fills at 17.7% of the reference's rate.
  assert.equal(impactFromReference(trade, reference), 8_233);

  // Doubling the trade on the same pool: a larger impact.
  const double = impactFromReference(
    { amountIn: 200_000_000n, amountOut: received("sui-sale-b-double", SALE_B) },
    { amountIn: 2_000_000n, amountOut: received("sui-sale-b-double-reference", SALE_B) },
  );
  assert.equal(double, 8_990);
});

test("a sell into SUI reads its fill from the SUI change with the gas added back, as mainnet's dry run shows it", () => {
  // 300,000,000,000,000 SALE_B in; the sender's SUI moved −774,574 MIST with 789,472 MIST of gas (100,000 + 11,012,400 − 10,322,928).
  assert.equal(received("sale-b-sui-small", SUI), 14_898n);
  assert.equal(received("sale-b-sui-small", SALE_B), -300_000_000_000_000n, "the coin it sold");
});

test("the route's fees net out: they cost both runs the same share, so a fee is never counted as impact", () => {
  // A constant-product pool, x · y = k, whose fee comes off the input first.
  const fill = (reserve: bigint, amountIn: bigint, feePercent: bigint) => {
    const effective = (amountIn * (100n - feePercent)) / 100n;
    return { amountIn, amountOut: (reserve * effective) / (reserve + effective) };
  };
  const impact = (reserve: bigint, feePercent: bigint) =>
    impactFromReference(fill(reserve, 100_000_000n, feePercent), fill(reserve, 1_000_000n, feePercent));
  // A pool deep enough that the trade moves nothing: 0 with a 1% fee, not the fee's 100 bp.
  assert.equal(impact(10n ** 18n, 0n), 0);
  assert.equal(impact(10n ** 18n, 1n), 0);
  // A pool the trade moves: the 1% fee leaves the impact where the price movement puts it (the fee only shrinks what reaches the pool).
  assert.equal(impact(10n ** 10n, 0n), 98);
  assert.equal(impact(10n ** 10n, 1n), 97);
});

test("rounding: half a basis point rounds up, less rounds down, a better fill is 0, and the most is 10000", () => {
  // n ÷ d = 20,000 ÷ 400,000,000 = exactly 0.5 bp.
  assert.equal(impactFromReference({ amountIn: 20_000n, amountOut: 19_999n }, { amountIn: 20_000n, amountOut: 20_000n }), 1);
  // 1 ÷ 20,001 = 0.49997… bp.
  assert.equal(impactFromReference({ amountIn: 1n, amountOut: 20_000n }, { amountIn: 1n, amountOut: 20_001n }), 0);
  // 1.5 bp → 2; 1.49… → 1.
  assert.equal(impactFromReference({ amountIn: 20_000n, amountOut: 19_997n }, { amountIn: 20_000n, amountOut: 20_000n }), 2);
  assert.equal(impactFromReference({ amountIn: 1n, amountOut: 1_000_000n }, { amountIn: 1n, amountOut: 1_000_149n }), 1);
  // The same rate, and a trade that fills better than its reference (rounding at the reference): never negative.
  assert.equal(impactFromReference({ amountIn: 100n, amountOut: 300n }, { amountIn: 1n, amountOut: 3n }), 0);
  assert.equal(impactFromReference({ amountIn: 100_000_000n, amountOut: 99_999_999n }, { amountIn: 1_000_000n, amountOut: 999_999n }), 0);
  // A fill at a billionth of the reference's rate rounds to all of it.
  assert.equal(impactFromReference({ amountIn: 1n, amountOut: 1n }, { amountIn: 1n, amountOut: 1_000_000_000n }), 10_000);
  // Nothing out of either run is no rate at all.
  assert.equal(impactFromReference({ amountIn: 1n, amountOut: 0n }, { amountIn: 1n, amountOut: 1n }), null);
  assert.equal(impactFromReference({ amountIn: 1n, amountOut: 1n }, { amountIn: 1n, amountOut: 0n }), null);
  assert.equal(impactFromReference({ amountIn: 0n, amountOut: 1n }, { amountIn: 1n, amountOut: 1n }), null);
});
