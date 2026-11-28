import assert from "node:assert/strict";
import test from "node:test";
import { environmentManager, QueryClient } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { parseDiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { BLAST_V1_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { installLiveSocket, liveTicket, LIVE_TICKET_PATH, type FakeLiveSocket } from "../../../../test/fixtures/lib/live-socket.testing.ts";
import { installTestDom, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
import { bondingCatalogQuery, graduatedMarketCapQuery } from "../bonding/bonding-client.ts";
import { HomeBondingCurves } from "./HomeBondingCurves.tsx";
import { columnRows, homeAlmostColumn, homeNewColumn } from "./home-model.ts";

const NOW = 1_790_235_061_218;
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const provenance = { source: "blast-infra", network: "mainnet", deployment: "d", checkpoint: 7, timestampMs: 1, observedAt: 1, lagMs: 0 };

const curve = (byte: string, progressBps: number | null, extra: Record<string, unknown> = {}) => ({
  launchId: `0x${byte.repeat(32)}`,
  coinType: `0x${byte.repeat(31)}ff::meme::MEME`,
  quoteType: SUI,
  lifecycle: "live",
  name: `Coin ${byte}`,
  symbol: `C${byte}`,
  iconUrl: null,
  createdAtMs: NOW - 120_000,
  graduatedAtMs: null,
  quoteRemaining: "840000000000",
  quoteDecimals: 9,
  progressBps,
  partner: null,
  ...extra,
});

const page = (rows: unknown[], metrics?: Record<string, unknown>, verifiedTeam?: string[]) =>
  parseDiscoveryResponse({ view: "new", section: { state: "available", data: { rows, nextCursor: null }, provenance }, metrics, verifiedTeam });

test("each column keeps only its own stage, at most ten rows", () => {
  const newest = page([curve("01", 400), curve("02", 7_200), curve("03", null), ...["04", "05", "06", "07", "08", "09", "0a", "0b", "0c"].map((byte) => curve(byte, 1_000))]);
  assert.deepEqual(columnRows("new", newest)?.map((row) => row.symbol), ["C01", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C0a", "C0b"], "under 60% (or no progress yet), newest first, ten");
  const closest = page([curve("0a", 10_000, { lifecycle: "migration_ready" }), curve("0b", 6_000), curve("0c", 5_999)]);
  assert.deepEqual(columnRows("almost", closest)?.map((row) => row.symbol), ["C0a", "C0b"], "60% and up only");
  assert.equal(columnRows("graduated", undefined), null, "nothing read yet");
  const empty = parseDiscoveryResponse({ view: "new", section: { state: "empty", provenance } });
  assert.deepEqual(columnRows("graduated", empty), [], "a confirmed empty read is no rows, not loading");
});

// Fails if a short socket page displaces older eligible rows or revives a launch that has crossed a stage.
test("Home fills a partial live New page with older curves from the catalog", () => {
  const live = parseDiscoveryResponse({ view: "new", section: {
    state: "available",
    data: { rows: [
      curve("01", 400),
      curve("02", null, { lifecycle: "migrated" }),
      curve("03", 6_000),
    ], nextCursor: "continued" },
    provenance,
  } });
  const cache = page([
    curve("04", 400, { createdAtMs: NOW - 1_000 }),
    curve("03", 5_999),
    curve("05", 5_999, { createdAtMs: NOW - 200_000 }),
    curve("06", 400, { createdAtMs: NOW - 300_000 }),
  ]);
  const higherRanked = ["0a", "0b", "0c", "0d", "0e", "0f", "10", "11", "12", "13"].map((byte) => curve(byte, 7_000));
  const almost = parseDiscoveryResponse({ view: "near_graduation", section: {
    state: "available",
    data: { rows: [...higherRanked, curve("05", 6_000)], nextCursor: null },
    provenance: { ...provenance, checkpoint: 8 },
  } });
  const newest = homeNewColumn(live, cache, almost);
  assert.equal(newest.needsCatalogTail, true);
  assert.deepEqual(newest.rows?.map((row) => row.symbol), ["C01", "C06"]);
});

// Fails if newer progress leaves an outdated rank or hides a newly eligible curve.
test("Almost graduated ranks newer progress from either Discover list", () => {
  const almost = page([curve("01", 8_000), curve("02", 7_500)]);
  const newest = parseDiscoveryResponse({ view: "new", section: {
    state: "available",
    data: { rows: [curve("03", 8_100), curve("02", 9_000)], nextCursor: null },
    provenance: { ...provenance, checkpoint: 8 },
  } });
  assert.deepEqual(homeAlmostColumn(almost, newest)?.map((row) => row.symbol), ["C02", "C03", "C01"]);
});

// Fails if the open page stops updating across the 60% boundary, an outage, or a return to the tab.
test("Home subscribes on open and catches up after a socket drop without reloading", async (t) => {
  const { document } = installTestDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const live = installLiveSocket();
  const wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
  t.mock.method(Math, "random", () => 0.5);
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: NOW });
  const launch = (progress: number) => curve("01", progress);
  let httpCheckpoint = 7;
  let httpProgress = 5_999;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input), document.URL);
    if (url.pathname === LIVE_TICKET_PATH) return liveTicket();
    assert.equal(url.pathname, "/api/launchpad/discovery");
    const rows = url.searchParams.get("catalog") === "bonding" ? [launch(httpProgress)] : [];
    return Response.json({ view: "new", section: {
      state: "available", data: { rows, nextCursor: null }, provenance: { ...provenance, checkpoint: httpCheckpoint },
    } });
  });
  t.after(async () => {
    await act(() => root.unmount());
    container.remove();
    client.clear();
    live.restore();
    environmentManager.setIsServer(() => wasServer);
  });

  const deployment = "ab".repeat(32);
  const wire = (checkpoint: number) => ({
    network: "mainnet", deployment_fingerprint: deployment, checkpoint,
    timestamp_ms: NOW + checkpoint, observed_ms: NOW + checkpoint + 20, lag_ms: 20,
  });
  const open = (socket: FakeLiveSocket, checkpoint: number) => {
    socket.emit("hint", { type: "hello", provenance: wire(checkpoint), set: true, discovery: true });
    const { seq } = socket.sets().at(-1)!;
    socket.emit("set", { seq, ok: true, held: { pools: [], price_coins: [], presale: null, discovery: true } });
  };
  const show = (socket: FakeLiveSocket, view: "new" | "near_graduation", checkpoint: number, rows: unknown[] | null) => {
    const asOf = { ...provenance, deployment, checkpoint, timestampMs: NOW + checkpoint, observedAt: NOW + checkpoint + 20, lagMs: 20 };
    socket.emit("discovery", { revision: String(checkpoint), provenance: wire(checkpoint), page: { view, section: {
      ...(rows ? { state: "available", data: { rows, nextCursor: null } } : { state: "unavailable", reason: "frame-too-large" }),
      provenance: asOf,
    } } });
  };
  const setVisibility = (visibility: "hidden" | "visible") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const list = (title: string) => container.querySelector(`[aria-label="${title} bonding curves"]`);
  await act(() => root.render(<QueryProvider client={client}><HomeBondingCurves nowMs={NOW} /></QueryProvider>));
  await waitFor(() => list("New")?.textContent?.includes("$C01"), "the initial HTTP list", 1_500);
  const first = await waitFor(() => live.sockets[0], "a socket started by Home", 1_500);
  await act(() => {
    open(first, 8);
    show(first, "new", 8, [launch(6_000)]);
  });
  assert.equal(list("New"), null);
  assert.match(list("Almost graduated")?.textContent ?? "", /\$C01.*60%/);
  await act(() => show(first, "near_graduation", 8, [curve("0f", 7_500), launch(6_000)]));

  await act(() => show(first, "near_graduation", 9, null));
  assert.match(list("Almost graduated")?.textContent ?? "", /\$C0f.*75%.*\$C01.*60%/, "an unavailable frame keeps the last good page");
  await act(() => show(first, "new", 10, [launch(5_800)]));
  assert.match(list("New")?.textContent ?? "", /\$C01.*58%/, "a newer sell updates both columns even while Almost is unavailable");
  assert.equal(list("Almost graduated")?.textContent?.includes("$C01"), false);
  await act(() => first.drop());
  assert.match(list("New")?.textContent ?? "", /\$C01.*58%/, "the last good page stays visible");
  httpCheckpoint = 11;
  httpProgress = 6_200;
  await act(() => t.mock.timers.tick(30_000));
  await waitFor(() => list("Almost graduated")?.textContent?.includes("62%"), "a newer HTTP list during the outage", 1_500);

  await act(() => setVisibility("hidden"));
  await act(() => setVisibility("visible"));
  const replacement = await waitFor(() => live.sockets[1], "a replacement socket on returning", 1_500);
  await act(() => {
    open(replacement, 12);
    show(replacement, "new", 12, [curve("02", 500), launch(6_300)]);
    show(replacement, "near_graduation", 12, [launch(6_300)]);
  });
  assert.match(list("New")?.textContent ?? "", /\$C02.*5%/);
  assert.match(list("Almost graduated")?.textContent ?? "", /\$C01.*63%/);
});

