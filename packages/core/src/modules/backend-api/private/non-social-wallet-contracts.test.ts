import assert from "node:assert/strict";
import test from "node:test";
import { routePattern } from "../route-path.ts";
import { NON_SOCIAL_PRIVATE_ROUTES } from "./non-social-contracts.ts";

test("wallet list/primary and anonymous CSRF expose only the approved five capabilities", () => {
  const routes = NON_SOCIAL_PRIVATE_ROUTES.filter(
    (route) =>
      route.id === "mission-control.owner.wallets" ||
      route.id === "mission-control.owner.wallets.primary" ||
      route.id === "launchpad.csrf",
  );
  assert.deepEqual(
    routes.map((route) => [route.id, route.method, route.maxBodyBytes]),
    [
      ["mission-control.owner.wallets", "GET", 0],
      ["mission-control.owner.wallets.primary", "PATCH", 16383],
      ["launchpad.csrf", "GET", 0],
      ["mission-control.owner.wallets", "HEAD", 0],
      ["launchpad.csrf", "HEAD", 0],
    ],
  );
  assert.ok(routes.every((route) => !route.ssrRead));
  for (const path of [
    "/api/mission-control/owner/wallets/challenge",
    "/api/mission-control/owner/wallets/primary/",
    "/api/launchpad/csrf/",
  ]) {
    assert.equal(
      routes.some((route) => routePattern(route.path).test(path)),
      false,
      path,
    );
  }
  assert.equal(
    routes.some((route) => route.method === "POST"),
    false,
  );
});
