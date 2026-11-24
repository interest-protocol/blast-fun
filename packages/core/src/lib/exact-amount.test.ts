import assert from "node:assert/strict";
import test from "node:test";

import {
  addExact,
  amtExact,
  bxPxExact,
  bxUsdExact,
  compareExact,
  divideExact,
  exactDecimal,
  decimalPoint,
  groupDigits,
  insertDecimal,
  qtyExact,
  subtractExact,
  type Exact,
} from "./exact-amount.ts";

/**
 * The trade surfaces' numbers (R3-55): the gate's formats (`qty`, `bxUsd`,
 * `bxPx`, `amtFmt`) over exact decimals, so what is shown, compared and
 * submitted is one number. Each case is the gate's own float output for the
 * same value; the cases stay clear of float rounding edges.
 */

const dec = (text: string): Exact => exactDecimal(text)!;

// The gate's own functions, verbatim (design/blast-feel-preview-oa32.html lines 2109–2114, 5002), as the oracle.
const trim = (s: string) => s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
const gateQty = (n: number) => (n >= 1e9 ? trim((n / 1e9).toFixed(2)) + "B" : n >= 1e6 ? trim((n / 1e6).toFixed(2)) + "M" : n >= 1e4 ? Math.round(n).toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const gateUsd = (n: number, d = 0) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const gateBxUsd = (v: number) => gateUsd(v, Math.abs(v) < 100 && Math.round(v * 100) % 100 !== 0 ? 2 : 0);
const gateBxPx = (v: number) => `$${v >= 1 ? v.toFixed(2) : v.toPrecision(4)}`;
const gateAmt = (n: number) => (n >= 1e4 ? Math.floor(n).toLocaleString("en-US") : n >= 1 ? (Math.floor(n * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 }) : n > 0 ? String(Number(n.toPrecision(3))) : "0");

// Fails if qtyExact stops matching the gate's qty (compact suffixes, rounding from 10k, two places below).
test("qty writes what the gate writes: `47,619`, `1.2M`, `2.31M`, `4,239.83`", () => {
  for (const value of ["47619.05", "1200000", "2310000", "4239.83", "0.5", "1000000000", "600000", "8870000", "1400000", "300000", "46783.4", "12.5", "0", "999.99", "10000"]) {
    assert.equal(qtyExact(dec(value)), gateQty(Number(value)), value);
  }
  assert.equal(qtyExact(dec("999999999")), "1B", "a carry past 999.99M moves up a unit; the gate printed 1000M");
});

// Fails if bxUsdExact moves the $100 cents threshold or prints `.00`.
test("bxUsd: whole dollars from $100, cents below, never `.00`", () => {
  for (const value of ["860", "1260", "99.85", "50", "4180", "2520", "99.97", "1278.4", "9", "0.5", "12345.67"]) {
    assert.equal(bxUsdExact(dec(value)), gateBxUsd(Number(value)), value);
  }
  assert.equal(bxUsdExact(dec("99.996")), "$100", "rounds into the whole-dollar form");
});

// Fails if bxPxExact drops trailing zeros, loses a carry digit, or stops compacting long zero runs.
test("bxPx: four significant digits (`$0.002100`), two places from $1, a subscript for four or more zeros", () => {
  for (const value of ["0.0021", "0.0013", "3.42", "0.2109", "0.5", "0.002118", "0.012345", "1"]) {
    assert.equal(bxPxExact(dec(value)), gateBxPx(Number(value)), value);
  }
  assert.equal(bxPxExact(dec("0.0099996")), "$0.01000", "a carry into the next digit keeps four");
  assert.equal(bxPxExact(dec("0.0000001")), "$0.0₆1000");
});

// Fails if amtExact rounds up anywhere, or loses precision on a u64 amount.
test("amtFmt: floored and grouped from 10,000, two places floored from 1, three significant digits below", () => {
  for (const value of ["100", "47566.9", "1.239", "0.003123", "0", "860", "250.5", "0.5", "1234.567"]) {
    assert.equal(amtExact(dec(value)), gateAmt(Number(value)), value);
  }
  assert.equal(amtExact({ n: 341_997_073n, scale: 6 }), "341.99");
  assert.equal(amtExact({ n: 2_565_136n, scale: 9 }), "0.00257", "half up below one, as toPrecision(3)");
  assert.equal(amtExact({ n: 18_446_744_073_709_551_615n, scale: 9 }), "18,446,744,073");
});

// Fails if rescaling, borrowing, or the floored division that turns dollars into atoms goes wrong.
test("exact arithmetic aligns scales, refuses a negative difference and divides down to whole atoms", () => {
  assert.deepEqual(addExact(dec("1.5"), dec("0.25")), { n: 175n, scale: 2 });
  assert.deepEqual(subtractExact(dec("10"), dec("0.001")), { n: 9_999n, scale: 3 });
  assert.equal(subtractExact(dec("0.001"), dec("0.0011")), null);
  assert.equal(compareExact(dec("600000"), { n: 600_000_000_000_000n, scale: 9 }), 0);
  assert.equal(divideExact(dec("100.123456789"), dec("1"), 6)!.n, 100_123_456n);
  assert.equal(divideExact(dec("100"), dec("21"), 0)!.n, 4n);
  assert.equal(divideExact(dec("1"), dec("0")), null);
  assert.equal(groupDigits("18446744073709551615"), "18,446,744,073,709,551,615");
  assert.deepEqual(["1e5", "-1", "01", " 1", "1."].map(exactDecimal), [null, null, null, null, null]);
});

// Fails if a comma-decimal keypad's `0,5` reads as 5 (#1033), or if grouped thousands stop reading as thousands.
test("decimalPoint: a decimal-mark comma reads as the point; thousands grouping stays grouping", () => {
  const cases = [["0,5", "0.5"], ["1,5", "1.5"], ["12,50", "12.50"], ["1,000", "1000"], ["1,000.5", "1000.5"], ["12,345,678", "12345678"], ["0,500", "0.500"], ["1.234,5", "1234.5"], ["1,234,5", "1234.5"], ["$1,000", "$1000"], ["12", "12"], [",5", ".5"]];
  for (const [typed, read] of cases) assert.equal(decimalPoint(typed), read, typed);
});

// Fails if a typed comma is not the decimal mark, if a field's own grouping commas are re-read on an edit, or if a paste over a selection is read against the text it replaces.
test("insertDecimal: only the typed or pasted text is read; the field's grouping stays", () => {
  const type = (value: string, char: string) => insertDecimal(value, value.length, value.length, char);
  const paste = (value: string, text: string) => insertDecimal(value, 0, value.length, text);
  assert.equal(type("0", ","), "0.");
  assert.equal(type("1", ","), "1.", "a typed comma is the decimal mark: typing 1,000 key by key reads 1.000");
  assert.equal(type("1,000", ","), "1,000.");
  assert.equal(type("1,000", "5"), "1,0005");
  assert.equal(type("1.5", ","), "1.5");
  assert.equal(insertDecimal("10", 1, 1, ","), "1.0");
  assert.equal(paste("", "0,5"), "0.5");
  assert.equal(paste("500", "1,500"), "1500");
  assert.equal(paste("1,000", "1,000,000"), "1000000");
  assert.equal(paste("1,000", "1,5"), "1.5");
  assert.equal(paste("1.000", "1,000"), "1000");
  assert.equal(paste("", "1,000.5"), "1000.5");
  assert.equal(paste("", "12,50"), "12.50");
});
