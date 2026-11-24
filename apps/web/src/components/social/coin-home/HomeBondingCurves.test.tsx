import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { parseDiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { BLAST_V1_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { bondingCatalogQuery, graduatedMarketCapQuery } from "../bonding/bonding-client.ts";
import { HomeBondingCurves } from "./HomeBondingCurves.tsx";
import { columnRows } from "./home-model.ts";

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
  assert.equal(dom.querySelector('a[title="Open $BLAST (OurBlastBot)"] img')?.getAttribute("src"), "/blast-ui/coins/v1-ourblastbot.jpg");
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
