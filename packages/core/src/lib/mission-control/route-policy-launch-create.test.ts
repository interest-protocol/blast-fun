import assert from "node:assert/strict";
import test from "node:test";

import { decideMissionControlRoute } from "./route-policy.ts";

const PAGES = ["/launch", "/bonding"];
const API = [
  "/api/social/me/launches",
  "/api/social/me/launches/discovery",
  "/api/social/me/launches/00000000-0000-4000-8000-000000000101/publish",
  "/api/social/launch-context",
];

test("launching a coin and the bonding list answer only while the launchpad is on", () => {
  for (const experience of [false, true]) {
    for (const path of [...PAGES, ...API]) {
      assert.equal(
        decideMissionControlRoute(path, experience, true, false, true),
        "not-found",
        `${path} with the launchpad off`,
      );
    }
    for (const path of PAGES)
      assert.equal(
        decideMissionControlRoute(path, experience, true, true, true),
        "allow",
        path,
      );
    for (const path of API)
      assert.equal(
        decideMissionControlRoute(path, experience, true, true, true),
        "allow",
        path,
      );
  }
});

test("the launch API is social API: it needs the social feed on as well", () => {
  for (const path of API)
    assert.equal(
      decideMissionControlRoute(path, true, true, true, false),
      "not-found",
      path,
    );
});

test("presale drafts stay social API whatever the launchpad flag", () => {
  assert.equal(
    decideMissionControlRoute("/api/social/me/drafts", true, true, false, true),
    "allow",
  );
});
