import assert from "node:assert/strict";
import test from "node:test";

import { creatorXLookup } from "./creator-x.ts";

test("the lookup accepts handle case differences and returns the exact string ID", async () => {
  const resolve = creatorXLookup("fixture-key", 1, async () =>
    Response.json({ id_str: "1893456789012345679", screen_name: "Mira" }),
  );

  assert.equal(await resolve("mira"), "1893456789012345679");
});

test("a lookup by numeric handle refuses a profile with a different handle", async () => {
  const resolve = creatorXLookup("fixture-key", 1, async () =>
    Response.json({ id_str: "12345678", screen_name: "SomebodyElse" }),
  );

  await assert.rejects(resolve("12345678"), { code: "creator_x_unavailable" });
});
