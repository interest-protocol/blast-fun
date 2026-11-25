import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SOCIAL_CALLSIGN_PATTERN } from "@blast/core/modules/social/contracts/accounts.ts";
import {
  SOCIAL_FOLLOW_ACCOUNT_PREFIX,
  socialFollowPath,
} from "@blast/core/modules/social/contracts/follows.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { followPathParameter } from "@blast/server/modules/social/follows/route.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/** Social-feed T-009-AC-2 (AC-034): the follow routes, as Next's file routes publish them. */

const SOCIAL_API = fileURLToPath(new URL("../../../app/api/social/", import.meta.url));

/** Every `route.ts` under `src/app/api/social`, as its path segments. */
function socialRoutes(directory = SOCIAL_API): string[][] {
  const routes: string[][] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) routes.push(...socialRoutes(path));
    else if (entry.name === "route.ts") routes.push(relative(SOCIAL_API, directory).split("/"));
  }
  return routes;
}

test("T-009-AC-2 (AC-034): the follow routes take a callsign or a presale id, never an address", async () => {
  const routes = socialRoutes();
  const follows = routes.filter((segments) => segments[0] === "follows").map((segments) => segments.join("/")).sort();
  assert.deepEqual(follows, ["follows/account/[callsign]", "follows/presale/[presale_id]"]);
  // No social route at all has an address-like path parameter or segment. The exceptions are
  // T-017's static `me/wallets` (linking the caller's own wallet; the address travels in the body)
  // and UI-14's static `me/wallet` (the caller's own Blast wallet; it names no address), and the
  // static `me/following/wallets` (the named wallets of the caller's follows; it takes no address).
  for (const segments of routes) {
    const path = segments.join("/");
    if (path === "me/wallets" || path === "me/wallets/challenge" || path === "me/wallet" || path === "me/following/wallets") continue;
    for (const segment of segments) {
      assert.doesNotMatch(segment, /address|wallet/i, path);
    }
  }
  for (const route of follows) {
    const handlers = await import(join(SOCIAL_API, route, "route.ts"));
    const methods = Object.entries(handlers).filter(([, value]) => typeof value === "function").map(([name]) => name);
    assert.deepEqual(methods, ["DELETE", "PUT"], route);
  }
});

test("T-009-AC-2: an address is never a callsign; path parameters are one decoded, well-formed segment", () => {
  const address = `0x${"1a2b".padStart(64, "0")}`;
  assert.equal(SOCIAL_CALLSIGN_PATTERN.test(address), false);
  assert.equal(SUI_OBJECT_ID_PATTERN.test(address), true);
  const parse = (path: string) =>
    followPathParameter(new Request(`https://blast.fun${path}`), SOCIAL_FOLLOW_ACCOUNT_PREFIX, SOCIAL_CALLSIGN_PATTERN, "callsign");
  assert.equal(parse(socialFollowPath({ kind: "account", callsign: "kai_9" })), "kai_9");
  for (const path of [
    socialFollowPath({ kind: "account", callsign: address }),
    "/api/social/follows/account/",
    "/api/social/follows/account/kai/x",
    "/api/social/follows/account/%ZZ",
    "/api/social/follows/account/KAI",
    "/api/social/follows/presale/kai",
  ]) {
    assert.throws(
      () => parse(path),
      (error) => error instanceof SocialRouteError && error.code === "invalid_parameter" && error.extra.parameter === "callsign",
      path,
    );
  }
  assert.equal(
    socialFollowPath({ kind: "presale", presale_id: address }),
    `/api/social/follows/presale/${address}`,
  );
});

test("T-009-AC-4 (AC-125): the published viewer-state request schema bounds each list at 50 well-formed ids", () => {
  const validator = createSocialValidator();
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `a:${i}:0:0:0`);
  assert.deepEqual(validator.validate("viewer-state-request", {}).errors, []);
  assert.deepEqual(
    validator.validate("viewer-state-request", { entry_ids: ids(50), callsigns: ["kai"], presale_ids: [`0x${"ab".repeat(32)}`] }).errors,
    [],
  );
  for (const body of [{ entry_ids: ids(51) }, { callsigns: [`0x${"ab".repeat(32)}`] }, { addresses: [] }, { presale_ids: ["0xAB"] }]) {
    assert.equal(validator.validate("viewer-state-request", body).valid, false, JSON.stringify(body).slice(0, 60));
  }
});
