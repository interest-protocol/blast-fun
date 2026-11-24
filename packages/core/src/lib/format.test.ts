import assert from "node:assert/strict";
import test from "node:test";

import { atomsGrouped, atomsText, atomsValue, bxPx, bxUsd, cents, fieldNumber, fillPct, fillPercent, HIDDEN_AMOUNT, monthsBetween, NO_PNL, pnlPercent, pnlText, px, qty, short, shortQty, tapeAgo, usd, usd0, quoteUsd, utc, venueName } from "./format.ts";

test("UI-01: money formats build the prototype's strings (FEATURE-MAP §0.2)", () => {
  assert.equal(usd(2000), "$2,000");
  assert.equal(usd(1200, 2), "$1,200.00");
  assert.equal(usd0(849.5), "$850");
  assert.equal(usd0(0), "$0");
  assert.equal(short(1_250_000), "$1.25M");
  assert.equal(short(399_400), "$399K");
  assert.equal(short(3_140), "$3.1K");
  assert.equal(short(860), "$860");
  // Whole thousands and millions drop the ".0".
  assert.equal(short(5_000), "$5K");
  assert.equal(short(1_200_000), "$1.2M");
  assert.equal(short(2_000_000), "$2M");
  // Fails if short rounds through float toFixed (1.005 is 1.00499… as a float), misses a carry, or has no billions.
  assert.deepEqual([short(1_005_000), short(999_999), short(999_999_999), short(2_500_000_000)], ["$1.01M", "$1M", "$1B", "$2.5B"]);
  assert.equal(HIDDEN_AMOUNT, "••••");
});

test("collapsed right column: coin amounts shorten to fit a 44px tile", () => {
  assert.equal(shortQty(5_000), "5K");
  assert.equal(shortQty(5_400), "5.4K");
  assert.equal(shortQty(18_400), "18K");
  assert.equal(shortQty(1_250_000), "1.3M");
  assert.equal(shortQty(3_000_000), "3M");
  assert.equal(shortQty(412.38), "412");
  assert.equal(shortQty(41.25), "41.3");
  assert.equal(shortQty(7), "7");
  assert.equal(shortQty(0), "0");
  // Fails if a carry stays in the smaller unit (`1000K`, `1000`).
  assert.deepEqual([shortQty(999_999), shortQty(999.6)], ["1M", "1K"]);
});

test("coin amounts in full keep two decimals below 10k and shorten from a million", () => {
  assert.equal(qty(412.38), "412.38");
  assert.equal(qty(5_000), "5,000");
  assert.equal(qty(18_400.6), "18,401");
  assert.equal(qty(2_100_000), "2.1M");
  assert.equal(qty(1_250_000_000), "1.25B");
});

test("UI-09/10: presale formats build the prototype's strings (FEATURE-MAP §0.2)", async () => {
  const f = await import("./format.ts");
  assert.equal(f.px(3.4211), "$3.42");
  assert.equal(f.px(0.21093), "$0.2109");
  assert.equal(f.px(0.000555555), "$0.000556");
  assert.equal(f.px(0.0021), "$0.0021");
  assert.equal(f.px(0.0005), "$0.0005");
  assert.equal(f.px(1.63e-7), "$0.0₆163", "#557: never in exponent form");
  assert.equal(f.px(0.0000556), "$0.0₄556", "subscript from four leading zeros, as pxNumExact and readablePrice");
  assert.equal(f.px(0.00009995), "$0.0001", "a carry is counted after rounding");
  assert.equal(f.px(0.0000005), "$0.0₆5");
  assert.equal(f.px(1.234e-20), "$0.0₁₉123");
  assert.equal(f.px(0), "$0");
  // Fails if px rounds through float toFixed: 1.005 and 0.01005 sit just under the half as floats.
  assert.deepEqual([f.px(1.005), f.px(0.01005)], ["$1.01", "$0.0101"]);
  assert.equal(f.signPct(2.41), "+2.41%");
  assert.equal(f.signPct(-1.86), "−1.86%");
  assert.equal(f.signPct(412.4), "+412%");
  assert.equal(f.ppmPct(2_500), "0.25%");
  assert.equal(f.ppmPct(10_000), "1%");
  assert.equal(f.ppmPct(5_000), "0.5%");
  assert.equal(f.multiple(4.2), "4.2×");
  assert.equal(f.bpsShare(4500), "45%");
  assert.equal(f.bpsShare(250), "2.5%");
  assert.equal(f.fillPct(9_970), 99);
  assert.equal(f.fillPct(7_368), 73);
  assert.equal(f.fillPct(12_456), 125);
  const now = Date.UTC(2026, 9, 3, 12);
  assert.equal(f.timeUntil(now + 11 * 86_400_000 + 1_000, now), "11d 0h");
  assert.equal(f.timeUntil(now + (6 * 3_600 + 12 * 60 + 41) * 1_000, now), "6h 12m");
  assert.equal(f.timeUntil(now + 76_000, now), "1m 16s");
  assert.equal(f.timeUntil(now - 5_000, now), "0m 0s");
  assert.equal(f.utc(Date.UTC(2026, 9, 14, 18)), "Oct 14, 18:00 UTC");
  assert.equal(f.utcDay(Date.UTC(2026, 9, 14, 18)), "Oct 14");
  assert.equal(f.utcTime(Date.UTC(2026, 9, 14, 18)), "18:00");
  assert.equal(f.ago(now - 10_000, now), "now");
  assert.equal(f.ago(now - 6 * 60_000, now), "6m");
  assert.equal(f.ago(now - 2 * 3_600_000, now), "2h");
  assert.equal(f.ago(now - 4 * 86_400_000, now), "4d");
  assert.equal(f.shortAddress(`0x1a2b${"0".repeat(56)}9f0e`), "0x1a2b…9f0e");
});

