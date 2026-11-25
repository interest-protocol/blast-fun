import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SocialViewerProvider } from "../SignInGate";
import { DiscoverList, FollowingList, WatchlistList, type ListProps } from "./sources";
import { discoverQuery, followingCoinsQuery } from "./home-client";
import { createTestQueryClient, withQueryClient } from "#web/lib/query/test-client.ts";

const noop = () => undefined;
const props: ListProps = { source: "following", window: "24h", nowMs: 0, trading: false, page: 1, rows: 10, onPage: noop, onRows: noop };

for (const List of [FollowingList, WatchlistList]) {
  test(`${List.name} waits for authoritative authentication`, () => {
    const html = renderToStaticMarkup(<SocialViewerProvider signedIn={false} sessionPending><List props={props} onDiscover={noop} /></SocialViewerProvider>);
    assert.match(html, /Restoring your session/);
    assert.doesNotMatch(html, /Sign in|Nothing saved|No coins/);
  });
}

test("Following ends pending if the authenticated account failed to resolve", () => {
  const html = renderToStaticMarkup(<SocialViewerProvider signedIn sessionPending={false}><FollowingList props={props} onDiscover={noop} /></SocialViewerProvider>);
  assert.match(html, /Your account is unavailable/);
  assert.doesNotMatch(html, /Loading coins|Sign in/);
});

test("an empty Following result retains its indexing-delay warning", () => {
  const client = createTestQueryClient();
  client.setQueryData(followingCoinsQuery(async () => null, "nova", "24h", 1, 10, true).queryKey, {
    mode: "coins", coins: [], following: 1, total: 0, pages: 1, page: 1, next_cursor: null, window: "24h", clock_ms: 0,
    as_of: { checkpoint: 1, timestamp_ms: 0, lag_ms: 120_000 },
  });
  try {
    const html = renderToStaticMarkup(withQueryClient(client, <SocialViewerProvider signedIn callsign="nova"><FollowingList props={props} onDiscover={noop} /></SocialViewerProvider>));
    assert.match(html, /No activity in the last 24 hours/);
    assert.match(html, /Activity is delayed/);
    assert.match(html, /2 min behind/);
  } finally { client.clear(); }
});

test("Discover only offers to reset filters when the unfiltered catalog has results", () => {
  const client = createTestQueryClient();
  const query = { window: "24h", sort: "trending", stage: "all", minParticipants: 5, age: "all", tradable: false, limit: 10, page: 1, cursor: null } as const;
  const empty = {
    coins: [], total: 0, pages: 1, page: 1, next_cursor: null, window: "24h", clock_ms: 0,
    as_of: { checkpoint: 1, timestamp_ms: 0, lag_ms: 0 },
  } as const;
  const baseline = discoverQuery({ ...query, minParticipants: 0 });
  const render = () => renderToStaticMarkup(withQueryClient(client,
    <DiscoverList initial={null} props={{ ...props, source: "discover", onReset: noop }} query={query} />,
  ));
  try {
    client.setQueryData(discoverQuery(query, true).queryKey, empty);
    assert.doesNotMatch(render(), /Reset filters/);
    client.setQueryData(baseline.queryKey, empty);
    assert.match(render(), /No coins to discover/);
    assert.doesNotMatch(render(), /Reset filters/);
    client.setQueryData(baseline.queryKey, { ...empty, total: 1 });
    const html = render();
    assert.match(html, /No coins match these filters/);
    assert.match(html, /Reset filters/);
  } finally { client.clear(); }
});

test("a confirmed empty Discover result survives a refresh and its failure", async () => {
  const client = createTestQueryClient();
  const query = { window: "1h", sort: "relevant", stage: "all", minParticipants: 0, age: "all", tradable: false, limit: 10, page: 1, cursor: null } as const;
  const empty = {
    coins: [], total: 0, pages: 1, page: 1, next_cursor: null, window: "1h", clock_ms: 0,
    as_of: { checkpoint: 1, timestamp_ms: 0, lag_ms: 0 },
  } as const;
  const options = discoverQuery(query, true);
  const render = () => renderToStaticMarkup(withQueryClient(client,
    <DiscoverList initial={empty} props={{ ...props, source: "discover", window: "1h" }} query={query} />,
  ));

  try {
    assert.match(render(), /No coins to discover/);
    const pending = Promise.withResolvers<never>();
    const refresh = client.fetchQuery({ ...options, staleTime: 0, retry: false, queryFn: () => pending.promise });
    const failed = assert.rejects(refresh, /Read failed/);
    const refreshing = render();
    pending.reject(new Error("Read failed"));
    await failed;

    const errored = render();
    assert.match(errored, /No coins to discover/);
    assert.match(errored, /Couldn’t refresh the coins/);
    assert.match(errored, /Retry/);
    assert.doesNotMatch(errored, /Couldn’t load the coins/);
    assert.match(refreshing, /No coins to discover/);
    assert.doesNotMatch(refreshing, /Refresh market prices/, "a list with no rows draws no header or toolbar");
    assert.match(refreshing, /aria-busy="true"/, "its refresh still marks the result busy");
  } finally { client.clear(); }
});
