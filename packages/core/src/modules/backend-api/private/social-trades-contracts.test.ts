import assert from "node:assert/strict";
import test from "node:test";
import { routePattern } from "../route-path.ts";
import { SOCIAL_TRADES_PRIVATE_ROUTES } from "./social-trades-contracts.ts";

test("trade transport grants only existing exact methods, bytes and finite budgets", () => {
  const samples = [
    ["GET", "/api/social/trades/coins", 0, 30_000],
    ["HEAD", "/api/social/trades/coins", 0, 30_000],
    ["POST", "/api/social/trades/quote", 4096, 120_000],
    ["POST", "/api/social/trades/curve-buy", 4096, 120_000],
    ["POST", "/api/social/trades", 4096, 180_000],
    ["POST", "/api/social/trades/00000000-0000-4000-8000-000000000001/settle", 0, 30_000],
  ] as const;
  assert.equal(SOCIAL_TRADES_PRIVATE_ROUTES.length, samples.length);
  for (const [method, path, bytes, budget] of samples) {
    const matches = SOCIAL_TRADES_PRIVATE_ROUTES.filter(route => route.method === method && routePattern(route.path).test(path));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].maxBodyBytes, bytes);
    assert.equal(matches[0].workBudgetMs ?? 30_000, budget);
    assert.notEqual(matches[0].ssrRead, true);
    assert.equal(routePattern(matches[0].path).test(path + "/extra"), false);
  }
  for (const [method, path] of [["GET", "/api/social/trades/quote"], ["HEAD", "/api/social/trades"], ["PUT", "/api/social/trades"], ["POST", "/api/social/trades/coins"]]) {
    assert.equal(SOCIAL_TRADES_PRIVATE_ROUTES.some(route => route.method === method && routePattern(route.path).test(path)), false);
  }
});
