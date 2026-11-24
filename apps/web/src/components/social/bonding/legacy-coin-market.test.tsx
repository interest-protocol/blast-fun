import assert from "node:assert/strict";
import test from "node:test";
import { BLAST_V1_COINS, indexedPoolCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { DEFAULT_CHART_CONTROLS } from "#web/components/launchpad/chart/chart-model.ts";
import { shouldRetry } from "#web/lib/query/client.ts";
import { createTestQueryClient, settleQueries, withQueryClient } from "#web/lib/query/test-client.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import { legacyCoinMarketQuery } from "./bonding-client.ts";

test("V1 market data arrives after the page renders and refreshes the headline and FDV", async (t) => {
  const { document, window } = installTestDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LegacyCoinScreen } = await import("./BondingCoinScreen.tsx");
  const coin = BLAST_V1_COINS[2];
  const market = Promise.withResolvers<void>();
  let price = "0.000012";
  let fdv = "24000.00";
  let unavailable = false;
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname !== "/api/launchpad/discovery") return Response.json({}, { status: 404 });
    assert.equal(url.searchParams.get("catalog"), "graduated");
    assert.equal(url.searchParams.has("cursor"), false);
    reads++;
    await market.promise;
    if (unavailable) return Response.json({}, { status: 503 });
    return Response.json({
      view: "graduated",
      section: { state: "available", data: { rows: [], nextCursor: "fixture-next" }, provenance: { source: "blast-infra", network: null, deployment: null, checkpoint: null, timestampMs: null, observedAt: Date.now(), lagMs: null } },
      legacyMarket: { [coin.coinType]: { price, description: "The Blast Bots coin.", totalSupplyAtoms: "1000000000000000000", feeRate: 3000 } },
      legacyFdvUsd: { [coin.coinType]: fdv },
    });
  });

  const client = createTestQueryClient();
  const container = document.createElement("div");
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); });
  await act(async () => root.render(withQueryClient(client,
    <LegacyCoinScreen {...coin} chart={<div>Coin chart</div>} trade={null} />,
  )));
  assert.match(container.querySelector("h1")?.textContent ?? "", /OurBlastBot/);
  assert.match(container.textContent ?? "", /Coin chart/);
  assert.doesNotMatch(container.textContent ?? "", /\$24K/);

  await act(async () => { market.resolve(); await settleQueries(client); });
  assert.match(container.textContent ?? "", /0\.0₄12SUI.*FDV\$24K/);
  assert.match(container.textContent ?? "", /The Blast Bots coin\..*Total supply1,000,000,000.*Pool trading fee0\.3%/);

  assert.equal(reads, 1);
  const { queryKey } = legacyCoinMarketQuery();
  const refresh = () => act(async () => { await client.refetchQueries({ queryKey }); await settleQueries(client); });
  unavailable = true;
  await refresh();
  assert.doesNotMatch(container.textContent ?? "", /0\.0₄12SUI|FDV\$24K/);
  assert.match(container.textContent ?? "", /The Blast Bots coin\./);

  unavailable = false;
  price = "0.000017";
  fdv = "34000.00";
  await refresh();
  assert.match(container.textContent ?? "", /0\.0₄17SUI.*FDV\$34K/);
});

test("JustOneSui shows its on-chain description and project links with the shared market header", async (t) => {
  const { document } = installTestDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LegacyCoinScreen } = await import("./BondingCoinScreen.tsx");
  const coinType = "0xaaffd090b57fcdcf293f7e7ec59c119acc910eeb5fc4aadfb4185fa56b6a2cb5::suipump::SUIPUMP";
  const coin = indexedPoolCoin(coinType)!;
  let description = 'Just One Sui, the community coin of Sui||{"telegram":"https://t.me/justonesuicto","twitter":"https://x.com/just1sui","website":"https://justonesui.com"}';
  t.mock.method(globalThis, "fetch", async () => Response.json({
    view: "graduated",
    section: { state: "available", data: { rows: [], nextCursor: null }, provenance: { source: "blast-infra", network: null, deployment: null, checkpoint: null, timestampMs: null, observedAt: Date.now(), lagMs: null } },
    legacyMarket: { [coinType]: { price: "0.162", description } },
    legacyFdvUsd: { [coinType]: "240000.00" },
  }));
  const client = createTestQueryClient();
  const container = document.createElement("div");
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); });

  await act(async () => root.render(withQueryClient(client,
    <LegacyCoinScreen {...coin} chart={null} trade={null} legacy={false} verifiedCommunity />,
  )));
  await act(async () => settleQueries(client));
  assert.match(container.textContent ?? "", /0\.000162SUI.*FDV\$240K/);
  const about = [...container.querySelectorAll("section")].find((section) => section.querySelector("h2")?.textContent === "About");
  assert.equal(about?.querySelector("p")?.textContent, "Just One Sui, the community coin of Sui");
  assert.deepEqual([...about?.querySelectorAll("a") ?? []].map((link) => [link.textContent, link.href]), [
    ["Telegram", "https://t.me/justonesuicto"],
    ["X", "https://x.com/just1sui"],
    ["Website", "https://justonesui.com/"],
  ]);

  description = 'Still a description||{"telegram":"javascript:alert(1)","twitter":"https://x.com@elsewhere.example","website":"https://"}';
  await act(async () => client.invalidateQueries({ queryKey: legacyCoinMarketQuery().queryKey }));
  await act(async () => settleQueries(client));
  assert.equal(about?.textContent, "AboutStill a description");
  assert.equal(about?.querySelector("a"), null);
});

