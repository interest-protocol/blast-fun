import assert from "node:assert/strict";
import test from "node:test";
import { HOME_DEFAULT_QUERY } from "@blast/core/modules/social/contracts/home.ts";
import {
  fetchHomePage,
  fetchHomeCoins,
  fetchHomeThread,
  fetchHomeTraders,
  fetchHomeDiscussion,
  fetchHomeFollowing,
} from "./home-client.ts";

const as_of = { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 };
const totals = {
  scope: "pool",
  window: "24h",
  from_ms: -86_399_999,
  to_ms: 1,
  participants: 0,
  events: 0,
  buyers: 0,
  sellers: 0,
  backers: 0,
  claimers: 0,
  bought: [],
  sold: [],
  committed: [],
  latest_ms: null,
};
const coin = {
  presale_id: null,
  coin_type: "0x1::coin::COIN",
  symbol: "COIN",
  name: "Coin",
  icon_url: null,
  decimals: 24,
  lifecycle: "migrated",
  venue: "cetus",
  tradable: true,
  opened_ms: null,
  launched_ms: null,
  launch_id: null,
  quote: { type: "quote", symbol: "Q", decimals: 24 },
  sale: null,
  price_usd: null,
  price_as_of_ms: null,
  change_24h_bps: null,
  holders: null,
  holders_as_of_ms: null,
  fdv_usd: null,
  spark: [],
  activity: { ...totals, preview: [] },
  discussion: { posts: 0 },
  rank: { score: 0, why: "No activity" },
  top_holders: { holders: [], share_bps: null },
};
const page = {
  coins: [coin],
  page: 1,
  pages: 1,
  total: 1,
  next_cursor: null,
  window: "24h",
  clock_ms: 1,
  as_of,
};
const presale = `0x${"a".repeat(64)}`;

test("Home reads validate complete nested payloads and retain signed windows and indexed decimals", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let body: unknown = page;
  globalThis.fetch = async () => Response.json(body);
  assert.deepEqual(await fetchHomePage(HOME_DEFAULT_QUERY, null), page);
  body = {
    ...page,
    coins: [
      {
        ...coin,
        activity: {
          ...coin.activity,
          bought: [
            {
              quote_type: "Q",
              quote_symbol: "Q",
              quote_decimals: 24,
              atoms: 1,
              usd: null,
              usd_complete: false,
            },
          ],
        },
      },
    ],
  };
  await assert.rejects(
    fetchHomePage(HOME_DEFAULT_QUERY, null),
    /unreadable response/,
  );
  body = { coins: [coin], missing: [], window: "24h", clock_ms: 1, as_of };
  assert.deepEqual(await fetchHomeCoins([presale], "24h"), body);
  body = {
    presale_id: presale,
    coin_type: null,
    participants: [],
    totals,
    next_cursor: null,
    window: "24h",
    clock_ms: 1,
    as_of,
  };
  assert.deepEqual(await fetchHomeThread(presale, "24h", null), body);
  body = { ...(body as object), participants: [{}] };
  await assert.rejects(
    fetchHomeThread(presale, "24h", null),
    /unreadable response/,
  );
  body = {
    search: "",
    page: 1,
    limit: 5,
    total: 0,
    global_total: 0,
    window: "24h",
    clock_ms: 1,
    traders: [],
    as_of,
  };
  assert.deepEqual(await fetchHomeTraders("24h"), body);
  body = { ...(body as object), traders: [{}] };
  await assert.rejects(fetchHomeTraders("24h"), /unreadable response/);
  body = { presale_id: presale, items: [], total: 0, next_cursor: null, as_of };
  assert.deepEqual(await fetchHomeDiscussion(presale, null), body);
  body = { ...(body as object), items: [{}] };
  await assert.rejects(
    fetchHomeDiscussion(presale, null),
    /unreadable response/,
  );
});

test("Following rejects incomplete successful modes without changing authentication or refusals", async () => {
  let body: unknown = { ...page, mode: "coins", following: 0 };
  let status = 200;
  const requests: RequestInit[] = [];
  const options = {
    getAccessToken: async () => "test-token",
    fetch: (async (_input, init) => {
      requests.push(init!);
      return Response.json(body, { status });
    }) as typeof fetch,
  };
  const request = { mode: "coins", window: "24h" } as const;
  assert.equal((await fetchHomeFollowing(options, request)).status, "ok");
  assert.equal(requests[0]?.cache, "no-store");
  assert.equal(
    (requests[0]?.headers as Record<string, string>).authorization,
    "Bearer test-token",
  );
  body = { mode: "coins", window: "24h", clock_ms: 1, as_of };
  assert.equal((await fetchHomeFollowing(options, request)).status, "error");
  status = 401;
  body = { error: { code: "unauthorized" } };
  assert.equal((await fetchHomeFollowing(options, request)).status, "refused");
});