test("UI-20: unit prices, UTC moments and field figures build the prototype's strings", () => {
  assert.equal(px(1.2449), "$1.24");
  assert.equal(px(0.0556), "$0.0556");
  assert.equal(px(250_000 / 450_000_000), "$0.000556");
  assert.equal(px(0.000625), "$0.000625");
  assert.equal(utc(Date.UTC(2026, 9, 6, 18, 0)), "Oct 6, 18:00 UTC");
  assert.equal(fieldNumber(1_000_000_000), "1,000,000,000");
  assert.equal(fieldNumber(10.5), "10.5");
  assert.equal(fieldNumber(25_000), "25,000");
});

test("UI-05: fillPercent floors below 100 and rounds from 100; tapeAgo reads now, seconds, then minutes", () => {
  assert.equal(fillPercent(398_600, 400_000), 99);
  assert.equal(fillPercent(399_999, 400_000), 99);
  assert.equal(fillPercent(184_221, 250_000), 73);
  assert.equal(fillPercent(312_500, 250_000), 125);
  assert.equal(fillPercent(250_000, 250_000), 100);
  assert.equal(fillPercent(0, 250_000), 0);
  assert.equal(fillPercent(10, 0), 0);
  assert.deepEqual([0, 4_400, 4_600, 12_000, 59_400, 60_000, 89_000, 91_000].map(tapeAgo), ["now", "now", "5s", "12s", "59s", "1m", "1m", "2m"]);
  assert.equal(tapeAgo(-3_000), "now");
});

test("UI-99: one fill rule for basis points and two amounts; exact shares stay exact", () => {
  for (let bps = 0; bps <= 20_000; bps += 1) {
    const expected = bps / 100 < 100 ? Math.floor(bps / 100) : Math.round(bps / 100);
    assert.equal(fillPct(bps), expected, `bps ${bps}`);
  }
  // (29 / 100) * 100 is 28.999… in floating point; the rule scales first.
  assert.equal(fillPercent(29, 100), 29);
  assert.equal(fillPercent(57, 100), 57);
  assert.equal(fillPercent(-5, 100), 0);
  assert.equal(fillPercent(Number.NaN, 100), 0);
});

test("UI-99: the shared venue, atoms and month helpers", () => {
  assert.equal(venueName("blast_curve"), "Bonding curve");
  assert.equal(venueName("cetus"), "Cetus");
  assert.equal(venueName("bluefin"), "Bluefin");
  assert.equal(venueName("aftermath"), "Aftermath");
  assert.equal(venueName("CETUS"), "Cetus");
  assert.equal(venueName("turbos"), "Turbos");
  assert.equal(venueName("constructor"), "Constructor");
  assert.equal(venueName("__proto__"), "__proto__");
  assert.equal(venueName(""), "");
  assert.equal(atomsValue("1250000", 6), 1.25);
  assert.equal(monthsBetween(0, 6 * 30 * 86_400_000), 6);
  assert.equal(monthsBetween(0, 86_400_000), 1);
});

test("R3-06: a raised figure rounds down, so it never reads as the target before it gets there", async () => {
  const f = await import("./format.ts");
  assert.equal(f.shortFloor(399_999), "399K");
  assert.equal(f.shortFloor(399_400), "399K");
  assert.equal(f.shortFloor(3_199), "3.1K");
  assert.equal(f.shortFloor(1_999_999), "1.99M");
  assert.equal(f.shortFloor(2_000_000), "2M");
  assert.equal(f.shortFloor(999), "999");
  assert.equal(f.shortFloor(0), "0");
  // The old rule rounded, which read as complete one dollar early.
  assert.equal(f.raisedShort(399_999, 400_000), "$399K");
  assert.equal(f.raisedShort(399_999, 400_000) === f.short(399_999), false);
  // From the target it is exact again, so an oversubscription is not hidden.
  assert.equal(f.raisedShort(400_000, 400_000), "$400K");
  assert.equal(f.raisedShort(500_000, 400_000), "$500K");
});

