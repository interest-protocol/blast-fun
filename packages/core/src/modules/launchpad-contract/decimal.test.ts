import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractViolation,
  contractObject,
  contractValue,
  recordSchema,
  atomicString,
  parseAtomic,
  parseCount,
  parsePriceString,
  parseSignedAtomic,
  parseUsdString,
} from "./decimal.ts";

test("atomic values cross the wire as unsigned decimal strings and parse to exact bigints", () => {
  assert.equal(parseAtomic("0", "supply"), 0n);
  assert.equal(parseAtomic("999998000000000", "supply"), 999_998_000_000_000n);
  // Larger than any JSON number holds exactly.
  assert.equal(parseAtomic("340282366920938463463374607431768211455", "sqrt"), 2n ** 128n - 1n);
  for (const bad of [12, 12n, "", "-1", "01", "1.0", "1e3", " 1", "0x10", null, undefined, "١"]) {
    assert.throws(() => parseAtomic(bad, "supply"), ContractViolation, String(bad));
  }
});

test("an atomic value names the field it broke and never becomes zero", () => {
  assert.throws(
    () => parseAtomic(12, "inputs.meme_reserve"),
    (error: unknown) =>
      error instanceof ContractViolation &&
      error.field === "inputs.meme_reserve" &&
      /decimal string/.test(error.message),
  );
});

test("bit widths bound atomic values", () => {
  assert.equal(parseAtomic("18446744073709551615", "amount", 64), 2n ** 64n - 1n);
  assert.throws(() => parseAtomic("18446744073709551616", "amount", 64), ContractViolation);
});

test("signed atomic values allow a leading minus but never -0", () => {
  assert.equal(parseSignedAtomic("-5", "delta"), -5n);
  assert.equal(parseSignedAtomic("0", "delta"), 0n);
  for (const bad of ["-0", "+5", "--5", 5]) {
    assert.throws(() => parseSignedAtomic(bad, "delta"), ContractViolation, String(bad));
  }
});

test("atomicString writes an exact bigint as the wire's decimal string", () => {
  assert.equal(atomicString(0n), "0");
  assert.equal(atomicString(2n ** 128n), "340282366920938463463374607431768211456");
  assert.equal(atomicString(-7n), "-7");
  assert.throws(() => atomicString(1 as unknown as bigint), ContractViolation);
});

test("the canonical price string has at most 36 fractional digits and no trailing zero", () => {
  for (const good of ["0", "12", "0.5", "0.000000000000000000054210108624275221", "0.002528735632183908045977011494252873"]) {
    assert.equal(parsePriceString(good, "price"), good);
  }
  for (const bad of ["0.50", "1.", ".5", "1e-9", "0.0000000000000000000000000000000000001", "-1", 0.5]) {
    assert.throws(() => parsePriceString(bad, "price"), ContractViolation, String(bad));
  }
});

test("USD strings have at most 18 fractional digits; results may be negative, volumes not", () => {
  assert.equal(parseUsdString("34.521", "volume_usd"), "34.521");
  assert.equal(parseUsdString("-1.5", "realized_usd", { signed: true }), "-1.5");
  for (const bad of ["-1.5", "1.1234567890123456789", "1.50", 34.5]) {
    assert.throws(() => parseUsdString(bad, "volume_usd"), ContractViolation, String(bad));
  }
  assert.throws(() => parseUsdString("-0", "realized_usd", { signed: true }), ContractViolation);
});

test("counts and checkpoints are JSON safe integers", () => {
  assert.equal(parseCount(184, "holders"), 184);
  for (const bad of ["184", -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.throws(() => parseCount(bad, "holders"), ContractViolation, String(bad));
  }
});


test("closed wire objects reject prototype-named JSON keys before and after a record guard", () => {
  const value = JSON.parse('{"field":"ok","__proto__":{"polluted":true}}');
  for (const candidate of [value, contractValue(recordSchema, value, "wire", "must be an object")]) {
    assert.throws(() => contractObject(candidate, "wire", ["field"]), (error: unknown) =>
      error instanceof ContractViolation && error.field === "wire.__proto__" && /not in the contract/.test(error.message));
  }
});
