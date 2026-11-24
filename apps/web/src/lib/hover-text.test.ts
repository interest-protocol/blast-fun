import assert from "node:assert/strict";
import { test } from "node:test";
import { hoverExcerpt } from "./hover-text.ts";

test("hover excerpts keep short text on one line and cut long text at a word", () => {
  assert.equal(hoverExcerpt("  A short\n reason  "), "A short reason");
  const sentence = "A team with a simple plan and a clear launch date. ";
  const result = hoverExcerpt(sentence.repeat(4));
  assert.equal(result, `${sentence}A team with…`);
  assert.ok(result.length <= 64);
});

test("hover excerpts shorten pasted identifiers without splitting a Unicode character", () => {
  const address = `0x${"ab".repeat(32)}`;
  assert.equal(hoverExcerpt(`See ${address} for the details`), `See ${address.slice(0, 24)}… for the details`);
  assert.equal(hoverExcerpt("🐕".repeat(40)), `${"🐕".repeat(24)}…`);
});
