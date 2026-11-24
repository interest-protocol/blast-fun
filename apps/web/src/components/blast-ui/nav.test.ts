import assert from "node:assert/strict";
import test from "node:test";

import { isHomePath, PORTFOLIO_PATH, profileCallsignOf, profilePath, shellNavKeyFor } from "./nav.ts";

test("UI-01: the current rail item, from the browser's path or the server's rewrite target", () => {
  assert.equal(shellNavKeyFor("/", null), "home");
  assert.equal(shellNavKeyFor("/feed", null), "home");
  assert.equal(shellNavKeyFor("/presale", null), "presales");
  assert.equal(shellNavKeyFor("/presale/0xabc", null), "presales");
  // OA-41 (R3-73): Portfolio is an item; Settings is not, and on it Profile is current (the gate's `curKey`).
  assert.equal(shellNavKeyFor("/portfolio", "kai"), "portfolio");
  assert.equal(shellNavKeyFor("/portfolio", null), "portfolio");
  assert.equal(shellNavKeyFor("/settings", "kai"), "profile");
  assert.equal(shellNavKeyFor("/invites", "kai"), "profile");
  assert.equal(shellNavKeyFor("/settings/wallets", "kai"), "profile");
  assert.equal(shellNavKeyFor("/notifications", "kai"), "alerts");
  assert.equal(shellNavKeyFor("/@kai", "kai"), "profile");
  assert.equal(shellNavKeyFor("/crew/kai", "kai"), "profile");
  // Someone else's profile (or any profile for a visitor) belongs to Home, as the design's navKey places it (UI-06).
  assert.equal(shellNavKeyFor("/@nova", "kai"), "home");
  assert.equal(shellNavKeyFor("/@kai", null), "home");
  // Another page: no current item.
  assert.equal(shellNavKeyFor("/sign-in", "kai"), null);
  assert.equal(shellNavKeyFor("/portfolios", "kai"), null);
  assert.equal(shellNavKeyFor(null, "kai"), null);
});

test("UI-01 (OA-4): profile links are /@<callsign>; only a callsign-shaped segment is a profile", () => {
  assert.equal(profilePath("kai"), "/@kai");
  assert.equal(profileCallsignOf("/@kai"), "kai");
  assert.equal(profileCallsignOf("/crew/kai_01"), "kai_01");
  assert.equal(profileCallsignOf("/%40kai"), null);
  assert.equal(profileCallsignOf("/@kai/calls"), null);
  assert.equal(profileCallsignOf("/@K"), null);
  assert.equal(profileCallsignOf("/@%E0%A4%A"), null);
  assert.equal(isHomePath("/"), true);
  assert.equal(isHomePath("/feed"), true);
  assert.equal(isHomePath("/settings"), false);
});

test("R3-73 (OA-41): Portfolio's path is R3-74's page", () => {
  assert.equal(PORTFOLIO_PATH, "/portfolio");
});

test("the removed posts route is not a Home destination", () => {
  assert.equal(shellNavKeyFor("/posts", null), null);
  assert.equal(isHomePath("/posts"), false);
});

test("Launch and the bonding list belong to the rail's Bonding", () => {
  assert.equal(shellNavKeyFor("/bonding", null), "bonding");
  assert.equal(shellNavKeyFor("/launch", null), "bonding");
});


test("a permanent launch URL stays under Bonding across graduation", () => {
  assert.equal(shellNavKeyFor("/coin/0x123", null), "bonding");
});

test("every page path resolves to the same rail item and Home check, browser path or rewrite target", () => {
  const rows: readonly (readonly [string | null, ReturnType<typeof shellNavKeyFor>, boolean])[] = [
    ["/", "home", true],
    ["/feed", "home", true],
    ["/feed/", null, false],
    ["/presale", "presales", false],
    ["/presale/", "presales", false],
    ["/presale/0x1", "presales", false],
    ["/notifications", "alerts", false],
    ["/notifications/x", "alerts", false],
    ["/portfolio", "portfolio", false],
    ["/portfolio/claims", "portfolio", false],
    ["/portfolio/vestings", "portfolio", false],
    ["/settings", "profile", false],
    ["/settings/x", "profile", false],
    ["/invites", "profile", false],
    ["/@kai", "profile", false],
    ["/@kai/", "profile", false],
    ["/crew/kai", "profile", false],
    ["/crew/kai/", "profile", false],
    ["/crew/kai/followers", null, false],
    ["/@nova", "home", false],
    ["/coin/x", "bonding", false],
    ["/x", null, false],
    [null, null, false],
  ];
  for (const [path, key, home] of rows) {
    assert.equal(shellNavKeyFor(path, "kai"), key, String(path));
    assert.equal(isHomePath(path), home, String(path));
  }
});
