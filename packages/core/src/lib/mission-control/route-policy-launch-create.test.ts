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

test("launch and bonding pages are public, while drafts and launch context follow the social flag", () => {
  for (const experience of [false, true]) {
    for (const social of [false, true]) {
      for (const path of PAGES) assert.equal(decideMissionControlRoute(path, experience, social), "allow", path);
      for (const path of [...API, "/api/social/me/drafts"]) {
        assert.equal(decideMissionControlRoute(path, experience, social), social ? "allow" : "not-found", path);
      }
    }
  }
});
