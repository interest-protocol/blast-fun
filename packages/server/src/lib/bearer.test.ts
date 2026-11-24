import assert from "node:assert/strict";
import test from "node:test";

import { bearerMatches } from "@blast/server/lib/bearer.ts";

const secret = "c".repeat(32);

function request(authorization?: string): Request {
  return new Request("https://example.test/api/admin/presales", {
    headers: authorization ? { authorization } : {},
  });
}

test("only the exact bearer matches", () => {
  assert.equal(bearerMatches(request(`Bearer ${secret}`), secret), true);
  assert.equal(bearerMatches(request(`Bearer ${secret}x`), secret), false);
  assert.equal(bearerMatches(request(secret), secret), false);
  assert.equal(bearerMatches(request(), secret), false);
});

test("a missing or short secret refuses everything", () => {
  assert.equal(bearerMatches(request("Bearer "), undefined), false);
  assert.equal(bearerMatches(request("Bearer "), ""), false);
  const short = "c".repeat(31);
  assert.equal(bearerMatches(request(`Bearer ${short}`), short), false);
});
