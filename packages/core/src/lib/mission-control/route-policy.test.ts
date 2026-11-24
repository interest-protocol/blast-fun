import assert from "node:assert/strict";
import test from "node:test";

import { decideMissionControlRoute } from "./route-policy.ts";

// These tests pin the base's decisions with the launchpad on
// (`BLAST_LAUNCHPAD_ENABLED=true`, T-031). With it off, launchpad namespaces are
// not found and `/` follows the presale flag: route-policy-launchpad.test.ts.
function launchpadOn(pathname: string, experienceEnabled: boolean, presaleEnabled?: boolean) {
  return decideMissionControlRoute(pathname, experienceEnabled, presaleEnabled ?? false, true);
}

const CARD = "/card/0b7c6f1e-3a52-4d8e-9f10-2c4b5a6d7e8f";
const LAUNCH_ID = "0x5f1a0c3e9b7d2468ace013579bdf2468ace013579bdf2468ace013579bdf2468";

test("shared PnL pages and images stay public under every surface flag", () => {
  const path = `/card/pnl/${"a".repeat(64)}`;
  for (const experience of [false, true]) for (const presale of [false, true]) {
    for (const launchpad of [false, true]) for (const social of [false, true]) {
      for (const shared of [path, `${path}/image`]) {
        assert.equal(decideMissionControlRoute(shared, experience, presale, launchpad, social), "allow");
      }
    }
  }
});

test("referral card images stay public under every surface flag", () => {
  for (const experience of [false, true]) for (const presale of [false, true]) {
    for (const launchpad of [false, true]) for (const social of [false, true]) {
      assert.equal(decideMissionControlRoute("/referral/satoshimedici/image", experience, presale, launchpad, social), "allow");
    }
  }
});

test("public launchpad pages and APIs belong to the launchpad in both Mission Control states", () => {
  for (const enabled of [false, true]) {
    for (const path of [
      "/",
      `/coin/${LAUNCH_ID}`,
      "/launch",
      "/api/launchpad",
      "/api/launchpad/launches",
      "/api/launchpad/launches/feed.json",
    ]) assert.equal(launchpadOn(path, enabled), "allow", `${path} enabled=${enabled}`);
  }
});

test("malformed coin routes and unknown launchpad subpaths reach the launchpad's App Router 404, never Mission Control", () => {
  for (const enabled of [false, true]) {
    for (const path of [
      "/coin",
      "/coin/",
      "/coin/pepe",
      "/coin/0x2",
      `/coin/${LAUNCH_ID.toUpperCase()}`,
      `/coin/${LAUNCH_ID}/`,
      `/coin/${LAUNCH_ID}/trades`,
      `/coin/${LAUNCH_ID}.png`,
      "/launch/",
      "/launch/new",
    ]) assert.equal(launchpadOn(path, enabled), "allow", `${path} enabled=${enabled}`);
  }
});

test("retired pages, password routes, and signup APIs are not found under every surface flag", () => {
  const retiredPaths = [
    "/dev",
    "/dev/launchpad",
    "/dev/launchpad/fixture.json",
    "/dev/social",
    "/dev/social/shell",
    "/dev/other",
    "/team",
    "/team/child",
    "/api/team-access",
    "/mission-control/auth",
    "/mission-control/bedroom-day-2000.webp",
    "/api/mission-control/admission",
    "/api/mission-control/callsign",
    "/api/mission-control/completion",
    "/api/mission-control/completion/wallet-challenge",
    "/api/mission-control/completion/wallet-proof",
    "/api/mission-control/owner/share",
  ];
  for (const experience of [false, true]) for (const presale of [false, true]) {
    for (const launchpad of [false, true]) for (const social of [false, true]) {
      for (const path of retiredPaths) {
        assert.equal(decideMissionControlRoute(path, experience, presale, launchpad, social), "not-found", path);
      }
    }
  }
});

test("hidden mode blocks Mission Control APIs and assets, including dotted paths", () => {
  for (const path of [
    "/api/auth/logout",
    "/api/mission-control/admission",
    "/api/mission-control/owner",
    "/api/mission-control/owner/share",
    "/api/mission-control/slush-wallet-metadata",
    "/api/mission-control/telemetry",
    "/api/og",
    "/mission-control/auth",
    "/mission-control/bedroom-day-2000.webp",
  ]) assert.equal(launchpadOn(path, false), "not-found", path);
});

