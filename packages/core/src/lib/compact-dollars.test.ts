import assert from "node:assert/strict";
import test from "node:test";
import { short } from "@blast/core/lib/compact-dollars.ts";

test("compact dollars keep billion amounts legible", () => {
  for (const [value, text] of [[0, "$0"], [1250000, "$1.25M"], [999000000, "$999M"], [1250000000, "$1.25B"], [10000000000, "$10B"], [25000000000, "$25B"], [100000000000, "$100B"]] as const) assert.equal(short(value), text);
});
