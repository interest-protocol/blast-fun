import assert from "node:assert/strict";
import test from "node:test";

import { formatAmountShort, formatDuration, formatPricePerToken, formatTime, formatUsd, shiftDecimal } from "./coin-format.ts";

test("prices move between atom and whole-token units exactly", () => {
  assert.equal(shiftDecimal("0.015625", -3), "0.000015625");
  assert.equal(shiftDecimal("12", 3), "12000");
  assert.equal(shiftDecimal("0.5", 2), "50");
  assert.equal(shiftDecimal("12.5", -4), "0.00125");
  // 0.0025287… Quote atoms per Meme atom, 6 Meme and 9 Quote decimals.
  assert.equal(formatPricePerToken("0.002528735632183908045977011494252873", 6, 9), "0.000002528735…");
  assert.equal(formatPricePerToken("0.015625", 6, 9), "0.000015625");
});

test("amounts truncate toward zero and never round up", () => {
  assert.equal(formatAmountShort(2_528_730_574_712n, 9), "2,528.73");
  assert.equal(formatAmountShort(2_528_739_999_999n, 9), "2,528.73");
  assert.equal(formatAmountShort(999_998_000_000_000n, 6), "999,998,000");
  assert.equal(formatAmountShort(1_234n, 9), "0.000001234");
  assert.equal(formatAmountShort(0n, 9), "0");
  assert.equal(formatUsd("1070.151"), "$1,070.15");
  assert.equal(formatUsd("0.009"), "$0.009");
});

test("times are absolute UTC and durations plain", () => {
  assert.equal(formatTime(1_790_200_000_000), "2026-09-23 21:46:40 UTC");
  assert.equal(formatDuration(3_600_000n), "1 h");
  assert.equal(formatDuration(5_400_000n), "1 h 30 min");
  assert.equal(formatDuration(90_000n), "1 min 30 s");
});