test("R3-06: Blast mode's dollars take cents only below $100, and a price keeps four significant digits", async () => {
  const f = await import("./format.ts");
  assert.equal(f.bxUsd(250), "$250");
  assert.equal(f.bxUsd(12.5), "$12.50");
  assert.equal(f.bxUsd(99), "$99");
  assert.equal(f.bxUsd(99.99), "$99.99");
  assert.equal(f.bxUsd(100.5), "$101", "from $100 the cents are dropped");
  assert.equal(f.bxUsd(1_240), "$1,240");
  assert.equal(f.bxSigned(84), "+$84");
  assert.equal(f.bxSigned(-12.4), "−$12.40");
  assert.equal(f.bxSigned(0), "+$0");
  // Trailing zeros are kept, so a ticking price never changes width.
  assert.equal(f.bxPx(0.0021), "$0.002100");
  assert.equal(f.bxPx(0.21093), "$0.2109");
  assert.equal(f.bxPx(1.25), "$1.25");
  assert.equal(f.px(0.0021), "$0.0021", "the page's own price rule is unchanged");
});

test("R3-06: a funded raise reads as a multiple and `oversubscribed`, not `raised`", async () => {
  const f = await import("./format.ts");
  assert.equal(f.times2(1.25), "1.25×");
  assert.equal(f.times2(4.2), "4.20×");
  assert.equal(f.fundWord(500_000, 400_000), "oversubscribed");
  assert.equal(f.fundWord(400_000, 400_000), "subscribed");
  assert.equal(f.fundWord(400_001, 400_000), "subscribed", "rounded to 1.00× it is exactly met");
  assert.equal(f.fundWord(0, 0), "oversubscribed", "no target is not a met target");
});

