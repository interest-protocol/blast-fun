import assert from "node:assert/strict";
import test from "node:test";

import { exactAtoms, exactDecimal, exactNumber, numShortExact, pxNumExact, shortFloorExact } from "./exact-amount.ts";
import { qm, qp, qs, qsRaised, quoteOf, readsInCoin, short, raisedShort, usd, px, type SaleQuote } from "./format.ts";

/**
 * R3-40: every figure of a sale reads in its quote coin, from atoms and the
 * quote's decimals (AC-3), floored while filling (AC-4), with a USDC sale
 * unchanged (AC-2) and a dollar equivalent only with the SUI price row
 * (AC-5). The expected strings are the gate's own helpers' (`qm`, `qs`,
 * `qsRaised`, `qp`) on the same figures.
 */

const SUI: SaleQuote = { symbol: "SUI", decimals: 9 };
const USDC: SaleQuote = { symbol: "USDC", decimals: 6 };
/** A coin path with six decimals, to show nothing assumes nine. */
const SIX: SaleQuote = { symbol: "SUI", decimals: 6 };

const sui = (atoms: string) => ({ usd: null, atoms });
const dollars = (value: string) => ({ usd: value, atoms: null });

test("R3-40-AC-1: qm reads a SUI figure in SUI with its symbol, the gate's maximumFractionDigits 2", () => {
  assert.equal(qm(SUI, sui("25000000000")), "25 SUI");
  assert.equal(qm(SUI, sui("125000000000")), "125 SUI");
  assert.equal(qm(SUI, sui("125500000000")), "125.5 SUI");
  assert.equal(qm(SUI, sui("184221000000000")), "184,221 SUI");
  assert.equal(qm(SUI, sui("2930000000")), "2.93 SUI");
  assert.equal(qm(SUI, sui("0")), "0 SUI");
  assert.equal(qm(SUI, sui("not-atoms")), null, "a malformed figure is unknown, never 0");
  assert.equal(qm(SUI, { usd: "50.00", atoms: null }), null, "a SUI sale never falls back to its dollars");
});

test("R3-40-AC-3: atoms and the view's decimals give exact figures with 6- and 9-decimal quotes, where a float would not", () => {
  // 1.005 rounds half up to 1.01; `(1.005).toFixed(2)` is "1.00" in a float.
  assert.equal((1.005).toFixed(2), "1.00");
  assert.equal(qm(SUI, sui("1005000000")), "1.01 SUI");
  assert.equal(qm(SIX, sui("1005000")), "1.01 SUI");
  // 0.1 + 0.2 never appears: 0.3 SUI is 300,000,000 atoms.
  assert.equal(qm(SUI, sui("300000000")), "0.3 SUI");
  assert.equal(qm(SIX, sui("300000")), "0.3 SUI");
  // Past 2^53 atoms (9,007,199 SUI and change), still exact.
  assert.equal(qm(SUI, sui("9007199254740993001")), "9,007,199,254.74 SUI");
  assert.equal(Number("9007199254740993001") / 1e9, 9007199254.740993);
  assert.equal(qm(SIX, sui("9007199254740993001")), "9,007,199,254,740.99 SUI");
  // The same atoms with each decimals read 1,000× apart: nothing hard-codes nine.
  assert.equal(qm(SUI, sui("123456789000")), "123.46 SUI");
  assert.equal(qm(SIX, sui("123456789000")), "123,456.79 SUI");
  assert.deepEqual(exactAtoms("1000", 6), { n: 1000n, scale: 6 });
  assert.equal(exactAtoms("-1", 6), null);
  assert.equal(exactAtoms("1.5", 6), null);
});

test("R3-40-AC-3: compact and raised figures use the quote's decimals", () => {
  const target = sui("400000000000");
  assert.equal(qs(SIX, sui("399880000000")), "400K SUI");
  assert.equal(qsRaised(SIX, sui("399880000000"), target), "399K SUI");
  assert.equal(qsRaised(SIX, target, target), "400K SUI");
  assert.equal(qsRaised(SIX, sui("500000000000"), target), "500K SUI");
});

test("qs is the gate's numShort in the coin, short()'s figure named in USDC", () => {
  assert.equal(qs(SUI, sui("400000000000000")), "400K SUI");
  assert.equal(qs(SUI, sui("1250000000000000")), "1.25M SUI");
  assert.equal(qs(SUI, sui("1200000000000000")), "1.2M SUI");
  assert.equal(qs(SUI, sui("12500000000000")), "12.5K SUI");
  assert.equal(qs(SUI, sui("5000000000000")), "5K SUI");
  assert.equal(qs(SUI, sui("999000000000")), "999 SUI");
  assert.equal(qs(SUI, sui("999500000000")), "1,000 SUI", "Math.round(999.5).toLocaleString()");
  assert.equal(numShortExact(exactDecimal("99950")!), "100K", "the gate's toFixed(1) from 1e3 rounds into the next band, as it does");
  // Billions take a B, as the boards write them (`$1.84B`), never `1840M`.
  assert.equal(numShortExact(exactDecimal("1840000000")!), "1.84B");
  assert.equal(numShortExact(exactDecimal("2000000000")!), "2B");
  assert.equal(numShortExact(exactDecimal("999000000")!), "999M");
  assert.equal(qs(SUI, sui("1250000000000000000")), "1.25B SUI");
  // A USDC sale's money names its coin (owner, 2026-10-27): short()'s figure, without the dollar sign.
  assert.equal(qs(USDC, dollars("400000.00")), "400K USDC");
  assert.equal(qs(USDC, dollars("400000.00")), `${short(400_000).replace("$", "")} USDC`);
});

