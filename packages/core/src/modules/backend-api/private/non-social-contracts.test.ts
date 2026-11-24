import assert from "node:assert/strict";
import test from "node:test";
import { routePattern } from "../route-path.ts";
import { NON_SOCIAL_PRIVATE_ROUTES } from "./non-social-contracts.ts";

test("retained account and recovery routes admit twelve methods and five matching HEAD reads", () => {
  const contracts = NON_SOCIAL_PRIVATE_ROUTES.map((route) => [
    route.id,
    route.method,
    route.maxBodyBytes,
  ]);
  assert.deepEqual(contracts, [
    ["mission-control.owner.card", "GET", 0],
    ["mission-control.owner", "GET", 0],
    ["mission-control.owner.recruits", "GET", 0],
    ["mission-control.owner.display-name", "PATCH", 1024],
    ["mission-control.logout", "POST", 4096],
    ["mission-control.owner.wallets", "GET", 0],
    ["mission-control.owner.wallets.primary", "PATCH", 16383],
    ["launchpad.csrf", "GET", 0],
    ["mission-control.owner.wallets.challenge", "POST", 16383],
    ["mission-control.owner.wallets.link", "POST", 16383],
    ["mission-control.restore.challenge", "PUT", 16384],
    ["mission-control.restore.verify", "POST", 16384],
    ["mission-control.owner.card", "HEAD", 0],
    ["mission-control.owner", "HEAD", 0],
    ["mission-control.owner.recruits", "HEAD", 0],
    ["mission-control.owner.wallets", "HEAD", 0],
    ["launchpad.csrf", "HEAD", 0],
  ]);
  for (const route of NON_SOCIAL_PRIVATE_ROUTES)
    assert.notEqual(route.ssrRead, true);
});

test("retired campaign routes and sibling path aliases receive no private capability", () => {
  for (const path of [
    "/api/mission-control/restore/challenge",
    "/api/mission-control/owner/share",
    "/api/mission-control/owner/codes",
    "/api/mission-control/completion",
    "/api/mission-control/completion/wallet-challenge",
    "/api/mission-control/completion/wallet-proof",
    "/api/mission-control/admission",
    "/api/mission-control/callsign",
    "/api/mission-control/telemetry",
    "/api/mission-control/owner/",
    "/api/auth/logout/",
    "/api/mission-control/season-zero",
  ])
    assert.equal(
      NON_SOCIAL_PRIVATE_ROUTES.some((route) => routePattern(route.path).test(path)),
      false,
      path,
    );
});

test("wallet proof and recovery capabilities have explicit settled sixty-second work envelopes", () => {
  const paths = [
    [
      "mission-control.owner.wallets.challenge",
      "POST",
      "/api/mission-control/owner/wallets/challenge",
    ],
    [
      "mission-control.owner.wallets.link",
      "POST",
      "/api/mission-control/owner/wallets",
    ],
    [
      "mission-control.restore.challenge",
      "PUT",
      "/api/mission-control/restore",
    ],
    ["mission-control.restore.verify", "POST", "/api/mission-control/restore"],
  ];
  for (const [id, method, path] of paths) {
    const route = NON_SOCIAL_PRIVATE_ROUTES.find(
      (candidate) =>
        candidate.id === id &&
        candidate.method === method &&
        routePattern(candidate.path).test(path!),
    );
    assert.ok(route);
    assert.equal(route.workBudgetMs, 60_000);
    assert.notEqual(route.ssrRead, true);
    assert.equal(
      NON_SOCIAL_PRIVATE_ROUTES.some(
        (candidate) =>
          candidate.method === "HEAD" && routePattern(candidate.path).test(path!),
      ),
      path === "/api/mission-control/owner/wallets",
    );
  }
});

test("owner card grants only exact GET and HEAD, zero body and settled sixty-second work", () => {
  const cards = NON_SOCIAL_PRIVATE_ROUTES.filter(
    (route) => route.id === "mission-control.owner.card",
  );
  assert.equal(cards.length, 2);
  for (const route of cards) {
    assert.ok(routePattern(route.path).test("/api/mission-control/owner/card"));
    assert.equal(routePattern(route.path).test("/api/mission-control/owner/card/"), false);
    assert.equal(
      routePattern(route.path).test("/api/mission-control/owner/card/extra"),
      false,
    );
    assert.equal(route.maxBodyBytes, 0);
    assert.equal(route.workBudgetMs, 60_000);
    assert.notEqual(route.ssrRead, true);
  }
});