test("hidden mode keeps published cards public with the landing and legal pages", () => {
  for (const path of ["/mission", "/privacy", "/terms", CARD, `${CARD}/image`]) {
    assert.equal(launchpadOn(path, false), "allow", path);
  }
  for (const path of ["/card/nova.png", "/crew/nova_7", "/new", "/closed", "/teams"]) {
    assert.equal(launchpadOn(path, false), "rewrite-mission", path);
  }
});

test("Vercel Cron maintenance routes run whether or not Mission Control is on", () => {
  for (const enabled of [false, true]) {
    assert.equal(launchpadOn("/api/mission-control/maintenance/cleanup", enabled), "allow");
  }
});

test("legacy APIs outside the retired paths still honor the API flag", () => {
  for (const path of ["/api/mission-control/restore", "/api/mission-control/completion/other"]) {
    assert.equal(launchpadOn(path, false), "not-found", path);
    assert.equal(launchpadOn(path, true), "allow", path);
  }
});

test("the retired closed page and unowned paths go to the Mission Control entry, not the launchpad", () => {
  assert.equal(launchpadOn("/closed", true), "redirect-mission");
  assert.equal(launchpadOn("/new", true), "rewrite-mission");
  assert.equal(launchpadOn("/arcade", true), "rewrite-mission");
  assert.equal(launchpadOn("/crew/nova-7", true), "rewrite-mission");
  assert.equal(launchpadOn("/card/nova.png", true), "rewrite-mission");
  assert.equal(launchpadOn(`${CARD}/secret`, true), "rewrite-mission");
  assert.equal(launchpadOn("/known-callsign", true), "rewrite-mission");
  assert.equal(launchpadOn("/unknown-callsign", true), "rewrite-mission");
  assert.equal(launchpadOn("/mission/secret", true), "rewrite-mission");
  assert.equal(launchpadOn("/coins", true), "rewrite-mission");
});

const PRESALE_ID = `0x${"ab".repeat(32)}`;
const PRESALE_PATHS = [
  "/presale",
  `/presale/${PRESALE_ID}`,
  `/presale/${PRESALE_ID}/receipt/${PRESALE_ID}`,
  "/presale/allowlists/new",
  "/presale/abc",
  "/sign-in",
  "/sign-in/callback",
  "/settings",
  "/settings/theme",
  "/api/presale",
  "/api/presale/presales",
  `/api/presale/presales/${PRESALE_ID}/proof`,
  "/api/account",
  "/api/account/settings",
];

test("presale namespaces open with their flag whether Mission Control is on or off", () => {
  for (const experience of [false, true]) {
    for (const path of PRESALE_PATHS) {
      assert.equal(launchpadOn(path, experience, true), "allow", `${path} experience=${experience}`);
    }
  }
});

test("presale namespaces are not found while their flag is off", () => {
  for (const experience of [false, true]) {
    for (const path of PRESALE_PATHS) {
      assert.equal(launchpadOn(path, experience, false), "not-found", `${path} experience=${experience}`);
      assert.equal(launchpadOn(path, experience), "not-found", `${path} default flag`);
    }
  }
});

// Deliberately changed by T-031: this holds with the launchpad on only. With it
// off, `/` follows the presale flag (rewritten to `/presale`, or not found), and
// `/launch` is not found under either presale value.
test("with the launchpad on, the presale flag changes no other path's decision", () => {
  for (const experience of [false, true]) {
    for (const path of [
      "/",
      "/launch",
      "/team",
      "/closed",
      "/presales",
      "/presale-old",
      "/settingsx",
      "/sign-up",
      "/api/presales",
      "/api/accounts",
      "/api/auth/logout",
      "/api/mission-control/admission",
      "/api/mission-control/maintenance/cleanup",
      "/mission-control/auth",
      CARD,
      `${CARD}/image`,
    ]) {
      assert.equal(
        launchpadOn(path, experience, true),
        launchpadOn(path, experience, false),
        `${path} experience=${experience}`,
      );
    }
  }
});

test("public vesting pages and reads use the presale release flag without requiring the social surface", () => {
  for (const path of ["/vesting", "/vesting/new", `/vesting/0x${"1".repeat(64)}`, `/api/vesting/0x${"1".repeat(64)}`]) {
    assert.equal(decideMissionControlRoute(path, false, true, false, false), "allow");
    assert.equal(decideMissionControlRoute(path, false, false, false, false), "not-found");
  }
});
