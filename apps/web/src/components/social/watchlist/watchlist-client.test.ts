import assert from "node:assert/strict";
import test from "node:test";

import { fixtureSummaries } from "../../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { fetchWatchlistPage } from "./watchlist-client.ts";

const page = {
  items: [
    {
      presale: fixtureSummaries()[0]!,
      added_ms: 1,
      starred: true,
      followed: false,
    },
  ],
  total: 1,
  next_cursor: null,
  as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 },
};

test("watchlist parsing preserves fixture rows, authentication and paging", async () => {
  const sent: { url: string; init?: RequestInit }[] = [];
  const request = (async (url: string, init?: RequestInit) => {
    sent.push({ url, init });
    return Response.json(page);
  }) as typeof fetch;
  const result = await fetchWatchlistPage(
    { getAccessToken: async () => "token", fetch: request },
    20,
    "next/page",
    true,
  );
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.deepEqual(result.body, page);
  assert.equal(
    sent[0]?.url,
    "/api/social/me/watchlist?limit=20&include=follows&cursor=next%2Fpage",
  );
  assert.equal(sent[0]?.init?.cache, "no-store");
  assert.equal(sent[0]?.init?.credentials, "same-origin");
  assert.equal(
    new Headers(sent[0]?.init?.headers).get("authorization"),
    "Bearer token",
  );
});

test("watchlist rejects malformed nested rows with the existing error result", async () => {
  const request = (async () =>
    Response.json({
      ...page,
      items: [
        { ...page.items[0], presale: { presale_id: "invalid", phase: "open" } },
      ],
    })) as typeof fetch;
  const result = await fetchWatchlistPage(
    { getAccessToken: async () => null, fetch: request },
    20,
  );
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "invalid_response");
});
