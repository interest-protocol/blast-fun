import assert from "node:assert/strict";
import test from "node:test";
import { routePattern } from "../route-path.ts";
import { NON_SOCIAL_PRIVATE_ROUTES } from "./non-social-contracts.ts";

test("only the anonymous launchpad CSRF read remains, as GET and HEAD", () => {
  assert.deepEqual(
    NON_SOCIAL_PRIVATE_ROUTES.map((route) => [route.id, route.method, route.path, route.maxBodyBytes]),
    [
      ["launchpad.csrf", "GET", "/api/launchpad/csrf", 0],
      ["launchpad.csrf", "HEAD", "/api/launchpad/csrf", 0],
    ],
  );
  for (const route of NON_SOCIAL_PRIVATE_ROUTES) assert.notEqual(route.ssrRead, true);
  assert.equal(
    NON_SOCIAL_PRIVATE_ROUTES.some((route) => routePattern(route.path).test("/api/launchpad/csrf/")),
    false,
  );
});

test("retired Mission Control routes and sibling path aliases receive no private capability", () => {
  for (const path of [
    "/api/mission-control/owner",
    "/api/mission-control/owner/card",
    "/api/mission-control/owner/recruits",
    "/api/mission-control/owner/display-name",
    "/api/mission-control/owner/wallets",
    "/api/mission-control/owner/wallets/primary",
    "/api/mission-control/owner/wallets/challenge",
    "/api/mission-control/restore",
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
    "/api/auth/logout",
    "/api/auth/logout/",
    "/api/mission-control/season-zero",
  ])
    assert.equal(
      NON_SOCIAL_PRIVATE_ROUTES.some((route) => routePattern(route.path).test(path)),
      false,
      path,
    );
});
