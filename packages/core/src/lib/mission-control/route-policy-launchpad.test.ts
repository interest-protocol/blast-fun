import assert from "node:assert/strict";
import test from "node:test";

import {
  decideMissionControlRoute,
  notFoundAnswersJson,
  PRESALE_ENTRY,
  type MissionControlRouteDecision,
} from "./route-policy.ts";

/**
 * The base's policy (web `psb/integration` 316b472), recorded here, so
 * the launchpad-on decisions are compared with what shipped before T-031 rather
 * than with themselves.
 */
function baseDecision(pathname: string, experienceEnabled: boolean, presaleEnabled = false): MissionControlRouteDecision {
  // Admission was retired after this baseline was recorded (#1126).
  if (pathname === "/api/mission-control/admission") return "not-found";
  const always = new Set(["/", "/mission", "/privacy", "/terms"]);
  const within = (prefixes: readonly string[]) =>
    prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  if (within(["/presale", "/sign-in", "/settings", "/api/presale", "/api/account"])) {
    return presaleEnabled ? "allow" : "not-found";
  }
  if (
    always.has(pathname) ||
    within(["/coin", "/launch", "/api/launchpad", "/dev/launchpad"]) ||
    pathname.startsWith("/api/mission-control/maintenance/")
  ) {
    return "allow";
  }
  if (/^\/card\/[0-9a-f-]{36}$/i.test(pathname) || /^\/card\/[0-9a-f-]{36}\/image$/i.test(pathname)) return "allow";
  if (!experienceEnabled) {
    if (pathname.startsWith("/api/")) return "not-found";
    return "rewrite-mission";
  }
  if (pathname === "/closed") return "redirect-mission";
  if (pathname.startsWith("/api/")) return "allow";
  return "rewrite-mission";
}

const LAUNCH_ID = `0x${"5f".repeat(32)}`;
const PRESALE_ID = `0x${"ab".repeat(32)}`;
const CARD = "/card/0b7c6f1e-3a52-4d8e-9f10-2c4b5a6d7e8f";

/** Every launchpad namespace, exactly and below, including dotted sub-paths. */
const LAUNCHPAD_PATHS = [
  "/coin",
  "/coin/",
  `/coin/${LAUNCH_ID}`,
  `/coin/${LAUNCH_ID}/trades`,
  `/coin/${LAUNCH_ID}.png`,
  "/coin/pepe",
  "/launch",
  "/launch/",
  "/launch/new",
  "/launch/fixture.json",
  "/api/launchpad",
  "/api/launchpad/csrf",
  "/api/launchpad/search",
  "/api/launchpad/launches/feed.json",
];

/** Paths outside the launchpad: presale, Mission Control, legal, cards, near-misses. */
const OTHER_PATHS = [
  "/presale",
  `/presale/${PRESALE_ID}`,
  "/presale/not-a-sale",
  "/presale/",
  "/sign-in",
  "/settings",
  "/api/presale/presales",
  "/api/presale/outcomes/visitor",
  "/api/account/wallets",
  "/mission",
  "/mission/secret",
  "/api/mission-control/admission",
  "/api/mission-control/maintenance/cleanup",
  "/api/auth/logout",
  "/api/og",
  "/privacy",
  "/terms",
  "/closed",
  "/crew/nova_7",
  CARD,
  `${CARD}/image`,
  `/card/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`,
  "/coins",
  "/launches",
  "/launchpad",
  "/api/launchpads",
];

const BOTH = [false, true] as const;

test("T-031-AC-1: with the launchpad off every launchpad path and sub-path is not found, under every experience and presale flag", () => {
  for (const experience of BOTH) {
    for (const presale of BOTH) {
      for (const path of LAUNCHPAD_PATHS) {
        assert.equal(
          decideMissionControlRoute(path, experience, presale, false),
          "not-found",
          `${path} experience=${experience} presale=${presale}`,
        );
      }
    }
  }
});

test("T-031-AC-1: a missing launchpad flag is off, never on", () => {
  // A JavaScript caller (or a widened type) that drops the flag still fails closed.
  const decide = decideMissionControlRoute as (pathname: string, experience: boolean, presale?: boolean) => MissionControlRouteDecision;
  for (const experience of BOTH) {
    for (const presale of BOTH) {
      for (const path of LAUNCHPAD_PATHS) assert.equal(decide(path, experience, presale), "not-found", path);
      assert.equal(decide("/", experience, presale), presale ? "rewrite-presale" : "rewrite-home");
    }
  }
});

test("T-031-AC-2: with the launchpad off, / follows the presale flag: a rewrite to /presale, or today's home page", () => {
  assert.equal(PRESALE_ENTRY, "/presale");
  for (const experience of BOTH) {
    assert.equal(decideMissionControlRoute("/", experience, true, false), "rewrite-presale", `experience=${experience}`);
    // Production `main`'s `/`: the brand landing or Mission Control, never a 404 (the team-only test keeps the public site).
    assert.equal(decideMissionControlRoute("/", experience, false, false), "rewrite-home", `experience=${experience}`);
    assert.equal(decideMissionControlRoute("/presale", experience, false, false), "not-found", `experience=${experience}`);
  }
});

test("T-031-AC-1: with the launchpad off every other path decides exactly as the base did", () => {
  for (const experience of BOTH) {
    for (const presale of BOTH) {
      for (const path of OTHER_PATHS) {
        assert.equal(
          decideMissionControlRoute(path, experience, presale, false),
          baseDecision(path, experience, presale),
          `${path} experience=${experience} presale=${presale}`,
        );
      }
    }
  }
});

test("T-031-AC-1: with the launchpad on (exactly true) every decision equals the base's for the same flags", () => {
  for (const experience of BOTH) {
    for (const presale of BOTH) {
      for (const path of ["/", ...LAUNCHPAD_PATHS, ...OTHER_PATHS]) {
        assert.equal(
          decideMissionControlRoute(path, experience, presale, true),
          baseDecision(path, experience, presale),
          `${path} experience=${experience} presale=${presale}`,
        );
      }
    }
  }
  assert.equal(decideMissionControlRoute("/", false, false, true), "allow");
  assert.equal(decideMissionControlRoute("/launch", true, true, true), "allow");
});

test("a not-found answer on a gated API path carries the published not_found body; pages keep the empty 404", () => {
  for (const path of [
    "/api/presale",
    "/api/presale/presales",
    "/api/presale/outcomes/visitor",
    "/api/account",
    "/api/account/wallets",
    "/api/launchpad",
    "/api/launchpad/csrf",
    "/api/launchpad/launches/feed.json",
  ]) assert.equal(notFoundAnswersJson(path), true, path);
  for (const path of [
    "/",
    "/presale",
    "/presale/not-a-sale",
    "/sign-in",
    "/settings",
    "/coin",
    `/coin/${LAUNCH_ID}`,
    "/launch",
    "/dev/launchpad",
    "/dev/launchpad/fixture.json",
    "/api/presales",
    "/api/accounts",
    "/api/launchpads",
    "/api/mission-control/admission",
    "/api/og",
  ]) assert.equal(notFoundAnswersJson(path), false, path);
});