test("failed reads show a retry in their columns and keep the legacy coins available", () => {
  const fresh = bondingCatalogQuery("bonding", "newest", "", null);
  const closest = bondingCatalogQuery("bonding", "progress", "", null);
  const graduated = graduatedMarketCapQuery();
  const failed = (client: QueryClient, queryKey: readonly unknown[]) =>
    client.getQueryCache().build(client, { queryKey }).setState({ status: "error", error: new Error("503"), fetchStatus: "idle" });
  const render = (client: QueryClient) => renderToStaticMarkup(<QueryProvider client={client}><HomeBondingCurves nowMs={NOW} /></QueryProvider>);
  // A read that failed while Home was open: it stays failed until Retry (a fresh mount would read again).
  const settled = () => new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const oneFailed = settled();
  failed(oneFailed, graduated.queryKey);
  const partly = render(oneFailed);
  assert.match(partly, /aria-label="Loading New"/, "the pending columns keep their own skeletons");
  assert.match(partly, /aria-label="Loading Almost graduated"/);
  assert.match(partly, /role="alert">Couldn’t load\./, "the failed column says so, with Retry");
  const allFailed = settled();
  failed(allFailed, fresh.queryKey);
  failed(allFailed, closest.queryKey);
  failed(allFailed, graduated.queryKey);
  const unavailable = JSDOM.fragment(render(allFailed));
  assert.equal(unavailable.querySelectorAll('[role="alert"]').length, 3);
  assert.equal(unavailable.querySelectorAll('[aria-label="Graduated bonding curves"] a').length, 4);
  // Every background refresh failed, but each read still holds its last rows: they stay on screen.
  const refreshFailed = settled();
  for (const [{ queryKey }, row] of [[fresh, curve("01", 400)], [closest, curve("0b", 7_200)], [graduated, curve("0d", null)]] as const) {
    refreshFailed.setQueryData(queryKey, page([row]));
    failed(refreshFailed, queryKey);
  }
  const kept = render(refreshFailed);
  assert.doesNotMatch(kept, /couldn’t load/i);
  assert.equal(JSDOM.fragment(kept).querySelectorAll('a[href^="/coin/"]').length, 7);
});

