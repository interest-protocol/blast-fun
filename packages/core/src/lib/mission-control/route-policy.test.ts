import assert from "node:assert/strict";
import test from "node:test";

import { decideMissionControlRoute } from "./route-policy.ts";

const CARD = "/card/0b7c6f1e-3a52-4d8e-9f10-2c4b5a6d7e8f";
const LAUNCH_ID = "0x5f1a0c3e9b7d2468ace013579bdf2468ace013579bdf2468ace013579bdf2468";

test("shared PnL pages and images stay public under every surface flag", () => {
  const path = `/card/pnl/${"a".repeat(64)}`;
  for (const experience of [false, true]) {
    for (const social of [false, true]) {
      for (const shared of [path, `${path}/image`]) {
        assert.equal(decideMissionControlRoute(shared, experience, social), "allow");
      }
    }
  }
});

test("referral card images stay public under every surface flag", () => {
  for (const experience of [false, true]) {
    for (const social of [false, true]) {
      assert.equal(decideMissionControlRoute("/referral/satoshimedici/image", experience, social), "allow");
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
    ]) assert.equal(decideMissionControlRoute(path, enabled), "allow", `${path} enabled=${enabled}`);
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
    ]) assert.equal(decideMissionControlRoute(path, enabled), "allow", `${path} enabled=${enabled}`);
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
  for (const experience of [false, true]) {
    for (const social of [false, true]) {
      for (const path of retiredPaths) {
        assert.equal(decideMissionControlRoute(path, experience, social), "not-found", path);
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
  ]) assert.equal(decideMissionControlRoute(path, false), "not-found", path);
});

test("hidden mode keeps published cards public with the landing and legal pages", () => {
  for (const path of ["/mission", "/privacy", "/terms", CARD, `${CARD}/image`]) {
    assert.equal(decideMissionControlRoute(path, false), "allow", path);
  }
  for (const path of ["/card/nova.png", "/crew/nova_7", "/new", "/closed", "/teams"]) {
    assert.equal(decideMissionControlRoute(path, false), "rewrite-mission", path);
  }
});

test("Vercel Cron maintenance routes run whether or not Mission Control is on", () => {
  for (const enabled of [false, true]) {
    assert.equal(decideMissionControlRoute("/api/mission-control/maintenance/cleanup", enabled), "allow");
  }
});

test("legacy APIs outside the retired paths still honor the API flag", () => {
  for (const path of ["/api/mission-control/restore", "/api/mission-control/completion/other"]) {
    assert.equal(decideMissionControlRoute(path, false), "not-found", path);
    assert.equal(decideMissionControlRoute(path, true), "allow", path);
  }
});

test("the retired closed page and unowned paths go to the Mission Control entry, not the launchpad", () => {
  assert.equal(decideMissionControlRoute("/closed", true), "redirect-mission");
  assert.equal(decideMissionControlRoute("/new", true), "rewrite-mission");
  assert.equal(decideMissionControlRoute("/arcade", true), "rewrite-mission");
  assert.equal(decideMissionControlRoute("/crew/nova-7", true), "rewrite-mission");
  assert.equal(decideMissionControlRoute("/card/nova.png", true), "rewrite-mission");
  assert.equal(decideMissionControlRoute(`${CARD}/secret`, true), "rewrite-mission");
  assert.equal(decideMissionControlRoute("/known-callsign", true), "rewrite-mission");
  assert.equal(decideMissionControlRoute("/unknown-callsign", true), "rewrite-mission");
  assert.equal(decideMissionControlRoute("/mission/secret", true), "rewrite-mission");
  assert.equal(decideMissionControlRoute("/coins", true), "rewrite-mission");
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

test("presale namespaces open whether Mission Control is on or off", () => {
  for (const experience of [false, true]) {
    for (const path of PRESALE_PATHS) {
      assert.equal(decideMissionControlRoute(path, experience), "allow", `${path} experience=${experience}`);
    }
  }
});

test("vesting pages and reads work independently of the social surface", () => {
  for (const path of ["/vesting", "/vesting/new", `/vesting/0x${"1".repeat(64)}`, `/api/vesting/0x${"1".repeat(64)}`]) {
    assert.equal(decideMissionControlRoute(path, false, false), "allow");
  }
});
