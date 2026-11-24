import assert from "node:assert/strict";
import test from "node:test";

import { feedPageUrl, fetchFeedPage } from "./feed-client.ts";
import { feedPage } from "../../../test/fixtures/social/feed-fixtures.ts";
import { isFeedDelayed } from "./feed-format.ts";

/** Social-feed T-007: the feed's pure display helpers and page client. */

test("the delayed threshold", () => {
  assert.equal(isFeedDelayed({ checkpoint: 1, timestamp_ms: 1, lag_ms: 60_000 }), false);
  assert.equal(isFeedDelayed({ checkpoint: 1, timestamp_ms: 1, lag_ms: 60_001 }), true);
  assert.equal(isFeedDelayed(null), false);
});

test("the page client asks without credentials and refuses errors and unexpected bodies", async () => {
  assert.equal(feedPageUrl("/api/social/feed?tab=for_you", null), "/api/social/feed?tab=for_you");
  assert.equal(feedPageUrl("/api/social/feed?tab=for_you", "a.b"), "/api/social/feed?tab=for_you&cursor=a.b");
  assert.equal(feedPageUrl("/api/social/feed?cursor=old", "new"), "/api/social/feed?cursor=new");
  const calls: [string, RequestInit | undefined][] = [];
  const answer = (status: number, body: unknown): typeof fetch => async (input, init) => {
    calls.push([String(input), init]);
    return Response.json(body, { status });
  };
  const page = feedPage();
  assert.deepEqual(await fetchFeedPage("/api/social/feed?tab=for_you", "c1", answer(200, page)), page);
  assert.equal(calls[0]?.[0], "/api/social/feed?tab=for_you&cursor=c1");
  assert.equal(calls[0]?.[1]?.credentials, "same-origin");
  await assert.rejects(fetchFeedPage("/x", null, answer(503, { error: { code: "service_unavailable" } })), /Code: service_unavailable/);
  await assert.rejects(fetchFeedPage("/x", null, answer(200, { items: "nope" })), /Code: invalid_response/);
});

test("feed reads preserve refusal references and hide private payloads, including malformed success bodies", async () => {
  let status = 503;
  const fetcher = async () => Response.json({ error: { code: "PRIVATE_PROVIDER_SECRET", message: "PRIVATE_PROVIDER_SECRET" } }, { status, headers: { "x-request-id": "feed-safe-ref" } });
  for (const read of [() => fetchFeedPage("/x", null, fetcher)]) {
    status = 503;
    await assert.rejects(read(), (error: Error) => /Code: service_unavailable.*Reference: feed-safe-ref/.test(error.message) && !error.message.includes("PRIVATE_PROVIDER_SECRET"));
    status = 200;
    await assert.rejects(read(), (error: Error) => /Code: invalid_response.*Reference: feed-safe-ref/.test(error.message) && !error.message.includes("PRIVATE_PROVIDER_SECRET"));
  }
});

test("the feed boundary rejects malformed nested items and keeps response diagnostics", async () => {
  const page = feedPage();
  const body = { ...page, items: [{ ...page.items[0], through: { people: -1, volume_usd: "0.00" } }] };
  const fetcher = async () => Response.json(body, { headers: { "x-request-id": "nested-feed-ref" } });
  await assert.rejects(fetchFeedPage("/api/social/feed", null, fetcher), (error: Error) =>
    /Code: invalid_response.*Reference: nested-feed-ref/.test(error.message));
});
