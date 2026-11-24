import assert from "node:assert/strict";
import test from "node:test";

import { SOCIAL_TRADE_BASE_COINS } from "@blast/core/modules/social/contracts/trades.ts";
import {
  fractionBps,
  impactFromDeviation,
  minOut,
  parseDecimal,
  routeFeeFraction,
  routeLabel,
  scaleAtoms,
  venueOf,
  type RouteLeg,
} from "@blast/core/modules/social/trades/amounts.ts";

const SUI = SOCIAL_TRADE_BASE_COINS.sui;
const USDC = SOCIAL_TRADE_BASE_COINS.usdc;
const MRDN = "0x00000000000000000000000000000000000000000000000000000000000a11ce::mrdn::MRDN";
const SCA = "0x7016aae72cfc67f2fadf55769c0a7dd54291a583b63051a5ed71081cce836ac6::sca::SCA";
const SYMBOLS = new Map([[SUI, "SUI"], [USDC, "USDC"], [MRDN, "MRDN"]]);
const ZERO_FEE = { n: 0n, d: 1n };

test("min_out is the least whole-atom payout within the tolerance (R3-30-AC-4)", () => {
  assert.equal(minOut(1_000_000n, 50), 995_000n);
  assert.equal(minOut(1_000_000n, 10), 999_000n);
  assert.equal(minOut(332_001_975_262_684_891n, 50), 330_341_965_386_371_467n);
  assert.equal(minOut(332_001_975_262_684_891n, 10), 331_669_973_287_422_207n);
  assert.equal(minOut(1n, 50), 1n);
  assert.equal(minOut(199n, 50), 199n);
  assert.equal(minOut(200n, 50), 199n);
  assert.throws(() => minOut(1n, 10_000));
  assert.throws(() => minOut(1n, 1.5));
});

test("decimals parse exactly, signed, and nothing else does", () => {
  assert.deepEqual(parseDecimal("0.0001"), { n: 1n, d: 10_000n });
  assert.deepEqual(parseDecimal("-0.00061442"), { n: -61_442n, d: 100_000_000n });
  assert.deepEqual(parseDecimal("12"), { n: 12n, d: 1n });
  for (const bad of ["", "1e-7", "0x10", ".5", "1.", "--1", "NaN"]) assert.equal(parseDecimal(bad), null, bad);
});

test("the fee of one hop is its rate; hops in series compound; split legs weigh by their flow", () => {
  const one: RouteLeg[] = [{ from: SUI, target: MRDN, feeRate: "0.01", amountIn: 100n, amountOut: 990n }];
  const oneFee = routeFeeFraction(one, SUI, 100n, MRDN)!;
  assert.equal(fractionBps(oneFee), 100);
  assert.equal(scaleAtoms(100_000_000n, oneFee), 1_000_000n);

  // 1% then 0.25%: 1 − 0.99 × 0.9975 = 1.2475% → 125 bps.
  const series: RouteLeg[] = [
    { from: USDC, target: SUI, feeRate: "0.0025", amountIn: 1_000_000n, amountOut: 3_990_000_000n },
    { from: SUI, target: MRDN, feeRate: "0.01", amountIn: 3_990_000_000n, amountOut: 5_000_000n },
  ];
  assert.equal(fractionBps(routeFeeFraction(series, USDC, 1_000_000n, MRDN)!), 125);

  // Half through a 1% pool, half through a 0.01% pool, both straight to the target: 0.505%.
  const split: RouteLeg[] = [
    { from: SUI, target: USDC, feeRate: "0.01", amountIn: 500n, amountOut: 495_000n },
    { from: SUI, target: USDC, feeRate: "0.0001", amountIn: 500n, amountOut: 499_950n },
  ];
  const splitFee = routeFeeFraction(split, SUI, 1_000n, USDC)!;
  assert.equal(fractionBps(splitFee), 51);
  assert.equal(scaleAtoms(1_000_000n, splitFee), 5_050n);

  assert.equal(routeFeeFraction([{ ...one[0]!, feeRate: "1" }], SUI, 100n, MRDN), null, "a 100% fee is not a fee");
  assert.equal(routeFeeFraction([{ ...one[0]!, from: USDC }], SUI, 100n, MRDN), null, "a leg from nowhere");
  assert.equal(routeFeeFraction(one, SUI, 100n, USDC), null, "a route that misses the target");
});

