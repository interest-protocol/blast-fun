import assert from "node:assert/strict";
import test from "node:test";

import {
  decideMissionControlRoute,
  socialProfileTarget,
  notFoundAnswersJson,
  SOCIAL_ENTRY,
  type MissionControlRouteDecision,
} from "./route-policy.ts";

/**
 * The T-031 policy (web `psb/integration` 1175623), recorded here, so
 * the social-off decisions are compared with what shipped before T-006 rather
 * than with themselves.
 */
function t031Decision(
  pathname: string,
  experienceEnabled: boolean,
  presaleEnabled: boolean,
  launchpadEnabled: boolean,
): MissionControlRouteDecision {
  // Admission was retired after this baseline was recorded (#1126).
  if (pathname === "/api/mission-control/admission") return "not-found";
  const within = (prefixes: readonly string[]) =>
    prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  const launchpad = within(["/coin", "/launch", "/api/launchpad", "/dev/launchpad"]);
  if (within(["/presale", "/sign-in", "/settings", "/api/presale", "/api/account"])) {
    return presaleEnabled ? "allow" : "not-found";
  }
  if (!launchpadEnabled && launchpad) return "not-found";
  if (!launchpadEnabled && pathname === "/") return presaleEnabled ? "rewrite-presale" : "rewrite-home";
  const always = new Set(["/", "/mission", "/privacy", "/terms"]);
  if (always.has(pathname) || launchpad || pathname.startsWith("/api/mission-control/maintenance/")) return "allow";
  if (/^\/card\/[0-9a-f-]{36}$/i.test(pathname) || /^\/card\/[0-9a-f-]{36}\/image$/i.test(pathname)) return "allow";
  return t031ExperienceDecision(pathname, experienceEnabled);
}

function t031ExperienceDecision(pathname: string, experienceEnabled: boolean): MissionControlRouteDecision {
  if (!experienceEnabled) return pathname.startsWith("/api/") ? "not-found" : "rewrite-mission";
  if (pathname === "/closed") return "redirect-mission";
  if (pathname.startsWith("/api/")) return "allow";
  return "rewrite-mission";
}

const SOCIAL_APIS = ["/api/social", "/api/social/me", "/api/social/competitions", "/api/social/feed", "/api/social/crew/kai/follow"];
// UI-02/03: `/p/<post id>` is a post permalink.
const SOCIAL_PAGES = ["/crew", "/crew/kai", "/crew/nova_7", "/crew/kai/followers", SOCIAL_ENTRY, `${SOCIAL_ENTRY}/x`, "/notifications", "/create", "/portfolio", "/invites", "/competitions", "/competitions/sui-week", "/p/a-1200-0-0-0"];
/** A profile page's own path (OA-4: redirected to `/@<callsign>` while the feed is on). */
const PROFILE_PAGES = ["/crew/kai", "/crew/nova_7", "/crew/kai/followers", "/crew/kai/following"];
/** The canonical profile addresses (OA-4: rewritten to the profile page while the feed is on). */
const PROFILE_ALIASES = ["/@kai", "/@nova_7", "/%40kai", "/@Not-A-Callsign", "/@kai/followers", "/%40kai/following"];
/** Paths the social feed must never take over, near-misses included. */
const OTHER_PATHS = [
  "/presale",
  "/sign-in",
  "/settings",
  "/api/presale/presales",
  "/api/account/wallets",
  "/coin",
  "/launch",
  "/api/launchpad/csrf",
  "/mission",
  "/api/mission-control/admission",
  "/privacy",
  "/closed",
  "/card/0b7c6f1e-3a52-4d8e-9f10-2c4b5a6d7e8f",
  "/crews",
  "/feeds",
  "/pa",
  "/portfolios",
  "/api/socials",
  "/api/socialx/me",
];

const BOTH = [false, true] as const;
const each = (visit: (experience: boolean, presale: boolean, launchpad: boolean) => void) => {
  for (const experience of BOTH) for (const presale of BOTH) for (const launchpad of BOTH) visit(experience, presale, launchpad);
};

test("T-006-AC-1: with the social feed and the presale on, / rewrites to the feed, /crew/* and /api/social/* are let through", () => {
  assert.equal(SOCIAL_ENTRY, "/feed");
  for (const experience of BOTH) {
    for (const launchpad of BOTH) {
      const flags = `experience=${experience} launchpad=${launchpad}`;
      assert.equal(decideMissionControlRoute("/", experience, true, launchpad, true), "rewrite-social", flags);
      for (const path of SOCIAL_PAGES) {
        // OA-4: a profile's own path redirects to its `/@<callsign>` address.
        const expected = PROFILE_PAGES.includes(path) ? "redirect-profile" : "allow";
        assert.equal(decideMissionControlRoute(path, experience, true, launchpad, true), expected, `${path} ${flags}`);
      }
      for (const path of SOCIAL_APIS) assert.equal(decideMissionControlRoute(path, experience, true, launchpad, true), "allow", `${path} ${flags}`);
    }
  }
});