test("R3-40-AC-4: qsRaised floors in the sale's own coin, so a SUI raise at 99.97% never prints its target", () => {
  const target = sui("400000000000000");
  // 99.97% of 400,000 SUI is 399,880 SUI.
  assert.equal(qsRaised(SUI, sui("399880000000000"), target), "399K SUI");
  assert.equal(qs(SUI, sui("399880000000000")), "400K SUI", "what rounding would print");
  // 99.999…%: one atom short.
  assert.equal(qsRaised(SUI, sui("399999999999999"), target), "399K SUI");
  assert.equal(qsRaised(SUI, target, target), "400K SUI");
  assert.equal(qsRaised(SUI, sui("500000000000000"), target), "500K SUI", "oversubscribed rounds: flooring would hide it");
  assert.equal(qsRaised(SUI, sui("1249990000000000"), sui("1250000000000000")), "1.24M SUI");
  assert.equal(qsRaised(SUI, sui("9990000000000"), sui("10000000000000")), "9.9K SUI");
  assert.equal(qsRaised(SUI, sui("999999999999"), sui("1000000000000")), "999 SUI");
  assert.equal(shortFloorExact(exactDecimal("99999.999")!), "99.9K");
  assert.equal(shortFloorExact(exactDecimal("1999999999")!), "1.99B");
  assert.equal(qsRaised(SUI, sui("1999999999999999999"), sui("2000000000000000000")), "1.99B SUI", "a billion-coin raise floors in B, as its target reads");
  assert.equal(qsRaised(SUI, sui("2000000000000000000"), sui("2000000000000000000")), "2B SUI");
  // The USDC path keeps the existing rounding rule, named in USDC.
  assert.equal(qsRaised(USDC, dollars("399880.00"), dollars("400000.00")), `${raisedShort(399_880, 400_000).replace("$", "")} USDC`);
  assert.equal(qsRaised(USDC, dollars("399880.00"), dollars("400000.00")), "399K USDC");
});

test("qp is the gate's pxNum in the coin, px() in dollars", () => {
  assert.equal(qp(SUI, { usd: null, quote: "1.5" }), "1.50 SUI");
  assert.equal(qp(SUI, { usd: null, quote: "0.0123456" }), "0.0123 SUI");
  assert.equal(qp(SUI, { usd: null, quote: "0.000556" }), "0.000556 SUI");
  assert.equal(qp(SUI, { usd: null, quote: "0.00012345" }), "0.000123 SUI");
  assert.equal(qp(SUI, { usd: null, quote: "0.00999951" }), "0.01 SUI");
  assert.equal(qp(SUI, { usd: null, quote: "0.0000005" }), "0.0₆5 SUI", "never in exponent form");
  assert.equal(qp(SUI, { usd: null, quote: "0.000000163333333" }), "0.0₆163 SUI", "#555: 1.63e-7 takes subscript zeros, exactly");
  assert.equal(pxNumExact(exactDecimal("0.0000556")!), "0.0₄556", "subscript from four leading zeros, as dollar prices");
  assert.equal(pxNumExact(exactDecimal("0.00009995")!), "0.0001", "a carry is counted after rounding");
  assert.equal(pxNumExact(exactDecimal("0.000001")!), "0.0₅1");
  assert.equal(pxNumExact(exactDecimal("0." + "0".repeat(18) + "1234")!), "0.0₁₈123");
  assert.equal(qp(SUI, { usd: "0.0019", quote: null }), null, "a SUI price never reads in dollars");
  assert.equal(qp(USDC, { usd: "0.000556", quote: "0.000556" }), "$0.000556");
  assert.equal(qp(USDC, { usd: "3.42", quote: null }), px(3.42));
  assert.equal(qp(USDC, { usd: "0.000000163", quote: null }), "$0.0₆163", "#557: a dollar price never reads in exponent form either");
});

test("exactNumber reads a number as the decimal it prints as, never its binary expansion", () => {
  assert.deepEqual(exactNumber(1.63e-7), { n: 163n, scale: 9 });
  assert.deepEqual(exactNumber(0.1 + 0.2), { n: 30000000000000004n, scale: 17 });
  assert.deepEqual(exactNumber(1234.5), { n: 12345n, scale: 1 });
  assert.deepEqual(exactNumber(1e21), { n: 10n ** 21n, scale: 0 });
  assert.deepEqual(exactNumber(0), { n: 0n, scale: 0 });
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(exactNumber(bad), null, String(bad));
});

test("R3-40-AC-2: a USDC sale's figures keep the dollar rules and name the coin; its prices stay in dollars", () => {
  assert.equal(readsInCoin(USDC), false);
  assert.equal(readsInCoin({ symbol: "usdc", decimals: 6 }), false);
  assert.equal(readsInCoin(SUI), true);
  assert.equal(readsInCoin(null), false);
  assert.equal(qm(USDC, dollars("184221.00")), `${usd(184_221).replace("$", "")} USDC`);
  assert.equal(qm(USDC, dollars("184221.00")), "184,221 USDC");
  assert.equal(qm(USDC, dollars("10.00"), 0), "10 USDC");
  assert.equal(qm(USDC, dollars("10.50"), 2), "10.50 USDC");
  assert.equal(qm(USDC, dollars("-10.50"), 2), "-10.50 USDC", "a negative figure keeps its sign, not the dollar sign");
  assert.equal(qp(USDC, { usd: "0.000556", quote: "0.000556" }), "$0.000556");
  assert.equal(qm(USDC, { usd: null, atoms: "10000000" }), null);
  assert.deepEqual(quoteOf({ quote_symbol: "SUI", quote_decimals: 9 }), SUI);
});
