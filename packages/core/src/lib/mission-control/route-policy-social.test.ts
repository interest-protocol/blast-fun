import assert from "node:assert/strict";
import test from "node:test";

import {
  decideMissionControlRoute,
  socialProfileTarget,
  notFoundAnswersJson,
  SOCIAL_ENTRY,
} from "./route-policy.ts";

const SOCIAL_APIS = ["/api/social", "/api/social/me", "/api/social/competitions", "/api/social/feed", "/api/social/crew/kai/follow"];
// UI-02/03: `/p/<post id>` is a post permalink.
const SOCIAL_PAGES = ["/crew", "/crew/kai", "/crew/nova_7", "/crew/kai/followers", SOCIAL_ENTRY, `${SOCIAL_ENTRY}/x`, "/notifications", "/create", "/portfolio", "/invites", "/competitions", "/competitions/sui-week", "/p/a-1200-0-0-0"];
/** A profile page's own path (OA-4: redirected to `/@<callsign>` while the feed is on). */
const PROFILE_PAGES = ["/crew/kai", "/crew/nova_7", "/crew/kai/followers", "/crew/kai/following"];
/** The canonical profile addresses (OA-4: rewritten to the profile page while the feed is on). */
const PROFILE_ALIASES = ["/@kai", "/@nova_7", "/%40kai", "/@Not-A-Callsign", "/@kai/followers", "/%40kai/following"];
test("social pages and API routes follow the social flag independently of the legacy experience", () => {
  for (const experience of [false, true]) {
    assert.equal(decideMissionControlRoute("/", experience, true), "rewrite-social");
    assert.equal(decideMissionControlRoute("/", experience, false), "allow");
    for (const path of SOCIAL_PAGES) {
      assert.equal(decideMissionControlRoute(path, experience, true), PROFILE_PAGES.includes(path) ? "redirect-profile" : "allow", path);
      assert.equal(decideMissionControlRoute(path, experience, false), "rewrite-mission", path);
    }
    for (const path of SOCIAL_APIS) {
      assert.equal(decideMissionControlRoute(path, experience, true), "allow", path);
      assert.equal(decideMissionControlRoute(path, experience, false), "not-found", path);
      assert.ok(notFoundAnswersJson(path), path);
    }
    for (const path of PROFILE_ALIASES) {
      assert.equal(decideMissionControlRoute(path, experience, true), "rewrite-profile", path);
      assert.equal(decideMissionControlRoute(path, experience, false), "rewrite-mission", path);
    }
  }
  for (const path of [...SOCIAL_PAGES, "/api/socials", "/api/socialx/me"]) assert.equal(notFoundAnswersJson(path), false, path);
});

test("profile rewrites and redirects preserve the requested profile section", () => {
  assert.equal(socialProfileTarget("/@kai"), "/crew/kai");
  assert.equal(socialProfileTarget("/%40kai"), "/crew/kai");
  assert.equal(socialProfileTarget("/crew/kai"), "/@kai");
  assert.equal(socialProfileTarget("/crew/kai/followers"), "/@kai/followers");
  assert.equal(socialProfileTarget("/@kai/following"), "/crew/kai/following");
  assert.equal(socialProfileTarget("/%40kai/followers"), "/crew/kai/followers");
  assert.equal(socialProfileTarget("/@kai/x"), null);
  assert.equal(socialProfileTarget("/"), null);
});
