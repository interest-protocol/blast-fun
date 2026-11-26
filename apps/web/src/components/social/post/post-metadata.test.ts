import assert from "node:assert/strict";
import test from "node:test";

import { feedItem, FIXTURE_NOW } from "../../../../test/fixtures/social/feed-fixtures.ts";
import { postMetadata } from "./post-metadata.ts";

const POST_ID = "a-5000-1-0-0";
const read = (text: string | null) => ({
  status: "ok" as const,
  post: {
    item: feedItem(text === null ? { why: null } : { why: { why_id: "00000000-0000-4000-8000-000000000000", text } }),
    as_of: { checkpoint: 1, timestamp_ms: FIXTURE_NOW, lag_ms: 0 },
  },
});

test("a visible post with its own words is indexed under its own address; links are followed on every post that renders", () => {
  assert.deepEqual(postMetadata(POST_ID, read("Bought the dip")), {
    title: "Post",
    robots: { index: true, follow: true },
    alternates: { canonical: `/p/${POST_ID}` },
  });
  for (const [metadata, title] of [
    [postMetadata(POST_ID, read(null)), "Post"],
    [postMetadata(POST_ID, read("   ")), "Post"],
    [postMetadata(POST_ID, { status: "error" }), "Post"],
  ] as const) {
    assert.deepEqual(metadata, { title, robots: { index: false, follow: true } });
  }
  // A missing post renders not-found, which adds Next's own noindex: no second robots tag.
  for (const metadata of [postMetadata(POST_ID, { status: "not_found" }), postMetadata("not-a-post", null)]) {
    assert.deepEqual(metadata, { title: "Nothing here", robots: null });
  }
});
