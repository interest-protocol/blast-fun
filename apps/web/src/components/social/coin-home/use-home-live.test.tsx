import assert from "node:assert/strict";
import test from "node:test";

import type { HomeCoinsPage, HomeQuery } from "@blast/core/modules/social/contracts/home.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import { createTestQueryClient, settleQueries, withQueryClient } from "#web/lib/query/test-client.ts";
import type { FeedFreshnessSource, FreshnessSignal } from "../home/feed-freshness";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useHomeLive } = await import("./use-home-live");
const { discoverQuery } = await import("./home-client");

const query: HomeQuery = { window: "1h", sort: "relevant", stage: "all", minParticipants: 0, age: "all", tradable: false, limit: 10, page: 1, cursor: null, presales: true };
const page = { coins: [], total: 0, pages: 1, page: 1, next_cursor: null, window: "1h", clock_ms: 0, as_of: { checkpoint: 1, timestamp_ms: 0, lag_ms: 0 } } as unknown as HomeCoinsPage;

/** Home's live loop over a page cached `ageMs` ago; counts the Discover reads it starts. */
async function mount(ageMs: number) {
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  const { queryKey } = discoverQuery(query, true);
  client.setQueryData(queryKey, page, { updatedAt: Date.now() - ageMs });
  let reads = 0;
  const fetchQuery = client.fetchQuery.bind(client);
  client.fetchQuery = ((options: { queryKey: unknown }) => {
    if (JSON.stringify(options.queryKey) === JSON.stringify(queryKey)) reads += 1;
    return fetchQuery({ ...options, queryFn: async () => page } as never);
  }) as typeof client.fetchQuery;
  let signal: FreshnessSignal = () => undefined;
  const source: FeedFreshnessSource = { name: "fake", subscribe: (next) => ((signal = next), () => undefined) };
  function Live() {
    useHomeLive(query, true, source);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(withQueryClient(client, <Live />)));
  const connect = async () => {
    signal({ atMs: Date.now(), cause: "connect" });
    await settleQueries(client);
    return reads;
  };
  const done = async () => { await act(async () => root.unmount()); container.remove(); client.clear(); };
  return { connect, done };
}

test("the hint stream's first connect does not repeat a fresh page read; a reconnect reads", async () => {
  const fresh = await mount(1_000);
  try {
    assert.equal(await fresh.connect(), 0, "the server's read is younger than the poll: no second read on load");
    assert.equal(await fresh.connect(), 1, "a reconnect may have missed hints, so it reads");
  } finally { await fresh.done(); }

  const old = await mount(31_000);
  try {
    assert.equal(await old.connect(), 1, "a page older than the poll reads on the first connect");
  } finally { await old.done(); }
});
