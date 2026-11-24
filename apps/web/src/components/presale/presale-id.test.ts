import assert from "node:assert/strict";
import test from "node:test";

import { isPresaleId } from "@blast/core/modules/presale/presale-id.ts";

test("a presale ID is 0x and exactly 64 lowercase hex digits", () => {
  assert.equal(isPresaleId(`0x${"0123456789abcdef".repeat(4)}`), true);
  for (const value of [
    "abc",
    "0x",
    `0x${"a".repeat(63)}`,
    `0x${"a".repeat(65)}`,
    `0X${"a".repeat(64)}`,
    `0x${"A".repeat(64)}`,
    `0x${"g".repeat(64)}`,
    "a".repeat(66),
    ` 0x${"a".repeat(64)}`,
    `0x${"a".repeat(64)}\n`,
  ]) {
    assert.equal(isPresaleId(value), false, JSON.stringify(value));
  }
});
