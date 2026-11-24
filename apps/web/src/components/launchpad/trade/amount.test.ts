import assert from "node:assert/strict";
import test from "node:test";

import { parseTradeAmount } from "./amount.ts";
import { atomsGrouped } from "@blast/core/web/format.ts";

test("a display amount becomes exact atomic units", () => {
  assert.deepEqual(parseTradeAmount("12.5", 9), { ok: true, atomic: 12_500_000_000n });
  assert.deepEqual(parseTradeAmount(" 0.000000001 ", 9), { ok: true, atomic: 1n });
  assert.deepEqual(parseTradeAmount("1,000", 6), { ok: true, atomic: 1_000_000_000n });
  assert.deepEqual(parseTradeAmount("7", 0), { ok: true, atomic: 7n });
});

test("empty, negative, zero, malformed, over-precision, and overflowing amounts are refused with a reason", () => {
  const reason = (text: string, decimals = 9) => {
    const result = parseTradeAmount(text, decimals);
    return result.ok ? "ok" : result.reason;
  };
  assert.equal(reason(""), "empty");
  assert.equal(reason("-1"), "negative");
  assert.equal(reason("0"), "zero");
  assert.equal(reason("0.000"), "zero");
  assert.equal(reason("1e9"), "malformed");
  assert.equal(reason("1.2.3"), "malformed");
  assert.equal(reason("abc"), "malformed");
  assert.equal(reason("0.0000000001"), "precision");
  assert.equal(reason("18446744073.709551616"), "overflow");
  assert.equal(reason("18446744073.709551615"), "ok");
});

test("atomic amounts format exactly, with grouping and no rounding", () => {
  assert.equal(atomsGrouped(12_500_000_000n, 9), "12.5");
  assert.equal(atomsGrouped(1n, 9), "0.000000001");
  assert.equal(atomsGrouped(1_234_567_000_000_000n, 9), "1,234,567");
  assert.equal(atomsGrouped(0n, 6), "0");
});

test("a comma is accepted only in valid thousands groups, never dropped silently", () => {
  const reason = (text: string) => {
    const result = parseTradeAmount(text, 9);
    return result.ok ? `ok:${result.atomic}` : result.reason;
  };
  assert.equal(reason("0,5"), "grouping");
  assert.equal(reason("1,5"), "grouping");
  assert.equal(reason(",,,1"), "grouping");
  assert.equal(reason("1,0,0,0"), "grouping");
  assert.equal(reason("1,000.5"), "ok:1000500000000");
  assert.equal(reason("12,345,678"), "ok:12345678000000000");
  assert.equal(reason("1000,000"), "grouping");
  assert.equal(reason("0.5,1"), "grouping");
  // A leading zero group can only be a decimal comma (0,500 is half a coin, never 500).
  assert.equal(reason("0,500"), "grouping");
  assert.equal(reason("0,250"), "grouping");
  assert.equal(reason("00,001"), "grouping");
});
