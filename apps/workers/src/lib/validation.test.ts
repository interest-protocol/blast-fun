import assert from "node:assert/strict";
import test from "node:test";
import { positiveMistSchema, u64Schema } from "./validation.ts";

test("numeric schemas refuse malformed and out of range strings without throwing native conversion errors", () => {
  for (const value of ["", "x", "1.5", "-1", "18446744073709551616", null, {}, undefined]) {
    assert.equal(u64Schema.safeParse(value).success, false);
    assert.equal(positiveMistSchema.safeParse(value).success, false);
  }
  assert.equal(u64Schema.safeParse("18446744073709551615").success, true);
  assert.equal(u64Schema.safeParse("00").success, false);
  assert.equal(positiveMistSchema.parse("0001"), 1n);
});