test("a refused V1 candle read shows its diagnostic and skips retries without AbortSignal.any", async (t) => {
  const { document, window } = installTestDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LegacyCoinChart } = await import("../coins/LegacyCoinChart.tsx");
  const any = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
  Object.defineProperty(AbortSignal, "any", { ...any, value: undefined });
  t.after(() => Object.defineProperty(AbortSignal, "any", any));
  const coin = BLAST_V1_COINS[0];
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input), window.location.origin);
    assert.match(pathname, /^\/api\/launchpad\/market\/pools\/.*\/candles$/);
    assert.ok(init?.signal);
    reads++;
    return Response.json({ error: { code: "not_found", message: "Untrusted upstream text" } }, {
      status: 404,
      headers: { "X-Request-Id": "v1-candles-fixture", "Retry-After": "90" },
    });
  });

  const client = createTestQueryClient({ queries: { retry: shouldRetry } });
  const container = document.createElement("div");
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); });
  await act(async () => {
    root.render(withQueryClient(client, <LegacyCoinChart poolKey={`cetus:${"0x" + "a".repeat(64)}`} symbol={coin.symbol} decimals={coin.decimals} initialControls={DEFAULT_CHART_CONTROLS} />));
  });
  await act(async () => settleQueries(client));
  const alert = container.querySelector('[role="alert"]');
  assert.match(alert?.textContent ?? "", /Code: not_found\. Reference: v1-candles-fixture\./);
  assert.doesNotMatch(alert?.textContent ?? "", /Untrusted upstream text/);
  const error = client.getQueryCache().find({ queryKey: ["legacy-pool-candles"], exact: false })?.state.error;
  assert.ok(error);
  assert.equal(Reflect.get(error, "httpStatus"), 404);
  assert.equal(Reflect.get(error, "retryAfterSeconds"), 90);
  assert.equal(reads, 1);
});

test("a tracked coin shows completed pool swaps with exact coin and SUI amounts while trading is off", async (t) => {
  const { document, window } = installTestDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LegacyCoinScreen } = await import("./BondingCoinScreen.tsx");
  const coin = indexedPoolCoin("0xaaffd090b57fcdcf293f7e7ec59c119acc910eeb5fc4aadfb4185fa56b6a2cb5::suipump::SUIPUMP")!;
  const [venue, poolId] = coin.poolKey.split(":");
  const pending = Promise.withResolvers<void>();
  const digest = "FvFRVLsgYqA3DyDLNaiqFP77Z5UuVrFfYyRzpLEHEwZh";
  const trader = `0x${"5".repeat(64)}`;
  const swap = {
    pool_key: coin.poolKey, venue, kind: "swap", side: "sell", cursor: "28:2:0:0",
    digest, trader, timestamp_ms: 1790338175000, meme_amount: "1234567", quote_amount: "2500000000",
    venue_swap: { amount_in: "1234567", amount_out: "2500000000", ref_amount: "0", before_sqrt_price: "2", after_sqrt_price: "1", a_to_b: true },
    volume_usd: null, price: null, inputs: null, market_cap: null,
  };
  const provenance = { network: "mainnet", deployment_fingerprint: null, checkpoint: 28, timestamp_ms: 1790338175000, observed_ms: 1790338175000, lag_ms: 0 };
  let reply = Response.json({ trades: [], provenance });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname !== `/api/launchpad/market/pools/${venue}/${poolId}/trades` || url.search !== "?limit=4") return Response.json({}, { status: 404 });
    await pending.promise;
    return reply.clone();
  });

  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(withQueryClient(client,
    <LegacyCoinScreen {...coin} chart={null} trade={null} legacy={false} />,
  )));
  assert.match(container.textContent ?? "", /Reading trades/);
  assert.doesNotMatch(container.textContent ?? "", /No swaps indexed yet|Holders|Launch activity/);
  await act(async () => { pending.resolve(); await settleQueries(client); });
  assert.match(container.textContent ?? "", /No swaps indexed yet/);

  const refresh = () => act(async () => { await client.invalidateQueries(); await settleQueries(client); });
  reply = Response.json({ trades: [{ ...swap, pool_key: BLAST_V1_COINS[0].poolKey }], provenance });
  await refresh();
  assert.match(container.textContent ?? "", /Trades couldn’t load/);
  reply = Response.json({ trades: [swap], provenance });
  const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again");
  assert.ok(retry);
  await act(async () => { retry.click(); await settleQueries(client); });
  const row = container.querySelector('ol[aria-label="Recent trades"] li');
  assert.match(row?.textContent ?? "", /Sold/);
  assert.ok(row?.querySelector('[aria-label="Inspect full ONE amount: 1.234567 ONE"]'));
  assert.ok(row?.querySelector('[aria-label="Inspect full SUI amount: 2.5 SUI"]'));
  assert.ok(row?.querySelector(`[aria-label="Inspect full trader address: ${trader}"]`));
  const link = row?.querySelector("a");
  assert.ok(link);
  assert.equal(link.href, `https://suiscan.xyz/mainnet/tx/${digest}`);
  t.mock.method(link, "matches", (selector: string) => selector === ":focus-visible");
  await act(async () => link.focus());
  assert.equal(document.activeElement, link);
  reply = Response.json({ trades: [], provenance });
  await refresh();
  assert.equal(document.activeElement, link);
  await act(async () => link.blur());
  assert.match(container.textContent ?? "", /No swaps indexed yet/);
});
