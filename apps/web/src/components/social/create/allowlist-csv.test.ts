import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CREATE_MAX_WALLETS } from "@blast/core/modules/social/contracts/create.ts";
import { parseAllowlist } from "./allowlist-csv";

const wallet = (tag: string) => `0x${tag.padStart(64, "0")}`;

test("the downloadable example uses whole coins and passes validation for each supported precision", () => {
  const sample = readFileSync(new URL("../../../../public/examples/allowlist.csv", import.meta.url), "utf8");
  for (const [decimals, symbol] of [[6, "USDC"], [9, "SUI"], [9, "TEST_SUI"]] as const) {
    const parsed = parseAllowlist(sample, decimals, symbol);
    assert.equal(parsed.errorCount, 0);
    assert.deepEqual(parsed.entries.map((row) => row.amount), ["1000.50", "250"]);
    assert.equal(parsed.entries[0].cap, (100050n * 10n ** BigInt(decimals - 2)).toString());
  }
});

test("BOM, surrounding spaces, blank lines and Windows/Mac line endings preserve original line numbers", () => {
  const parsed = parseAllowlist(`\uFEFF\r\n address , amount \r\n\r\n "0xAB" , "1.000001" \r\n \r\n${wallet("cd")}\t0.000001\r`);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.entries, [
    { line: 4, wallet: wallet("ab"), amount: "1.000001", cap: "1000001", sourceAddress: ' "0xAB" ', sourceAmount: ' "1.000001" ' },
    { line: 6, wallet: wallet("cd"), amount: "0.000001", cap: "1", sourceAddress: wallet("cd"), sourceAmount: "0.000001" },
  ]);
  assert.equal(parsed.minAmount, "0.000001");
});

test("invalid addresses, normalized duplicates and malformed columns identify the exact file line", () => {
  const parsed = parseAllowlist(`address,amount\n\n0xAB,1\n${wallet("ab")},2\n0xzz,1\n,5\n${wallet("cd")},1,000\n${wallet("ef")}\n`);
  assert.deepEqual(parsed.errors.map((row) => row.line), [4, 5, 6, 7, 8]);
  assert.match(parsed.errors[0].reason, /first on line 3/);
  assert.equal(parsed.csv, "");
});

test("amounts must be complete plain decimal numbers, positive and within coin precision", () => {
  for (const amount of ["100abc", "1e3", "$100", "-1", "0", "0.000000", "NaN", "Infinity", "1 000", "1.0000001", "", '"1,000"']) {
    const parsed = parseAllowlist(`${wallet("a")},${amount}`);
    assert.equal(parsed.errorCount, 1, amount);
    assert.equal(parsed.csv, "", amount);
    assert.equal(parsed.errors[0].line, 1);
  }
  assert.match(parseAllowlist(`${wallet("a")},1.0000001`).errors[0].reason, /Maximum 6 decimal places/);
});

test("amount conversion preserves smallest units and the exact u64 maximum without floating-point arithmetic", () => {
  const parsed = parseAllowlist(`${wallet("a")},0.000000001\n${wallet("b")},18446744073.709551615`, 9, "SUI");
  assert.equal(parsed.errorCount, 0);
  assert.equal(parsed.minAmount, "0.000000001");
  assert.equal(parsed.maxAmount, "18446744073.709551615");
  assert.equal(parsed.csv, `wallet,cap\n${wallet("a")},1\n${wallet("b")},18446744073709551615\n`);
  for (const amount of ["18446744073.709551616", "9".repeat(1000)]) {
    assert.match(parseAllowlist(`${wallet("a")},${amount}`, 9, "SUI").errors[0].reason, /maximum/);
  }
});

test("empty files, mismatched coin headers and extra wallets block the whole file", () => {
  for (const text of ["", "\n \n", "address,amount\n", `${wallet("a")},1\naddress,amount`]) {
    assert.ok(parseAllowlist(text).errorCount > 0);
  }
  assert.match(parseAllowlist(`address,sui\n${wallet("a")},1`).errors[0].reason, /Amounts are in USDC/);
  const rows = Array.from({ length: CREATE_MAX_WALLETS + 1 }, (_, index) => `${wallet(index.toString(16))},1`);
  const parsed = parseAllowlist(rows.join("\n"));
  assert.equal(parsed.errors[0].line, CREATE_MAX_WALLETS + 1);
  assert.equal(parsed.csv, "");
});

test("error reporting is bounded but every offending row counts and prevents upload", () => {
  const parsed = parseAllowlist(Array.from({ length: 250 }, () => "invalid,1").join("\n"));
  assert.equal(parsed.errorCount, 250);
  assert.equal(parsed.rowCount, 250);
  assert.equal(parsed.affectedRowCount, 250);
  assert.deepEqual(parsed.errorCategories, { address: 250 });
  assert.equal(parsed.errors.length, 100);
  assert.equal(parsed.errors[99].line, 100);
  assert.equal(parsed.csv, "");
});

test("small and large error fixtures preserve source lines, supplied values and authoritative counts", () => {
  const fixture = (name: string) => readFileSync(new URL(`../../../../test/fixtures/social/${name}`, import.meta.url), "utf8");
  const small = parseAllowlist(fixture("allowlist-invalid.csv"));
  assert.deepEqual([small.rowCount, small.affectedRowCount, small.errorCount], [4, 3, 3]);
  assert.deepEqual(small.errors.map(({ line, field, value, reason }) => ({ line, field, value, reason })), [
    { line: 3, field: "Address", value: "0x1", reason: "Duplicate wallet; first on line 2" },
    { line: 4, field: "Address", value: "not-a-sui-address", reason: "Invalid Sui address" },
    { line: 5, field: "Amount", value: "100abc", reason: "Invalid number" },
  ]);
  const large = parseAllowlist(fixture("allowlist-invalid-100.csv"));
  assert.deepEqual([large.rowCount, large.affectedRowCount, large.errorCount, large.errors.length], [100, 50, 50, 50]);
  assert.deepEqual(large.errorCategories, { address: 10, duplicate: 10, zero: 10, number: 10, precision: 10 });
  assert.equal(large.errors.at(-1)!.line, 101);
  assert.equal(large.csv, "");
  assert.equal(small.csv, "");
  assert.deepEqual(large.errors.map((error) => error.line), large.errors.map((error) => error.line).toSorted((a, b) => a - b));
  for (let index = 0; index < 10; index++) assert.equal(large.errors[index * 5 + 1].reason, `Duplicate wallet; first on line ${index * 10 + 2}`);
});

test("blank lines and headers are not data rows, and original whitespace and quotes remain available", () => {
  const parsed = parseAllowlist('address,amount\n\n "bad address" , 100 \n\n0x1, "100abc" \n');
  assert.deepEqual([parsed.rowCount, parsed.affectedRowCount, parsed.errorCount], [2, 2, 2]);
  assert.deepEqual(parsed.errors.map(({ line, value }) => [line, value]), [[3, ' "bad address" '], [5, ' "100abc" ']]);
  const header = parseAllowlist("address,wrong\n\n0x1,1\n");
  assert.deepEqual([header.rowCount, header.affectedRowCount, header.errorCount], [1, 0, 1]);
  assert.deepEqual(header.errorCategories, { header: 1 });
  assert.equal(parseAllowlist("").rowCount, 0);
});
