import { normalizeStructTag } from "@mysten/sui/utils";
import assert from "node:assert/strict";
import test from "node:test";
import type { SocialMePresales } from "@blast/core/modules/social/contracts/profile-page.ts";
import type { FreshnessHint } from "./home/feed-freshness.ts";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

/**
 * OA-38: the social reads on TanStack Query. Two consumers of one read make
 * one request; a transient failure is retried and a refusal is not; a
 * server-rendered read paints and hydrates with no request; every write
 * invalidates exactly the reads it changed; a blast-infra hint invalidates the
 * list pages; lifecycle hints also refresh the viewer's; signing out drops the viewer's reads.
 */

installTestDom();

const { act, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { QueryObserver } = await import("@tanstack/react-query");
const { shouldRetry } = await import("#web/lib/query/client.ts");
const { clearViewerQueries, invalidateAfter, HINTED_KEYS } = await import("#web/lib/query/invalidate.ts");
const { queryKeys } = await import("#web/lib/query/keys.ts");
const { createTestQueryClient, settleQueries, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { SocialViewerProvider } = await import("./SignInGate");
const { useWalletCoins } = await import("./coins/use-wallet");
const { useShellPortfolio } = await import("./use-shell-portfolio");
const { useSocialAccountRead } = await import("./use-social-account");
const { WalletSessionProvider } = await import("./WalletSession");
const { SOCIAL_WALLET_HINT_COOKIE } = await import("@blast/core/modules/social/contracts/wallet-sign-in.ts");
const { useBalances } = await import("./coins/balances");
const { useProfileCalls } = await import("./profile/use-profile-data");
const { featuredPresalesQuery, presaleDetailQuery, presaleListQuery, walletQuery } = await import("./queries");
const { hintInvalidation: invalidateWithJitter } = await import("./live-queries");
const hintInvalidation = (...args: Parameters<typeof invalidateWithJitter>) => invalidateWithJitter(args[0], args[1], args[2], () => 0);
const { ViewerStateStore } = await import("./viewer-state-store");
const { cachedWatchlistCalls } = await import("./watchlist/watchlist-cache");

type QueryClient = ReturnType<typeof createTestQueryClient>;

const ADDRESS = `0x${"a".repeat(64)}`;
const WALLET = {
  address: ADDRESS,
  signer: "privy" as const,
  fee: "sponsored" as const,
  coins: [{ coin_type: normalizeStructTag("0x2::sui::SUI"), symbol: "SUI", name: "Sui", decimals: 9, atoms: "1000000000", usd_price: "3.42", value_usd: "3.42", icon_url: null, presale: null }],
  as_of_ms: 1,
};
const ME_ACCOUNT = {
  account_id: "00000000-0000-4000-8000-000000000001",
  kind: "new",
  callsign: "kai",
  display_name: null,
  avatar_url: null,
  x_handle: null,
  verified: false,
  onboarding: { shown: false, completed: false },
  privacy: "public",
  sharing_since_ms: null,
  wallets: [],
};
const CALLS = { callsign: "kaimoreno", calls: [], theses: [] };

/** A fetch that answers by path and counts every request. */
function routes(answer: (path: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const seen: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    seen.push(`${init?.method ?? "GET"} ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
    return answer(path, init);
  }) as typeof globalThis.fetch;
  return { seen, fetch, count: (prefix: string) => seen.filter((line) => line.includes(prefix)).length };
}

async function withFetch<T>(fetch: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
  const before = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = before;
  }
}

async function mount(client: QueryClient, node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(withQueryClient(client, node)));
  await act(async () => settleQueries(client));
  return { root, container, unmount: () => act(async () => root.unmount()) };
}

const token = async () => "token";

function Coins({ seen }: Readonly<{ seen: string[] }>) {
  const read = useWalletCoins();
  useEffect(() => void seen.push(`${read.status}:${read.coins.length}`));
  return <i>{read.status}</i>;
}

function Portfolio({ seen }: Readonly<{ seen: string[] }>) {
  const read = useShellPortfolio({ enabled: true, accountId: "fixture", getAccessToken: token });
  useEffect(() => void seen.push(read.state.status));
  return <i>{read.state.status}</i>;
}

test("wallet and portfolio keep their cached answers while refreshing and after a failed refresh", async () => {
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  client.setQueryData(walletQuery(token, { page: 1, hide_small: true }).queryKey, WALLET);
  client.setQueryData(queryKeys.me.portfolio(), { balances: null, positions: [], commitments: { committed_usd: null, claimable_usd: null }, coins: null, vesting: null, totals: null, trend: null, prices_as_of_ms: null, unavailable: ["balances", "coins", "vesting", "totals", "trend"] });
  const answer = Promise.withResolvers<Response>();
  const net = routes(() => answer.promise);
  await withFetch(net.fetch, async () => {
    const coins: string[] = [];
    const portfolio: string[] = [];
    const page = await mount(client, <SocialViewerProvider getAccessToken={token} signedIn><Coins seen={coins} /><Portfolio seen={portfolio} /></SocialViewerProvider>);
    const refreshed = client.invalidateQueries({ queryKey: ["blast", "me"] });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.deepEqual([...new Set(coins)], ["ready:1"]);
    assert.deepEqual([...new Set(portfolio)], ["ready"]);
    await act(async () => { answer.resolve(new Response("{}", { status: 503 })); await refreshed; await settleQueries(client); });
    assert.deepEqual([...new Set(coins)], ["ready:1"]);
    assert.deepEqual([...new Set(portfolio)], ["ready"]);
    await page.unmount();
  });
  client.clear();
});

function AccountRead({ seen }: Readonly<{ seen: string[] }>) {
  const read = useSocialAccountRead();
  useEffect(() => void seen.push(read.status));
  return <i>{read.status}</i>;
}

test("server authentication stays unresolved until hydration reads the wallet hint; a failed me read settles to error", async () => {
  const client = createTestQueryClient();
  const content = <WalletSessionProvider><AccountRead seen={[]} /></WalletSessionProvider>;
  assert.equal(renderToString(withQueryClient(client, content)), "<i>loading</i>");
  Object.defineProperty(document, "cookie", { configurable: true, get: () => `${SOCIAL_WALLET_HINT_COOKIE}=1` });
  try {
    const net = routes(() => new Response("{}", { status: 503 }));
    await withFetch(net.fetch, async () => {
      const seen: string[] = [];
      const page = await mount(client, <WalletSessionProvider><AccountRead seen={seen} /></WalletSessionProvider>);
      assert.equal(seen.at(-1), "error");
      assert.ok(!seen.includes("signed_out"), "the wallet hint must be read before showing visitor controls");
      await page.unmount();
    });
  } finally {
    Reflect.deleteProperty(document, "cookie");
    client.clear();
  }
});

test("a wallet session loads me without a Privy provider", async () => {
  const client = createTestQueryClient();
  Object.defineProperty(document, "cookie", { configurable: true, get: () => `${SOCIAL_WALLET_HINT_COOKIE}=1` });
  try {
    const net = routes((_path, init) => {
      assert.equal(init?.credentials, "same-origin");
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      return Response.json({ account: ME_ACCOUNT });
    });
    await withFetch(net.fetch, async () => {
      const seen: string[] = [];
      const page = await mount(client, <WalletSessionProvider><AccountRead seen={seen} /></WalletSessionProvider>);
      assert.equal(seen.at(-1), "ready");
      assert.equal(net.count("/api/social/me"), 1);
      await page.unmount();
    });
  } finally {
    Reflect.deleteProperty(document, "cookie");
    client.clear();
  }
});

test("a failed account refresh preserves the loaded account", async () => {
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.me.account("wallet"), { status: "ready", account: { ...ME_ACCOUNT, callsign: "kaimoreno" } });
  Object.defineProperty(document, "cookie", { configurable: true, get: () => `${SOCIAL_WALLET_HINT_COOKIE}=1` });
  try {
    const net = routes(() => new Response("{}", { status: 503 }));
    await withFetch(net.fetch, async () => {
      const seen: string[] = [];
      const page = await mount(client, <WalletSessionProvider><AccountRead seen={seen} /></WalletSessionProvider>);
      await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.me.account("wallet") }); await settleQueries(client); });
      assert.equal(seen.at(-1), "ready");
      assert.ok(!seen.includes("error"));
      assert.equal(client.getQueryData<{ account: { callsign: string } }>(queryKeys.me.account("wallet"))?.account.callsign, "kaimoreno");
      await page.unmount();
    });
  } finally {
    Reflect.deleteProperty(document, "cookie");
    client.clear();
  }
});

test("two surfaces showing the wallet make one request (the Your coins card and the collapsed column)", async () => {
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  const net = routes(() => Response.json(WALLET));
  await withFetch(net.fetch, async () => {
    const seen: string[] = [];
    const page = await mount(
      client,
      <SocialViewerProvider callsign="kaimoreno" getAccessToken={token} signedIn>
        <Coins seen={seen} />
        <Coins seen={seen} />
      </SocialViewerProvider>,
    );
    assert.equal(net.count("/api/social/me/wallet"), 1);
    assert.ok(seen.filter((line) => line === "ready:1").length >= 2, seen.join(" "));
    await page.unmount();
    // Mounted again inside the freshness window: the cache answers.
    const again = await mount(
      client,
      <SocialViewerProvider callsign="kaimoreno" getAccessToken={token} signedIn>
        <Coins seen={seen} />
      </SocialViewerProvider>,
    );
    assert.equal(net.count("/api/social/me/wallet"), 1, "no refetch on remount");
    await again.unmount();
  });
  client.clear();
});

test("a transient failure is retried with backoff; a refusal is shown at once and never retried", async () => {
  const flaky = createTestQueryClient({ queries: { retry: shouldRetry, retryDelay: 0 } });
  let attempts = 0;
  const net = routes(() => (++attempts < 3 ? new Response("{}", { status: 503 }) : Response.json(WALLET)));
  await withFetch(net.fetch, async () => {
    const seen: string[] = [];
    const page = await mount(flaky, <SocialViewerProvider callsign="kaimoreno" getAccessToken={token} signedIn><Coins seen={seen} /></SocialViewerProvider>);
    assert.equal(net.count("/api/social/me/wallet"), 3);
    assert.equal(seen.at(-1), "ready:1");
    await page.unmount();
  });
  const refused = createTestQueryClient({ queries: { retry: shouldRetry, retryDelay: 0 } });
  const denied = routes(() => Response.json({ error: { code: "account_required", message: "x" } }, { status: 403 }));
  await withFetch(denied.fetch, async () => {
    const seen: string[] = [];
    const page = await mount(refused, <SocialViewerProvider callsign="kaimoreno" getAccessToken={token} signedIn><Coins seen={seen} /></SocialViewerProvider>);
    assert.equal(denied.count("/api/social/me/wallet"), 1);
    assert.equal(seen.at(-1), "error:0");
    await page.unmount();
  });
});

function Calls({ initial, seen }: Readonly<{ initial: typeof CALLS | null; seen: string[] }>) {
  const read = useProfileCalls("kaimoreno", initial as never);
  useEffect(() => void seen.push(read.status));
  return <b>{read.status}</b>;
}

test("a server-rendered read paints on the server and hydrates with no request", async () => {
  const net = routes(() => Response.json(CALLS));
  await withFetch(net.fetch, async () => {
    assert.equal(renderToString(withQueryClient(createTestQueryClient(), <Calls initial={CALLS} seen={[]} />)), "<b>ready</b>");
    const client = createTestQueryClient();
    const seen: string[] = [];
    const page = await mount(client, <Calls initial={CALLS} seen={seen} />);
    assert.equal(net.count("/calls"), 0);
    assert.deepEqual([...new Set(seen)], ["ready"]);
    await page.unmount();
    // Without a server read, the browser reads it once.
    const bare = createTestQueryClient();
    const again = await mount(bare, <Calls initial={null} seen={[]} />);
    assert.equal(net.count("/calls"), 1);
    await again.unmount();
  });
});

/** Active observers on `keys`, counting each one's reads. */
function observe(client: QueryClient, keys: Readonly<Record<string, readonly unknown[]>>) {
  const reads: Record<string, number> = {};
  const offs = Object.entries(keys).map(([name, queryKey]) => {
    reads[name] = 0;
    const observer = new QueryObserver(client, {
      queryKey,
      queryFn: async () => {
        reads[name]! += 1;
        return { name, at: reads[name] };
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    return observer.subscribe(() => undefined);
  });
  return { reads, stop: () => offs.forEach((off) => off()) };
}

const OPEN = "0xopen";
const CURVE = "0xcurve::curve::CURVE";
const OTHER = "0xother";

test("each write invalidates exactly the reads it changed", async () => {
  const cases: ReadonlyArray<[Parameters<typeof invalidateAfter>[1], readonly string[]]> = [
    [{ kind: "commit", presaleId: OPEN }, ["wallet", "portfolio", "mine", "viewerOpen", "log", "saleOpen", "list"]],
    [{ kind: "claim", presaleId: OPEN }, ["wallet", "portfolio", "mine", "viewerOpen", "log", "saleOpen"]],
    [{ kind: "trade" }, ["wallet", "portfolio", "mine", "log"]],
    [{ kind: "balances" }, ["wallet", "portfolio", "mine", "log"]],
    [{ kind: "follow", target: "presale", id: OPEN }, ["viewerOpen", "stars"]],
    [{ kind: "follow", target: "account", id: "luca" }, ["mutuals", "connectionCounts", "connectionPage"]],
    [{ kind: "watchlist" }, ["stars"]],
    [{ kind: "settings" }, ["settings", "connectionCounts", "connectionPage"]],
    [{ kind: "notifications" }, ["unread"]],
    [{ kind: "profile", callsign: null }, ["profileEdit", "connectionCounts", "connectionPage"]],
    [{ kind: "sale-metadata", presaleId: OPEN }, ["saleOpen"]],
    [{ kind: "why" }, ["saleOpen", "saleOther"]],
  ];
  for (const [change, expected] of cases) {
    const client = createTestQueryClient();
    const { reads, stop } = observe(client, {
      wallet: queryKeys.me.wallet(),
      portfolio: queryKeys.me.portfolio(),
      mine: queryKeys.me.presales(),
      viewerOpen: queryKeys.me.presaleViewer([OPEN]),
      log: queryKeys.me.transactions.list(30),
      saleOpen: queryKeys.presales.detail(OPEN),
      saleOther: queryKeys.presales.detail(OTHER),
      list: queryKeys.presales.list("/api/social/presales?status=live"),
      stars: queryKeys.me.watchlist.keys(),
      mutuals: queryKeys.me.mutuals("luca"),
      connectionCounts: queryKeys.me.connections.counts("luca", "visitor"),
      connectionPage: queryKeys.me.connections.list("luca", "kai", "following", ""),
      settings: queryKeys.me.settings(),
      unread: queryKeys.me.notifications.unread(),
      profileEdit: queryKeys.me.profileEdit(),
      happening: queryKeys.happening(),
    });
    await settleQueries(client);
    await invalidateAfter(client, change);
    await settleQueries(client);
    const moved = Object.entries(reads).filter(([, count]) => count > 1).map(([name]) => name).sort();
    assert.deepEqual(moved, [...expected].sort(), change.kind);
    stop();
    client.clear();
  }
});

test("balances moving reads the wallet once, however many surfaces show it", async () => {
  const client = createTestQueryClient();
  const { reads, stop } = observe(client, { wallet: queryKeys.me.wallet(), wallet2: queryKeys.me.wallet(), happening: queryKeys.happening() });
  await settleQueries(client);
  let changed: () => void = () => undefined;
  function Shell() {
    const balances = useBalances(() => undefined);
    useEffect(() => {
      changed = balances.changed;
    });
    return null;
  }
  const page = await mount(client, <Shell />);
  await act(async () => changed());
  await act(async () => settleQueries(client));
  // Both observers share one query: one read before, one after.
  assert.equal(reads.wallet! + reads.wallet2!, 2);
  assert.equal(reads.happening, 1);
  await page.unmount();
  stop();
});

test("a follow written through the viewer-state store makes the watchlist and the sale's viewer read stale", async () => {
  const client = createTestQueryClient();
  const { reads, stop } = observe(client, { stars: queryKeys.me.watchlist.keys(), viewer: queryKeys.me.presaleViewer([OPEN]), wallet: queryKeys.me.wallet() });
  await settleQueries(client);
  const net = routes(() => new Response(null, { status: 204 }));
  const store = new ViewerStateStore({ getAccessToken: token, fetch: net.fetch, client, scope: "kaimoreno" });
  assert.equal((await store.setFollowing({ kind: "presale", presale_id: OPEN }, true)).status, "ok");
  await settleQueries(client);
  assert.deepEqual(reads, { stars: 2, viewer: 2, wallet: 1 });
  // The answer lives in the shared cache, under the viewer.
  assert.equal(client.getQueryData([...queryKeys.me.viewerState("kaimoreno"), "follow", `p:${OPEN}`]), true);
  stop();
});

test("a star written updates the shared keys in place (no re-read), newest first, and makes the card's pages stale", async () => {
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  client.setQueryData(queryKeys.me.watchlist.keys(), { keys: ["0xa"] });
  const net = routes(() => new Response(null, { status: 204 }));
  await withFetch(net.fetch, async () => {
    const calls = cachedWatchlistCalls(client);
    assert.equal((await calls.set({ getAccessToken: token }, OPEN, true)).status, "ok");
    // A curve coin's star (its key a coin type) shares the one list.
    assert.equal((await calls.set({ getAccessToken: token }, CURVE, true)).status, "ok");
    assert.equal((await calls.set({ getAccessToken: token }, "0xa", false)).status, "ok");
  });
  assert.deepEqual(client.getQueryData(queryKeys.me.watchlist.keys()), { keys: [CURVE, OPEN] });
  assert.equal(net.seen.length, 3);
  client.clear();
});

test("infra hints refresh discovery and creator lists, including after the edge cache expires, without touching wallet reads", async () => {
  const client = createTestQueryClient();
  const { reads, stop } = observe(client, {
    live: queryKeys.presales.list("/api/social/presales?status=live&sort=ending&limit=50"),
    ended: queryKeys.presales.list("/api/social/presales?status=ended&sort=recent&limit=50"),
    sale: queryKeys.presales.detail(OPEN),
    wallet: queryKeys.me.wallet(),
    mine: queryKeys.me.presales(),
    created: queryKeys.me.createdPresales(),
  });
  await settleQueries(client);
  let now = 100_000;
  const timers: Array<{ at: number; run: () => void }> = [];
  let signal: (hint?: { atMs: number; cause: "hint" | "connect" | "resync" }) => void = () => undefined;
  const off = hintInvalidation(
    client,
    { name: "fake", subscribe: (next) => ((signal = next), () => undefined) },
    { now: () => now, setTimeout: (run, ms) => timers.push({ at: now + ms, run }), clearTimeout: () => undefined },
  );
  signal({ atMs: now, cause: "connect" });
  await settleQueries(client);
  assert.deepEqual(reads, { live: 2, ended: 2, sale: 2, wallet: 1, mine: 1, created: 2 });
  // A hint a second later is kept, and read once the floor has passed.
  now += 1_000;
  signal({ atMs: now, cause: "hint" });
  signal({ atMs: now, cause: "hint" });
  await settleQueries(client);
  assert.equal(reads.live, 2);
  assert.equal(timers.length, 2);
  const kept = timers.find((timer) => timer.at === 105_000)!;
  now = kept.at;
  kept.run();
  await settleQueries(client);
  assert.deepEqual(reads, { live: 3, ended: 3, sale: 3, wallet: 1, mine: 1, created: 3 });
  const followup = timers.find((timer) => timer.at === 130_100)!;
  now = followup.at;
  followup.run();
  await settleQueries(client);
  assert.deepEqual(reads, { live: 4, ended: 4, sale: 4, wallet: 1, mine: 1, created: 4 });
  assert.deepEqual(HINTED_KEYS, [queryKeys.presales.lists, queryKeys.prices.batches, queryKeys.me.createdPresales()]);
  off();
  stop();
});

test("signing out drops every viewer read and keeps the public ones", async () => {
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  client.setQueryData(queryKeys.me.wallet(), WALLET);
  client.setQueryData(queryKeys.me.notifications.unread(), { unread_count: 3 });
  client.setQueryData(queryKeys.me.connections.counts("kaimoreno", "kaimoreno"), { followers: 2, following: 3 });
  client.setQueryData(queryKeys.me.connections.list("kaimoreno", "kaimoreno", "following", ""), { pages: [{ accounts: [{ callsign: "private_person", private: true }], next_cursor: null }], pageParams: [null] });
  client.setQueryData(queryKeys.presales.detail(OPEN), { presale: { presale_id: OPEN } });
  const page = await mount(client, <SocialViewerProvider callsign="kaimoreno" getAccessToken={token} signedIn><i /></SocialViewerProvider>);
  await act(async () => page.root.render(withQueryClient(client, <SocialViewerProvider signedIn={false}><i /></SocialViewerProvider>)));
  assert.equal(client.getQueryData(queryKeys.me.wallet()), undefined);
  assert.equal(client.getQueryData(queryKeys.me.notifications.unread()), undefined);
  assert.equal(client.getQueryData(queryKeys.me.connections.counts("kaimoreno", "kaimoreno")), undefined);
  assert.equal(client.getQueryData(queryKeys.me.connections.list("kaimoreno", "kaimoreno", "following", "")), undefined);
  assert.ok(client.getQueryData(queryKeys.presales.detail(OPEN)));
  // Directly, too.
  client.setQueryData(queryKeys.me.settings(), { privacy: "public" });
  clearViewerQueries(client);
  assert.equal(client.getQueryData(queryKeys.me.settings()), undefined);
  await page.unmount();
  client.clear();
});

test("a sale read is one request, and list and wallet reads are keyed by their paths", async () => {
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  const detail = { presale: { presale_id: OPEN }, terms: { presale_price_usd: "0.0125" }, team_vesting: null, backers: { top: [] }, raise: { points: [] }, theses: [], activity: [] };
  const net = routes(() => Response.json(detail));
  await withFetch(net.fetch, async () => {
    await client.fetchQuery(presaleDetailQuery(OPEN));
  });
  assert.equal(net.count(`/api/social/presales/${OPEN}`), 1);
  // A list page's key is its path, so a reader and the request never disagree.
  assert.deepEqual(presaleListQuery({ status: "live", limit: 50 }).queryKey, queryKeys.presales.list("/api/social/presales?status=live&sort=pinned&limit=50"));
  assert.deepEqual(walletQuery(token).queryKey, queryKeys.me.wallet());
  client.clear();
});

const { usePrice } = await import("./prices/price-client");

function Spark({ presaleId, seen }: Readonly<{ presaleId: string; seen: string[] }>) {
  const price = usePrice({ presaleId, window: "launch" });
  useEffect(() => void seen.push(`${presaleId}:${price === undefined ? "…" : price === null ? "none" : price.points.length}`));
  return null;
}

test("prices: the cards of one page share one request, and a card mounted again asks nothing", async () => {
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  const presaleA = `0x${"a".repeat(64)}`;
  const presaleB = `0x${"b".repeat(64)}`;
  const history = (presale_id: string) => ({
    presale_id, coin_type: `${presale_id}::coin::COIN`, tier: "1h", from_ms: 1,
    points: [[1, "0.01"], [2, "0.02"]], price_usd: "0.02", price_24h_usd: null,
    change_24h_bps: null, day_open_usd: null, day_open_ms: null,
  });
  const net = routes((path) => {
    const ids = new URL(path, "http://x").searchParams.getAll("presale");
    return Response.json({ window: "launch", clock_ms: 3, prices: ids.map(history), as_of: { checkpoint: 1, timestamp_ms: 3, lag_ms: 0 } });
  });
  await withFetch(net.fetch, async () => {
    const seen: string[] = [];
    const page = await mount(client, <><Spark presaleId={presaleA} seen={seen} /><Spark presaleId={presaleB} seen={seen} /><Spark presaleId={presaleA} seen={seen} /></>);
    assert.equal(net.count("/api/social/prices"), 1);
    assert.ok(seen.includes(`${presaleA}:2`) && seen.includes(`${presaleB}:2`), seen.join(" "));
    await page.unmount();
    const again = await mount(client, <Spark presaleId={presaleB} seen={seen} />);
    assert.equal(net.count("/api/social/prices"), 1);
    await again.unmount();
  });
  client.clear();
});


test("malformed successful presale and featured lists preserve diagnostic references", async () => {
  const { PublicError } = await import("#web/lib/errors.ts");
  const reads = [
    (client: QueryClient) => client.fetchQuery({ ...presaleListQuery({ status: "live" }), retry: false }),
    (client: QueryClient) => client.fetchQuery({ ...featuredPresalesQuery(), retry: false }),
  ];
  for (const read of reads) {
    const client = createTestQueryClient({ queries: { retry: false } });
    await withFetch(async () => Response.json({ presales: "private provider payload" }, { headers: { "X-Request-ID": "malformed-list-reference" } }), async () => {
      await assert.rejects(read(client), (error: unknown) => {
        assert.ok(error instanceof PublicError);
        assert.equal(error.code, "invalid_response");
        assert.equal(error.requestId, "malformed-list-reference");
        assert.equal(error.httpStatus, 200);
        assert.doesNotMatch(error.message, /private provider payload/);
        return true;
      });
    });
    client.clear();
  }
});

test("a plain hint re-reads only sales still taking commits; an ended sale reads on its own lifecycle hint or a catch-up", async () => {
  const client = createTestQueryClient();
  const sale = (phase: string) => async () => ({ presale: { presale_id: phase, phase } });
  const reads = { open: 0, trading: 0, cancelled: 0 };
  const offs = (["open", "trading", "cancelled"] as const).map((phase) =>
    new QueryObserver(client, { queryKey: queryKeys.presales.detail(phase === "open" ? OPEN : phase === "trading" ? OTHER : "0xcancelled"), queryFn: async () => { reads[phase] += 1; return sale(phase)(); }, staleTime: Number.POSITIVE_INFINITY }).subscribe(() => undefined),
  );
  await settleQueries(client);
  let now = 100_000;
  let signal: (hint?: FreshnessHint) => void = () => undefined;
  const off = hintInvalidation(client, { name: "fake", subscribe: (next) => ((signal = next), () => undefined) }, { now: () => now, setTimeout: () => 0, clearTimeout: () => undefined });
  try {
    signal({ atMs: now, cause: "hint" });
    await settleQueries(client);
    assert.deepEqual(reads, { open: 2, trading: 1, cancelled: 1 }, "a commit anywhere cannot move a graduated or cancelled sale");
    now += 10_000;
    signal({ atMs: now, cause: "hint", presaleId: OTHER, lifecycle: "migrated" });
    await settleQueries(client);
    assert.deepEqual(reads, { open: 3, trading: 2, cancelled: 1 }, "its own lifecycle hint reads that sale, not another ended one");
    now += 10_000;
    signal({ atMs: now, cause: "connect", catchUp: true });
    await settleQueries(client);
    assert.deepEqual(reads, { open: 4, trading: 3, cancelled: 2 }, "a catch-up after a gap reads every sale");
  } finally { off(); offs.forEach((stop) => stop()); client.clear(); }
});

test("sales that change phase together each read once, though the hint gate keeps one hint and drops the rest", async () => {
  const client = createTestQueryClient();
  const ids = ["0xa", "0xb", "0xc"] as const;
  const reads: Record<string, number> = { "0xa": 0, "0xb": 0, "0xc": 0 };
  const offs = ids.map((id) =>
    new QueryObserver(client, { queryKey: queryKeys.presales.detail(id), queryFn: async () => { reads[id]! += 1; return { presale: { presale_id: id, phase: "funded" } }; }, staleTime: Number.POSITIVE_INFINITY }).subscribe(() => undefined),
  );
  await settleQueries(client);
  let now = 100_000;
  const timers: { run: () => void; ms: number }[] = [];
  let signal: (hint?: FreshnessHint) => void = () => undefined;
  const off = hintInvalidation(
    client,
    { name: "fake", subscribe: (next) => ((signal = next), () => undefined) },
    { now: () => now, setTimeout: (run, ms) => timers.push({ run, ms }), clearTimeout: () => undefined },
    () => 0,
  );
  try {
    for (const id of ids) signal({ atMs: now, cause: "hint", presaleId: id, lifecycle: "funded" });
    await settleQueries(client);
    assert.deepEqual(reads, { "0xa": 2, "0xb": 1, "0xc": 1 }, "the first hint reads its sale at once; the gate keeps the second and drops the third");
    now += 5_000;
    for (const timer of timers.splice(0).filter(({ ms }) => ms <= 5_000)) timer.run();
    await settleQueries(client);
    assert.deepEqual(reads, { "0xa": 2, "0xb": 2, "0xc": 2 }, "the kept hint's look reads the dropped sale too");
  } finally { off(); offs.forEach((stop) => stop()); client.clear(); }
});

test("a migration hint refreshes the allocation, wallet and vesting reads without a page reload", async () => {
  const client = createTestQueryClient();
  const { reads, stop } = observe(client, {
    sale: queryKeys.presales.detail(OPEN),
    viewer: queryKeys.me.presaleViewer([OPEN]),
    wallet: queryKeys.me.wallet(),
    vestings: queryKeys.me.presales(),
    portfolio: queryKeys.me.portfolio(),
    settings: queryKeys.me.settings(),
  });
  await settleQueries(client);
  let signal: (hint?: { atMs: number; cause: "hint"; presaleId: string; lifecycle: string }) => void = () => undefined;
  const off = hintInvalidation(client, { name: "fake", subscribe: next => ((signal = next), () => undefined) }, { now: () => 100_000, setTimeout: () => 0, clearTimeout: () => undefined });
  try {
    signal({ atMs: 100_000, cause: "hint", presaleId: OPEN, lifecycle: "migrated" });
    await settleQueries(client);
    assert.deepEqual(reads, { sale: 2, viewer: 2, wallet: 2, vestings: 2, portfolio: 2, settings: 1 });
  } finally { off(); stop(); client.clear(); }
});

test("vesting reads refresh at the cliff and stop polling after the schedule is claimed", async t => {
  const { mePresalesQuery } = await import("./queries");
  const { fixtureDetail } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const client = createTestQueryClient();
  t.after(() => client.clear());
  const options = mePresalesQuery(async () => null);
  const query = client.getQueryCache().build<SocialMePresales, Error, SocialMePresales, ReturnType<typeof queryKeys.me.presales>>(client, options);
  const sale = fixtureDetail("kstl").presale;
  const vesting = { schedule_id: "v", presale: { ...sale, status: "trading" as const, fill_pct: 100, launched_ms: now, first_unlock_ms: now }, total: "100", claimed: "0", claimable: "0", claimable_usd: null, vested_pct: 0, start_ms: now - 1_000, cliff_end_ms: now + 2_000, end_ms: now + 60_000 };
  const empty = { created: [], positions: [], coins: [], watchlist: [], vestings: [] };
  assert.equal(typeof options.refetchInterval, "function");
  if (typeof options.refetchInterval !== "function") return;
  query.setData(empty);
  assert.equal(options.refetchInterval(query), false);
  query.setData({ ...empty, vestings: [vesting] });
  assert.equal(options.refetchInterval(query), 2_000);
  query.setData({ ...empty, vestings: [{ ...vesting, cliff_end_ms: now - 1 }] });
  // The mocked clock sits on a whole second, so the 0–20% spread adds nothing here.
  assert.equal(options.refetchInterval(query), 30_000);
  query.setData({ ...empty, vestings: [{ ...vesting, end_ms: now - 1, claimable: "100" }] });
  assert.equal(options.refetchInterval(query), false, "the final unlocked amount is stable until claimed");
  query.setData({ ...empty, vestings: [{ ...vesting, end_ms: now - 1, claimed: "100" }] });
  assert.equal(options.refetchInterval(query), false);
});

test("migration replaces an older phase read already in flight", async t => {
  const client = createTestQueryClient();
  t.after(() => client.clear());
  const key = queryKeys.presales.detail(OPEN);
  let reads = 0;
  const old = Promise.withResolvers<string>();
  const observer = new QueryObserver(client, { queryKey: key, queryFn: async () => { reads++; return reads === 2 ? old.promise : reads === 1 ? "open" : "trading"; } });
  const off = observer.subscribe(() => {});
  t.after(off);
  await settleQueries(client);
  void client.invalidateQueries({ queryKey: key });
  assert.equal(reads, 2);
  let signal: (hint?: import("./home/feed-freshness").FreshnessHint) => void = () => {};
  const stop = hintInvalidation(client, { name: "fake", subscribe: (look) => { signal = look; return () => {}; } }, { now: () => 100_000, setTimeout: () => 0, clearTimeout: () => {} });
  t.after(stop);
  signal({ atMs: 100_000, cause: "hint", presaleId: OPEN, lifecycle: "migrated" });
  await settleQueries(client);
  assert.equal(reads, 3);
  assert.equal(client.getQueryData(key), "trading");
  old.resolve("open");
  await settleQueries(client);
  assert.equal(client.getQueryData(key), "trading", "the older response cannot roll the page back");
});


async function lifecycleHarness(random = 0.5) {
  const client = createTestQueryClient();
  const { reads, stop } = observe(client, { sale: queryKeys.presales.detail(OPEN), wallet: queryKeys.me.wallet() });
  await settleQueries(client);
  let now = 100_000;
  let sequence = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  let signal: (hint?: FreshnessHint) => void = () => {};
  const off = invalidateWithJitter(client, { name: "fake", subscribe: (next) => { signal = next; return () => {}; } }, {
    now: () => now,
    setTimeout: (run, ms) => { const id = ++sequence; pending.set(id, { at: now + ms, run }); return id; },
    clearTimeout: (id) => { pending.delete(Number(id)); },
  }, () => random);
  const due = async (at: number) => {
    const [id, timer] = [...pending].find(([, next]) => next.at === at)!;
    pending.delete(id); now = at; timer.run();
    await settleQueries(client);
  };
  const at = (ms: number) => { now = ms; };
  return { client, reads, pending, due, at, off, stop, signal: (hint: Omit<FreshnessHint, "atMs">) => signal({ atMs: now, ...hint }) };
}

test("lifecycle bursts coalesce, stagger reads, and clean up every scheduled refresh", async () => {
  const { reads, pending, due, off, stop, signal } = await lifecycleHarness();
  for (let i = 0; i < 20; i++) signal({ cause: "hint", presaleId: OPEN, lifecycle: "migrated" });
  await Promise.resolve();
  assert.deepEqual(reads, { sale: 1, wallet: 1 }, "background work waits for its jitter");
  await due(100_500);
  assert.deepEqual(reads, { sale: 2, wallet: 1 }, "the public sale read goes first; the wallet waits its own spread");
  await due(105_500);
  assert.deepEqual(reads, { sale: 2, wallet: 2 }, "one refresh replaces twenty lifecycle signals");
  await due(133_100);
  assert.deepEqual(reads, { sale: 3, wallet: 2 }, "the follow-up spreads the wallet read too");
  await due(138_100);
  assert.deepEqual(reads, { sale: 3, wallet: 3 });
  signal({ cause: "hint", presaleId: OPEN, lifecycle: "trading" });
  await due(138_600);
  assert.ok([...pending.values()].some((timer) => timer.at === 143_600), "a new phase arms a new spread read");
  off();
  assert.equal(pending.size, 0, "a waiting wallet read is cancelled with the rest");
  stop();
});

test("a phase change absorbed by the follow-up's waiting read still replaces an older wallet read in flight", async () => {
  const { client, pending, due, off, stop, signal } = await lifecycleHarness();
  signal({ cause: "hint", presaleId: OPEN, lifecycle: "migrated" });
  await due(100_500);
  await due(105_500);
  await due(133_100);
  const cancels: Array<boolean | undefined> = [];
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((filters, options) => {
    if (JSON.stringify(filters?.queryKey) === JSON.stringify(queryKeys.me.wallet())) cancels.push(options?.cancelRefetch);
    return invalidate(filters, options);
  }) as typeof client.invalidateQueries;
  signal({ cause: "hint", presaleId: OPEN, lifecycle: "trading" });
  await due(133_600);
  assert.equal([...pending.values()].filter((timer) => timer.at === 138_100).length, 1, "absorbed, not a second read");
  await due(138_100);
  assert.deepEqual(cancels, [true]);
  off();
  stop();
});

test("a catch-up is one tab's own event: its wallet read does not wait for a spread", async () => {
  const { reads, pending, due, at, off, stop, signal } = await lifecycleHarness(0.9);
  signal({ cause: "hint", presaleId: OPEN, lifecycle: "migrated" });
  await due(100_900);
  assert.deepEqual(reads, { sale: 2, wallet: 1 });
  at(106_000);
  signal({ cause: "connect", catchUp: true });
  await due(106_900);
  assert.deepEqual(reads, { sale: 3, wallet: 2 }, "the catch-up reads at once and takes over the waiting read");
  assert.ok(![...pending.values()].some((timer) => timer.at === 109_900));
  off();
  stop();
});
