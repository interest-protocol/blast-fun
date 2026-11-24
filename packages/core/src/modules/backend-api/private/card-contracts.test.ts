import assert from "node:assert/strict";
import test from "node:test";
import { privateRoute } from "../private-routes.ts";

const id = "01234567-89ab-4cde-8fab-0123456789ab";

test("card owners expose only reviewed read methods and body-free capabilities", () => {
  for (const [path, owner, budget] of [
    ["/api/social/card-identities", "social.card-identities", undefined],
    ["/api/social/me/card", "social.owner-card", 60_000],
    [`/card/${id}/image`, "mission-control.card.image", 60_000],
    [`/card/pnl/${"a".repeat(64)}/image`, "social.pnl-card.image", 60_000],
  ] as const) {
    for (const method of ["GET", "HEAD"]) {
      const route = privateRoute(method, path, "browser");
      assert.equal(route?.id, owner);
      assert.equal(route?.maxBodyBytes, 0);
      assert.equal(route?.workBudgetMs, budget);
      assert.equal(privateRoute(method, path, "ssr-read"), null);
    }
    assert.equal(privateRoute("POST", path, "browser"), null);
    assert.equal(privateRoute("GET", path + "/extra", "browser"), null);
  }
});

test("published card page is a separate SSR-only capability", () => {
  const path = `/api/mission-control/card-page/${id}`;
  const route = privateRoute("GET", path, "ssr-read");
  assert.equal(route?.id, "mission-control.card.page");
  assert.equal(route?.ssrOnly, true);
  assert.equal(route?.maxBodyBytes, 0);
  assert.equal(privateRoute("GET", path, "browser"), null);
  assert.equal(privateRoute("HEAD", path, "ssr-read"), null);
  assert.equal(privateRoute("POST", path, "ssr-read"), null);
});

test("PnL publishing has only the original bounded POST and SSR has no browser authority", () => {
  const route = privateRoute("POST", "/api/social/me/pnl/card", "browser");
  assert.equal(route?.id, "social.pnl-card.publish");
  assert.equal(route?.maxBodyBytes, 4194304);
  assert.equal(route?.workBudgetMs, 60_000);
  assert.equal(privateRoute("GET", "/api/social/me/pnl/card", "browser"), null);
  const path = `/api/social/pnl-card-page/${"a".repeat(64)}`;
  assert.equal(
    privateRoute("GET", path, "ssr-read")?.id,
    "social.pnl-card.page",
  );
  assert.equal(privateRoute("GET", path, "browser"), null);
  assert.equal(privateRoute("HEAD", path, "ssr-read"), null);
});
