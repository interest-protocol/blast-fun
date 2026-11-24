import assert from "node:assert/strict";
import test from "node:test";
import { routePattern } from "../route-path.ts";
import { SOCIAL_COINS_PRIVATE_ROUTES } from "./social-coins-contracts.ts";

test("coins capabilities preserve exact methods, budgets and no SSR", () => {
  // A transfer may carry its signed transaction bytes as proof, which `readDigestJson` bounds at 192 KiB.
  assert.deepEqual(SOCIAL_COINS_PRIVATE_ROUTES.map(({ method, maxBodyBytes, workBudgetMs, ssrRead }) => [method, maxBodyBytes, workBudgetMs, ssrRead]), [
    ["GET", 0, 60_000, undefined], ["HEAD", 0, 60_000, undefined], ["PUT", 192 * 1024, 60_000, undefined],
  ]);
  assert.equal(routePattern(SOCIAL_COINS_PRIVATE_ROUTES[2]!.path).test("/api/social/me/transfers/id/extra"), false);
  assert.equal(routePattern(SOCIAL_COINS_PRIVATE_ROUTES[2]!.path).test("/api/social/me/transfers/id"), true);
});