test("T-006-AC-1: with the social feed on, every other path decides as T-031 did", () => {
  each((experience, presale, launchpad) => {
    for (const path of OTHER_PATHS) {
      assert.equal(
        decideMissionControlRoute(path, experience, presale, launchpad, true),
        t031Decision(path, experience, presale, launchpad),
        `${path} experience=${experience} presale=${presale} launchpad=${launchpad}`,
      );
    }
  });
});

test("T-006-AC-2: with the social feed off, /, /crew/* and every page decide exactly as T-031 did", () => {
  each((experience, presale, launchpad) => {
    for (const path of ["/", ...SOCIAL_PAGES, ...PROFILE_ALIASES, ...OTHER_PATHS]) {
      const expected = t031Decision(path, experience, presale, launchpad);
      const flags = `${path} experience=${experience} presale=${presale} launchpad=${launchpad}`;
      assert.equal(decideMissionControlRoute(path, experience, presale, launchpad, false), expected, flags);
      // A caller that omits the flag gets the same answer: off, never on.
      assert.equal(decideMissionControlRoute(path, experience, presale, launchpad), expected, flags);
    }
  });
  // `/crew/*` still reaches Mission Control.
  assert.equal(decideMissionControlRoute("/crew/kai", false, true, false, false), "rewrite-mission");
  assert.equal(decideMissionControlRoute("/crew/kai", true, true, true, false), "rewrite-mission");
});

test("T-006-AC-2: the social feed needs the presale: with the presale off it behaves as if it were off", () => {
  each((experience, _presale, launchpad) => {
    for (const path of ["/", ...SOCIAL_PAGES, ...PROFILE_ALIASES, ...OTHER_PATHS]) {
      assert.equal(
        decideMissionControlRoute(path, experience, false, launchpad, true),
        t031Decision(path, experience, false, launchpad),
        `${path} experience=${experience} launchpad=${launchpad}`,
      );
    }
    for (const path of SOCIAL_APIS) assert.equal(decideMissionControlRoute(path, experience, false, launchpad, true), "not-found", path);
  });
});

test("T-006-AC-2: with the social feed off, /api/social/* is not found under every other flag, with the JSON body", () => {
  each((experience, presale, launchpad) => {
    for (const path of SOCIAL_APIS) {
      assert.equal(decideMissionControlRoute(path, experience, presale, launchpad, false), "not-found", path);
      assert.equal(notFoundAnswersJson(path), true, path);
    }
  });
  // Pages keep the empty 404; near-miss APIs are not the social namespace.
  for (const path of [...SOCIAL_PAGES, "/api/socials", "/api/socialx/me"]) assert.equal(notFoundAnswersJson(path), false, path);
});

test("OA-4: with the social feed and the presale on, /@<callsign> rewrites to the profile page and /crew/<callsign> redirects to it", () => {
  each((experience, _presale, launchpad) => {
    const flags = `experience=${experience} launchpad=${launchpad}`;
    for (const path of PROFILE_ALIASES) assert.equal(decideMissionControlRoute(path, experience, true, launchpad, true), "rewrite-profile", `${path} ${flags}`);
    for (const path of PROFILE_PAGES) assert.equal(decideMissionControlRoute(path, experience, true, launchpad, true), "redirect-profile", `${path} ${flags}`);
    // Deeper paths and near-misses are not profiles.
    for (const path of ["/@", "/@kai/calls", "/crew", "/crew/", "/crew/kai/followers/extra", "/x/@kai"]) {
      assert.notEqual(decideMissionControlRoute(path, experience, true, launchpad, true), "rewrite-profile", path);
      assert.notEqual(decideMissionControlRoute(path, experience, true, launchpad, true), "redirect-profile", path);
    }
  });
  assert.equal(socialProfileTarget("/@kai"), "/crew/kai");
  assert.equal(socialProfileTarget("/%40kai"), "/crew/kai");
  assert.equal(socialProfileTarget("/crew/kai"), "/@kai");
  assert.equal(socialProfileTarget("/crew/kai/followers"), "/@kai/followers");
  assert.equal(socialProfileTarget("/@kai/following"), "/crew/kai/following");
  assert.equal(socialProfileTarget("/%40kai/followers"), "/crew/kai/followers");
  assert.equal(socialProfileTarget("/@kai/x"), null);
  assert.equal(socialProfileTarget("/"), null);
});

test("OA-4: with the social feed or the presale off, /@<callsign> and /crew/<callsign> decide as before", () => {
  each((experience, presale, launchpad) => {
    for (const path of [...PROFILE_ALIASES, ...PROFILE_PAGES]) {
      const off = decideMissionControlRoute(path, experience, presale, launchpad, false);
      assert.equal(off, t031Decision(path, experience, presale, launchpad), path);
      if (!presale) assert.equal(decideMissionControlRoute(path, experience, false, launchpad, true), off, path);
    }
  });
});

test("the retired posts page is not found under every launch flag", () => {
  each((experience, presale, launchpad) => {
    for (const social of BOTH) for (const path of ["/posts", "/posts/older"]) {
      assert.equal(decideMissionControlRoute(path, experience, presale, launchpad, social), "not-found");
    }
  });
});