test("Home ranks the six V2 slots and all four V1 coins together by circulating market cap", () => {
  const client = new QueryClient();
  const graduated = curve("0d", null, { lifecycle: "migrated", graduatedAtMs: NOW - 3 * 3_600_000 });
  const older = (byte: string) => curve(byte, null, { lifecycle: "migrated" });
  const valuation = (cap: string | null, fdv?: string) => ({
    holders: null,
    market: {
      market_cap_usd: cap,
      fdv_usd: fdv,
      change_24h_bps: null,
      interval_end_ms: 100_000_000,
      baseline_timestamp_ms: null,
      baseline_pool: null,
      current_pool: `blast_curve:${graduated.launchId}`,
      basis: "usd_price",
      baseline_resolution_ms: 300_000,
    },
  });
  client.setQueryData(bondingCatalogQuery("bonding", "newest", "", null).queryKey, page([curve("01", 400)]));
  client.setQueryData(bondingCatalogQuery("bonding", "progress", "", null).queryKey, page([curve("0a", 10_000, { lifecycle: "migration_ready" }), curve("0b", 7_200)]));
  client.setQueryData(graduatedMarketCapQuery().queryKey, parseDiscoveryResponse({
    view: "graduated",
    section: { state: "available", data: { rows: [older("14"), graduated, ...["13", "10", "0f", "0e", "12"].map(older)], nextCursor: null }, provenance },
    metrics: {
      [graduated.launchId]: valuation("112000", "224000"),
      [older("0e").launchId]: valuation(null, "1000000"),
      [older("0f").launchId]: valuation("0"),
      [older("10").launchId]: valuation("99"),
      [older("13").launchId]: valuation("112000.00"),
      [older("14").launchId]: valuation("190000"),
    },
    legacyFdvUsd: {
      [BLAST_V1_COINS[3].coinType]: "1000000.00",
    },
    legacyMarket: {
      [BLAST_V1_COINS[0].coinType]: { marketCapUsd: "243371.31" },
      [BLAST_V1_COINS[1].coinType]: { marketCapUsd: "98.999" },
      [BLAST_V1_COINS[2].coinType]: { marketCapUsd: "99.001" },
      [BLAST_V1_COINS[3].coinType]: { marketCapUsd: "malformed" },
    },
  }));
  const html = renderToStaticMarkup(<QueryProvider client={client}><HomeBondingCurves nowMs={NOW} /></QueryProvider>);
  const words = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  for (const heading of ["New", "Almost graduated", "Graduated"]) assert.match(html, new RegExp(`<h3 [^>]*>${heading}</h3>`));
  assert.match(words, /\$C01 launched 2m ago 4% to graduation/);
  assert.match(words, /\$C0a 100% to graduation/);
  assert.match(words, /\$C0b 72% to graduation/);
  const dom = JSDOM.fragment(html);
  assert.deepEqual(
    Array.from(dom.querySelectorAll('[aria-label="Graduated bonding curves"] a .ticker'), (ticker) => ticker.textContent),
    ["$MANIFEST", "$C14", "$C0d", "$C13", "$BLAST", "$C10", "$Wheels", "$C0f", "$C0e", "$HELMET"],
  );
  assert.match(words, /\$C0d Market cap \$112K graduated 3h ago/);
  assert.doesNotMatch(words, /Coin 0[1abd] |to go|Graduating/, "the ticker stands alone: no name line, no amount left");
  const legacyRows = dom.querySelectorAll('[aria-label="Graduated bonding curves"] li:has([aria-label="Legacy · Blast V1"])');
  assert.equal(dom.querySelectorAll('[aria-label="Legacy · Blast V1"] svg').length, 0);
  assert.deepEqual(Array.from(legacyRows, (row) => row.querySelector("a")?.textContent?.replace("Known deployer", "")), ["$MANIFESTV1Market cap $243K", "$BLASTV1OurBlastBotMarket cap $99", "$WheelsV1Blast WheelsMarket cap $99", "$HELMETV1Trench Helmet"]);
  const ourBlastBotPath = coinPagePath(BLAST_V1_COINS[2].coinType);
  assert.equal(dom.querySelector(`a[href="${ourBlastBotPath}"] img`)?.getAttribute("src"), "/blast-ui/coins/v1-ourblastbot.jpg");
});

test("Home shows Known deployer beside marked curve and V1 coins", () => {
  const client = new QueryClient();
  const fresh = curve("01", 400);
  const almost = curve("0b", 7_200);
  const graduated = curve("0d", null, { lifecycle: "migrated" });
  client.setQueryData(bondingCatalogQuery("bonding", "newest", "", null).queryKey, page([fresh], undefined, [fresh.launchId]));
  client.setQueryData(bondingCatalogQuery("bonding", "progress", "", null).queryKey, page([almost, curve("0c", 6_500)], undefined, [almost.launchId]));
  client.setQueryData(graduatedMarketCapQuery().queryKey, page([graduated], undefined, [graduated.launchId]));

  const html = renderToStaticMarkup(<QueryProvider client={client}><HomeBondingCurves nowMs={NOW} /></QueryProvider>);
  const marks = JSDOM.fragment(html).querySelectorAll('[role="img"][aria-label="Known deployer"]');
  assert.deepEqual(Array.from(marks, (mark) => mark.closest("strong")?.querySelector(".ticker")?.textContent), [
    "$C01", "$C0b", "$C0d", "$MANIFEST", "$Wheels", "$BLAST", "$HELMET",
  ]);
});