test("R3-06: times read local, with UTC only in a tooltip's second half", async () => {
  const f = await import("./format.ts");
  const at = Date.UTC(2026, 9, 14, 18, 14);
  // A fixed zone, restored after, so "local first" is actually proved: the
  // suite does not pin TZ, and in UTC a local time and its UTC half match.
  const zone = process.env.TZ;
  process.env.TZ = "Europe/Lisbon";
  try {
    assert.equal(f.localDay(at), "Oct 14");
    assert.equal(f.localTime(at), "19:14", "local, an hour ahead of UTC in October");
    assert.equal(f.localTime(at, "UTC"), "18:14");
    assert.equal(f.localTime(Date.UTC(2026, 9, 13, 23, 5)), "00:05", "midnight reads 00, not 24");
    assert.equal(f.localAt(at), "Oct 14, 19:14");
    assert.equal(f.localFull(at), "Oct 14, 19:14 · 18:14 UTC");
    assert.equal(f.utc(at), "Oct 14, 18:14 UTC", "the base pages keep UTC in the body copy");
    assert.equal(f.localWhen(at + 49 * 3_600_000, at), "Oct 16", "from 48 hours it is the date");
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
  assert.equal(f.localWhen(at + 6 * 3_600_000, at), "in 6h");
  assert.equal(f.localWhen(at - 7 * 60_000, at), "7m ago");
  assert.equal(f.localWhen(at + 30_000, at), "in 1m", "never under a minute");
  assert.equal(f.localWhen(at + 47 * 3_600_000, at), "in 47h");
  assert.equal(f.bxAgo(at - 3_000, at), "now", "under five seconds, as the tape reads it");
  assert.equal(f.bxAgo(at - 42_000, at), "42s");
  assert.equal(f.bxAgo(at - 59 * 60_000, at), "59m");
  assert.equal(f.bxAgo(at - 18 * 60_000, at), "18m");
  assert.equal(f.bxAgo(at - 6 * 3_600_000, at), "6h");
  assert.equal(f.bxAgo(at - 3 * 86_400_000, at), "3d");
  // The boards' coin ages: days below a year, whole years from 365 days (`1y`, `2y`).
  assert.equal(f.bxAgo(at - 364 * 86_400_000, at), "364d");
  assert.equal(f.bxAgo(at - 365 * 86_400_000, at), "1y");
  assert.equal(f.bxAgo(at - 729 * 86_400_000, at), "1y");
  assert.equal(f.bxAgo(at - 2 * 365 * 86_400_000, at), "2y");
  assert.equal(f.ago(at - 800 * 86_400_000, at), "2y");
});

test("R3-32: the P&L reads as the gate writes it, and `–` wherever the basis cannot answer", () => {
  // §15.7.3 and §15.9: `+$958 · 4.19×`, the chip's `+319%`.
  assert.equal(pnlText("958.00", "4.1933"), "+$958 · 4.19×");
  assert.equal(pnlPercent("4.1933"), "+319%");
  assert.equal(pnlText("-12.40", "0.8100"), "−$12.40 · 0.81×");
  assert.equal(pnlPercent("0.8100"), "−19%");
  // R3-32-AC-3: a full sell leaves a zero basis, so no P&L and no multiple: `–`, never infinity or zero.
  assert.equal(NO_PNL, "\u2013");
  for (const [usd, multiple] of [[null, null], ["0.00", null], [null, "1.0000"]] as const) {
    assert.equal(pnlText(usd, multiple), "–");
    assert.ok(!/∞|Infinity|NaN|0\.00×/.test(pnlText(usd, multiple)));
  }
  assert.equal(pnlPercent(null), null);
  // Amounts hidden: the dollars are masked, the multiple is not an amount.
  assert.equal(pnlText("958.00", "4.1933", true), `${HIDDEN_AMOUNT} · 4.19×`);
  assert.equal(pnlText(null, null, true), "–");
});

test("bxPx keeps four significant digits and never prints e-notation (#558)", () => {
  assert.equal(bxPx(1.63e-7), "$0.0₆1630");
  assert.equal(bxPx(0.0000556), "$0.0₄5560");
  assert.equal(bxPx(0.000556), "$0.0005560");
  assert.equal(bxPx(0.0123456), "$0.01235");
  assert.equal(bxPx(1.5), "$1.50");
});

test("cents: dollars to the cent, and a nonzero amount under a cent is <$0.01, never $0.00", () => {
  assert.equal(cents(8986.11), "$8,986.11");
  assert.equal(cents(0), "$0.00");
  assert.equal(cents(0.004), "<$0.01");
  assert.equal(cents(0.005), "$0.01");
});

// Fails if atoms reach a number through float division (`Number(atoms) / 10 ** d` reads 9007199254.740992) or a bad figure reads as 0.
test("atoms become whole coins exactly: the nearest number for display, the exact decimal for text", () => {
  assert.deepEqual([atomsValue("25500000000", 9), atomsValue("1234567890", 9), atomsValue("1", 18), atomsValue("x", 9)], [25.5, 1.23456789, 1e-18, null]);
  assert.equal(atomsValue("9007199254740993", 6), 9007199254.740993);
  assert.equal(atomsText("18446744073709551615", 6), "18446744073709.551615");
  assert.equal(atomsGrouped("18446744073709551615", 6), "18,446,744,073,709.551615");
  assert.deepEqual([atomsText("10", 0), atomsText("1", 6), atomsText(-7n, 0)], ["10", "0.000001", "-7"]);
});

// Fails if the two sale cards disagree again: an unpriced USDC quote reads at $1 (owner, 2026-11-14), any other unpriced quote is null.
test("quoteUsd multiplies whole quote coins by the price exactly, and only USDC has a fallback price", () => {
  const sui = { quote_symbol: "SUI", quote_decimals: 2, quote_usd: "3.42" };
  assert.equal(quoteUsd(sui, "9"), 0.3078);
  assert.equal(quoteUsd({ ...sui, quote_usd: null }, "9"), null);
  assert.equal(quoteUsd({ quote_symbol: "USDC", quote_decimals: 6, quote_usd: null }, "400000000000"), 400_000);
  assert.equal(quoteUsd({ quote_symbol: "USDC", quote_decimals: 6, quote_usd: "" }, "400000000000"), null, "a bad price is not a missing one");
  assert.equal(quoteUsd({ quote_symbol: "usdc", quote_decimals: 6, quote_usd: null }, "2000000"), 2, "matched as readsInCoin matches it");
  assert.equal(quoteUsd(sui, "1.5"), null);
});

// Fails if the number formats round the float instead of the printed decimal, lose a minus, or print `-$0`.
test("qty, bxUsd and bxPx round the printed number half up and keep its minus unless it reads as zero", () => {
  assert.deepEqual([qty(1_005_000), bxUsd(1.005), bxPx(1.115)], ["1.01M", "$1.01", "$1.12"]);
  assert.deepEqual([qty(-2_500_000), bxUsd(-5.5), bxUsd(-0.004), bxPx(1_410.35)], ["-2.5M", "-$5.50", "$0", "$1,410.35"]);
});
