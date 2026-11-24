import assert from "node:assert/strict";
import test from "node:test";
import { routeParams, routeSegments } from "./route-path.ts";

const PATH = "/api/social/items/:entry_id/reactions/:reaction";

test("routeParams reads each named segment once-decoded and leaves validation to the handler", () => {
  assert.equal(routeParams(PATH, "/api/social/items/a/reactions"), null);
  assert.equal(routeParams(PATH, "/api/social/items/a/likes/rocket"), null);
  assert.equal(routeParams(PATH, "/api/social/items/a/reactions/rocket/x"), null);
  assert.deepEqual(routeParams(PATH, "/api/social/items/a%3A1/reactions/"), { entry_id: "a:1", reaction: "" });
  assert.deepEqual(routeParams(PATH, "/api/social/items/%E0%A4%A/reactions/rocket"), { entry_id: null, reaction: "rocket" });
  assert.deepEqual(routeParams(PATH, "/api/social/items/%2541/reactions/rocket"), { entry_id: "%41", reaction: "rocket" });
  assert.deepEqual(routeSegments(PATH, "/api/social/items/%2541/reactions/rocket"), { entry_id: "%2541", reaction: "rocket" });
  assert.equal(routeParams(PATH, "/x/api/social/items/a/reactions/rocket"), null);
  assert.equal(routeSegments("/a.b/:x", "/aXb/1"), null);
  assert.deepEqual(routeSegments("/a.b/:x", "/a.b/1"), { x: "1" });
});
