import assert from "node:assert/strict";
import test from "node:test";

import { entryIdOfPost, postIdOf, postPath, socialItemPath, socialReactionPath } from "@blast/core/modules/social/contracts/item-routes.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { itemPathParameters } from "@blast/server/modules/social/posts/route.ts";

/** UI-02/03: item and reaction path parsing. The route files are generated and checked by test/relay-routes.test.ts. */

test("T-010: path parameters are one decoded segment each; a bad one names its parameter", () => {
  const parse = (path: string, withReaction: boolean) => itemPathParameters(new Request(`https://blast.fun${path}`), withReaction);
  assert.deepEqual(parse(socialReactionPath("a:12:0:0:0", "rocket"), true), { entryId: "a:12:0:0:0", reaction: "rocket" });
  assert.deepEqual(parse(socialItemPath(`l:0x${"ab".repeat(32)}:funded`), false), { entryId: `l:0x${"ab".repeat(32)}:funded`, reaction: null });
  assert.equal(socialReactionPath("a:12:0:0:0", "rocket"), "/api/social/items/a%3A12%3A0%3A0%3A0/reactions/rocket");
  const refused = (path: string, withReaction: boolean, parameter: string) =>
    assert.throws(() => parse(path, withReaction), (error: unknown) =>
      error instanceof SocialRouteError && error.code === "invalid_parameter" && error.extra.parameter === parameter, path);
  refused("/api/social/items/x%3A1", false, "entry_id");
  refused("/api/social/items/", false, "entry_id");
  refused("/api/social/items/a%3A1/extra", false, "entry_id");
  refused("/api/social/items/%E0%A4%A", false, "entry_id");
  refused("/api/social/items/a%3A1/reactions/Rocket", true, "reaction");
  refused("/api/social/items/a%3A1/reactions/", true, "reaction");
  refused("/api/social/items/a%3A1/likes/rocket", true, "entry_id");
  refused(`/api/social/items/a%3A${"1".repeat(300)}/reactions/rocket`, true, "entry_id");
});

test("UI-03: a post's permalink id is the entry id with `-` for `:`, reversible and stable", () => {
  for (const entryId of ["a:290:1:0:0", `l:0x${"ab".repeat(32)}:migrated`, `m:0x${"cd".repeat(32)}:participants:1000`]) {
    assert.equal(entryIdOfPost(postIdOf(entryId)), entryId);
    assert.equal(postPath(entryId), `/p/${postIdOf(entryId)}`);
    assert.doesNotMatch(postIdOf(entryId), /:/);
  }
  for (const bad of ["", "a:1:0:0:0", "z-1", "a-", "a-1 2", "x".repeat(300)]) assert.equal(entryIdOfPost(bad), null, bad);
});