test("impact is the aggregator's own deviation net of the route's fees, never a price of ours (OA-27; R3-30-AC-3 as OA-27 leaves it)", () => {
  // The recorded 1 SUI → 1.189711 USDC: the aggregator put it 0.061442% under its market, over 1 bp of venue fees.
  const fee = routeFeeFraction(
    [
      { from: SUI, target: SCA, feeRate: "0.00001", amountIn: 1_000_000_000n, amountOut: 962_706_345n },
      { from: SCA, target: USDC, feeRate: "0.0001", amountIn: 962_706_345n, amountOut: 1_189_711n },
    ],
    SUI,
    1_000_000_000n,
    USDC,
  )!;
  assert.equal(fractionBps(fee), 1);
  assert.equal(impactFromDeviation("-0.00061442", fee), 5);
  // A bigger shortfall is a bigger impact; a fill exactly the fees under the market has none; a better one never goes negative.
  assert.equal(impactFromDeviation("-0.0012", fee), 11);
  assert.equal(impactFromDeviation("-0.0001", parseDecimal("0.0001")!), 0);
  assert.equal(impactFromDeviation("0.13907456", fee), 0);
  assert.equal(impactFromDeviation("-0.25", ZERO_FEE), 2_500);
  // No market price at the aggregator (every new Blast sale coin): no impact, and nothing stands in for it.
  assert.equal(impactFromDeviation("", fee), null);
  assert.equal(impactFromDeviation(null, fee), null);
  assert.equal(impactFromDeviation("abc", fee), null);
});

test("the route string is the gate's: one hop, two hops through Sui pools, and SUI to USDC", () => {
  const cetus = "cetus";
  assert.equal(
    routeLabel([{ from: USDC, target: MRDN, feeRate: "0.01", amountIn: 100n, amountOut: 1_000n, venue: cetus }], USDC, MRDN, SYMBOLS),
    "USDC → MRDN · Cetus",
  );
  assert.equal(
    routeLabel(
      [
        { from: SUI, target: USDC, feeRate: "0.0001", amountIn: 100n, amountOut: 400n, venue: "bluefin" },
        { from: USDC, target: MRDN, feeRate: "0.01", amountIn: 400n, amountOut: 1_000n, venue: cetus },
      ],
      SUI,
      MRDN,
      SYMBOLS,
    ),
    "SUI → USDC → MRDN · Sui pools and Cetus",
  );
  // An intermediate Blast does not list (the aggregator's choice) is left out of the coins, not the venues.
  assert.equal(
    routeLabel(
      [
        { from: SUI, target: SCA, feeRate: "0.00001", amountIn: 100n, amountOut: 90n, venue: "bluefin" },
        { from: SCA, target: USDC, feeRate: "0.0001", amountIn: 90n, amountOut: 1n, venue: "bluefin" },
      ],
      SUI,
      USDC,
      SYMBOLS,
    ),
    "SUI → USDC · Sui pools",
  );
  // The main path follows the largest leg at each coin.
  assert.equal(
    routeLabel(
      [
        { from: SUI, target: SCA, feeRate: "0.00001", amountIn: 10n, amountOut: 9n, venue: "cetus" },
        { from: SUI, target: USDC, feeRate: "0.0001", amountIn: 90n, amountOut: 300n, venue: "bluefin" },
        { from: SCA, target: MRDN, feeRate: "0.01", amountIn: 9n, amountOut: 10n, venue: "bluefin" },
        { from: USDC, target: MRDN, feeRate: "0.01", amountIn: 300n, amountOut: 900n, venue: "bluefin" },
      ],
      SUI,
      MRDN,
      SYMBOLS,
    ),
    "SUI → USDC → MRDN · Sui pools and Bluefin",
  );
  assert.equal(routeLabel([{ from: SUI, target: USDC, feeRate: "0", amountIn: 1n, amountOut: 1n, venue: cetus }], SUI, MRDN, SYMBOLS), null);
  assert.equal(venueOf("CETUSDLMM"), "cetus");
  assert.equal(venueOf("BLUEFIN"), "bluefin");
  assert.equal(venueOf("MOMENTUM"), "momentum");
});

test("atom math stays exact above the safe integer range and fees round only at half a basis point", () => {
  const maximum = 18_446_744_073_709_551_615n;
  assert.equal(minOut(maximum, 50), 18_354_510_353_341_003_857n);
  assert.equal(
    scaleAtoms(maximum, { n: 1n, d: 10n }),
    1_844_674_407_370_955_161n,
  );
  assert.equal(scaleAtoms(9n, { n: 1n, d: 10n }), 0n);
  assert.equal(
    scaleAtoms(maximum, { n: 1n, d: 2n }),
    9_223_372_036_854_775_807n,
  );
  for (const [rate, expected] of [
    ["0.000049999999999999999999999999999999", 0],
    ["0.00005", 1],
    ["0.000050000000000000000000000000000001", 1],
  ] as const) {
    assert.equal(fractionBps(parseDecimal(rate)!), expected, rate);
  }
});
