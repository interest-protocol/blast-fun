import assert from "node:assert/strict";
import test from "node:test";
import { coverPalette } from "./cover-palette.ts";

test("canonical IDs pick a stable curated palette and absent IDs use neutral", () => {
  assert.equal(coverPalette(null), 0);
  assert.equal(coverPalette(undefined), 0);
  assert.equal(coverPalette(""), 0);
  const ids = Array.from({ length: 128 }, (_, index) => `0x${index.toString(16).padStart(64, "0")}`);
  const expected = ids.map(coverPalette);
  assert.deepEqual(ids.map(coverPalette), expected);
  assert.deepEqual([...new Set(expected)].sort(), [1, 2, 3, 4]);
  assert.equal(coverPalette("0x" + "a".repeat(64)), 1);
});
