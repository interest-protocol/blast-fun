import assert from "node:assert/strict";
import test from "node:test";
import type { HomeCoinMarket } from "@blast/core/modules/social/contracts/coin-market.ts";
import type { HomeAmount } from "@blast/core/modules/social/contracts/home.ts";
import { installTestDom, waitFor } from "../../../test/fixtures/social/test-dom.ts";
import { installLiveSocket, LIVE_TICKET_PATH, liveTicket } from "../../../test/fixtures/lib/live-socket.testing.ts";
import type { MarketExtras } from "./SalePriceChart.tsx";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SaleMarket, SaleMarketView } = await import("./SaleMarket.tsx");
const { SaleView } = await import("./SaleView.tsx");
const { SaleTradeFeed } = await import("./SaleTrades.tsx");
const { ChartLastTrade } = await import("#web/components/launchpad/chart/ChartLastTrade.tsx");
const { coinsByIdsQuery } = await import("../social/coin-home/home-client.ts");
const { createTestQueryClient, withQueryClient } = await import(
  "#web/lib/query/test-client.ts"
);
const { fixtureMarket } = await import(
  "../../../test/fixtures/presale-pages/market-fixtures.ts"
);
const { queryKeys } = await import("#web/lib/query/keys.ts");
const { FIXTURE_NOW, fixtureDetail } = await import(
  "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts"
);

const view = (coin = fixtureMarket(), overrides = {}) => (
  <SaleMarketView
    coin={coin}
    liquidity={{
      amount: "300000000000000000",
      bps: 3000,
      decimals: 9,
      symbol: coin.symbol,
    }}
    asOf={{ checkpoint: 1, timestamp_ms: FIXTURE_NOW, lag_ms: 0 }}
    volume={[
      {
        quote_type: coin.quote.type,
        quote_symbol: coin.quote.symbol,
        quote_decimals: coin.quote.decimals,
        atoms: "0",
        usd: null,
        usd_complete: false,
      },
    ]}
    nowMs={FIXTURE_NOW}
    loading={false}
    failed={false}
    onRetry={() => {}}
    {...overrides}
  />
);

test("liquidity uses backend allocation independently of wallet balances and market availability", () => {
  const html = renderToStaticMarkup(
    view(fixtureMarket(), { coin: null, failed: true }),
  );
  assert.match(html, /Pool allocation at launch/);
  assert.match(html, /30% of supply/);
  assert.match(html, /300000000 KSTL/);
  const missing = renderToStaticMarkup(view(fixtureMarket(), { liquidity: null }));
  assert.doesNotMatch(missing, /Pool allocation at launch|Unavailable/, "an unread allocation is left out with its label");
  assert.doesNotMatch(missing, /30% of supply/);
});

test("top 100 are paginated by ten, retain ranks, and clamp when a refresh reduces the list", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(view()));
  const next = () =>
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Pages of holders"] [aria-label="Next page"]',
    )!;
  const previous = () =>
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Pages of holders"] [aria-label="Previous page"]',
    )!;
  assert.equal(container.querySelectorAll("table tr").length, 11);
  assert.match(container.textContent!, /1–10 of 100 top holders/);
  const current = () => container.querySelector('[aria-label="Pages of holders"] [aria-current="page"]')?.textContent;
  assert.equal(current(), "1");
  assert.equal(previous().disabled, true);
  assert.match(container.innerHTML, /href="\/@holder1"/);
  await act(async () => next().click());
  assert.match(container.textContent!, /11–20 of 100/);
  assert.ok(!container.querySelector('a[href="/@holder1"]'));
  for (let index = 0; index < 8; index++) await act(async () => next().click());
  assert.match(container.textContent!, /91–100 of 100/);
  assert.equal(next().disabled, true);
  await act(async () => previous().click());
  assert.match(container.textContent!, /81–90 of 100/);
  await act(async () => root.render(view(fixtureMarket(13))));
  assert.match(container.textContent!, /11–13 of 13 top holders/);
  assert.equal(current(), "2");
  await act(async () => root.render(view(fixtureMarket(100))));
  assert.match(container.textContent!, /11–20 of 100 top holders/);
  assert.equal(current(), "2");
});

test("missing, loading, genuine zero, tiny ownership, and failed refresh remain distinct", () => {
  const coin = fixtureMarket(1);
  const loading = renderToStaticMarkup(
    view(coin, { coin: null, loading: true }),
  );
  assert.match(loading, /Loading holders/);
  assert.doesNotMatch(loading, /No holder wallets|>0</);
  const missing = renderToStaticMarkup(
    view(coin, { coin: null, failed: true }),
  );
  assert.match(missing, /Holder data is unavailable|Retry market data/);
  const hidden = renderToStaticMarkup(view(coin, { volume: null }));
  assert.doesNotMatch(hidden, /Volume 24h|Unavailable/, "an unread volume is left out with its label");
  const delayed = renderToStaticMarkup(
    view(coin, {
      asOf: { checkpoint: 1, timestamp_ms: FIXTURE_NOW, lag_ms: 61_000 },
    }),
  );
  assert.match(delayed, /Updates delayed/);
  const old = renderToStaticMarkup(
    view(coin, {
      asOf: { checkpoint: 1, timestamp_ms: FIXTURE_NOW - 61_000, lag_ms: 0 },
    }),
  );
  assert.match(old, /Updates delayed/);
  const zero = renderToStaticMarkup(view({ ...fixtureMarket(0), holders: 0 }));
  assert.match(zero, /No holder wallets yet/);
  const tiny = renderToStaticMarkup(
    view(
      {
        ...coin,
        top_holders: {
          holders: [
            { ...coin.top_holders.holders[0]!, balance: "1", share_bps: 0 },
          ],
          share_bps: 0,
        },
      },
      { failed: true },
    ),
  );
  assert.match(tiny, /&lt;0\.01%/);
  assert.match(tiny, /0\.000000001 KSTL/);
  assert.match(tiny, /Updates delayed/);
  assert.match(tiny, /Retry market data/);
});

test("only a migrated sale mounts market data, with a separate query key from Home's ten holders", () => {
  const client = createTestQueryClient();
  const coin = fixtureMarket();
  const query = coinsByIdsQuery([coin.presale_id!], "24h", 100);
  assert.notDeepEqual(
    query.queryKey,
    coinsByIdsQuery([coin.presale_id!], "24h").queryKey,
  );
  client.setQueryData(query.queryKey, {
    coins: [coin],
    missing: [],
    clock_ms: FIXTURE_NOW,
    window: "24h",
    as_of: { checkpoint: 1, timestamp_ms: FIXTURE_NOW, lag_ms: 0 },
    pool_volumes: { [coin.coin_type]: [] },
  });
  const html = renderToStaticMarkup(
    withQueryClient(
      client,
      <SaleView
        detail={fixtureDetail("kstl")}
        nowMs={FIXTURE_NOW}
        viewerEntry={null}
        tradingClaims={<button>Claim my allocation</button>}
      />,
    ),
  );
  // The market figures follow the chart and precede trades and claim details.
  assert.ok(html.indexOf("Volume 24h") < html.indexOf('id="presaleHistory"'));
  assert.match(html, /<dt>Holders<\/dt><dd>/);
  assert.ok(html.indexOf("data-sale-market") < html.indexOf("Volume 24h"));
  assert.ok(html.indexOf("Volume 24h") < html.indexOf('aria-label="Trading activity"'));
  assert.ok(html.indexOf('aria-label="Trading activity"') < html.indexOf("Claim my allocation"));
  assert.ok(html.indexOf("Claim my allocation") < html.indexOf('id="presaleHistory"'));
  assert.deepEqual([...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1]).slice(0, 3), ["Trades", "Holders", "Posts"]);
  // The Holders tab holds the top holders with the pool's allocation at launch.
  const holders = renderToStaticMarkup(view(coin, { activity: (content: React.ReactNode) => <section aria-label="Activity">{content}</section> }));
  assert.doesNotMatch(holders, /Top holders/);
  assert.match(holders, /30% of supply/);
  assert.match(holders, /300000000 KSTL/);
  // The allocation comes from the sale's own terms.
  const different = fixtureDetail("kstl");
  const allocation = renderToStaticMarkup(withQueryClient(client, <SaleMarket
    nowMs={FIXTURE_NOW}
    sale={different.presale}
    terms={{ ...different.terms!, supply: { ...different.terms!.supply, liquidity: { bps: 2500, amount: "250000000000000000" } } }}
  />));
  assert.match(allocation, /25% of supply/);
  assert.match(allocation, /250000000 KSTL/);
  const active = renderToStaticMarkup(
    withQueryClient(
      client,
      <SaleView
        detail={fixtureDetail("mrdn")}
        nowMs={FIXTURE_NOW}
        viewerEntry={null}
      />,
    ),
  );
  assert.doesNotMatch(active, /Volume 24h|Top holders|>Activity<\/h2>/);
  client.clear();
});

/** The coin market read (`GET /api/social/home/market`, #534) with a FDV and a day's move. */
function fixtureCoinMarket(overrides: Partial<HomeCoinMarket> = {}): HomeCoinMarket {
  const coin = fixtureMarket();
  const window = (change_usd: string | null, change_bps: number | null) => ({
    from_ms: FIXTURE_NOW - 86_400_000, to_ms: FIXTURE_NOW, open_usd: "0.399", open_as_of_ms: FIXTURE_NOW - 86_400_000, change_bps, change_usd,
    buys: 0, sells: 0, bought_atoms: "0", sold_atoms: "0", bought_usd: null, sold_usd: null, unpriced_buys: 0, unpriced_sells: 0, buyers: 0, sellers: 0,
  });
  return {
    coin_type: coin.coin_type, presale_id: coin.presale_id, decimals: 9, quote: coin.quote, clock_ms: FIXTURE_NOW, price_usd: "0.4127", price_as_of_ms: FIXTURE_NOW,
    windows: { "5m": window(null, null), "1h": window(null, null), "4h": window(null, null), "24h": window("0.0137", 342) },
    supply: { total: "1000000000000000000", escrowed: "0", circulating: "1000000000000000000" }, fdv_usd: "412700000.00", market_cap_usd: "4180000.00",
    pool: null, liquidity_usd: null,
    as_of: { checkpoint: 1, timestamp_ms: FIXTURE_NOW, lag_ms: 0 },
    ...overrides,
  };
}

test("Coin board: FDV is between the chart and trades, and the price card gets the day's move", () => {
  let extras: MarketExtras | null = null;
  const chart = (value: MarketExtras) => { extras = value; return <section>Chart fixture</section>; };
  const html = renderToStaticMarkup(view(fixtureMarket(), { market: fixtureCoinMarket(), chart, activity: () => <section>Recent trades fixture</section> }));
  assert.match(html, /Chart fixture.*<dt>FDV<\/dt>.*Recent trades fixture/);
  // Without a pool read the liquidity tile is left out: FDV, Volume 24h, Holders.
  assert.deepEqual([...html.matchAll(/<dt>([^<]+)<\/dt><dd>/g)].map((match) => match[1]), ["FDV", "Holders", "Volume 24h"]);
  assert.match(html, /<dt>FDV<\/dt><dd>.*\$412\.7M/);
  assert.match(html, /Inspect full FDV in USD: \$412700000\.00/);
  assert.deepEqual(extras!.move, { usd: "0.0137", bps: 342 });
  // A read without a FDV or a dollar move leaves both out; a pending read holds the tile's place.
  const bare = fixtureCoinMarket({ fdv_usd: null });
  const none = renderToStaticMarkup(view(fixtureMarket(), { market: { ...bare, windows: { ...bare.windows, "24h": { ...bare.windows["24h"], change_usd: null } } }, chart }));
  assert.doesNotMatch(none, /FDV/);
  assert.equal(extras!.move, null);
  assert.match(renderToStaticMarkup(view(fixtureMarket(), { market: null, marketLoading: true, chart })), /<dt>FDV<\/dt><dd><span aria-hidden="true" class="text">0000<\/span>/);
  assert.doesNotMatch(renderToStaticMarkup(view(fixtureMarket(), { market: null, chart })), /FDV/, "a failed read is left out with its label");
});

test("Coin board: Volume 24h shows a compact total without a breakdown", () => {
  const coin = fixtureMarket();
  const amount = (usd: string | null, usd_complete: boolean): HomeAmount => ({ quote_type: coin.quote.type, quote_symbol: coin.quote.symbol, quote_decimals: coin.quote.decimals, atoms: "31700000000000", usd, usd_complete });
  const tile = (volume: HomeAmount[]) => {
    const html = renderToStaticMarkup(view(coin, { volume }));
    return html.match(/<dt>Volume 24h<\/dt><dd>([\s\S]*?)<\/dd>/)?.[1] ?? "";
  };
  const priced = tile([amount("31700000.00", true)]);
  assert.equal(priced, "$31.7M");
  const unnamed = { ...amount(null, false), quote_type: "0x9::other::OTHER", quote_symbol: null };
  const partial = tile([amount("1200.00", true), unnamed]);
  assert.equal(partial, '$1.2K+<span class="sr-only"> partial total</span>');
  const unpriced = tile([amount(null, false)]);
  assert.match(unpriced, /<i class="[^"]*sale-volume-amount[^"]*">/, "no dollar figure: the coins, at the figure's size");
  assert.match(unpriced, />31\.7M USDC</, "compact like the neighbouring figures, never a wrapped long amount");
  assert.doesNotMatch(unpriced, /data-inspect-value/);
  assert.doesNotMatch(renderToStaticMarkup(view(coin, { volume: [unnamed] })), /Volume 24h|an unlisted coin/);
  const priceNamed = tile([amount(null, false), unnamed]);
  assert.equal((priceNamed.match(/<i class="[^"]*sale-volume-amount/g) ?? []).length, 1, "only the named coin's amount is drawn");
});

test("Coin board: Liquidity shows compact balances and copies exact values", async (t) => {
  const pool = { id: `0x${"9".repeat(64)}`, venue: "cetus", coin_atoms: "12500000000000000000000000", quote_atoms: "1", as_of_ms: Date.UTC(2026, 9, 27, 14) };
  const marketView = view(fixtureMarket(), { market: fixtureCoinMarket({ pool, decimals: 18, quote: { ...fixtureMarket().quote, decimals: 18 }, liquidity_usd: "9420000.00" }) });
  const html = renderToStaticMarkup(marketView);
  assert.deepEqual([...html.matchAll(/<dt>([^<]+)<\/dt><dd>/g)].map((match) => match[1]), ["FDV", "Holders", "Volume 24h", "DEX", "Liquidity"]);
  assert.match(html, /<dt>Liquidity<\/dt><dd>.*\$9\.42M/);
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { copied.push(value); } },
  });
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  });
  await act(async () => root.render(marketView));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Inspect liquidity: $9.42M"]')!.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  assert.equal(dialog.querySelector("p")?.textContent, "12.5M KSTL, 0.0₁₇1 USDC");
  assert.doesNotMatch(dialog.textContent!, /2026-10-27/);
  await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="Copy full liquidity"]')!.click());
  assert.deepEqual(copied, ["$9420000.00\n12500000 KSTL\n0.000000000000000001 USDC"]);
  await act(async () => root.render(view(fixtureMarket(), {
    coin: null,
    liquidity: null,
    market: fixtureCoinMarket({ pool, decimals: 18, quote: { ...fixtureMarket().quote, decimals: 18, symbol: " " }, liquidity_usd: "9420000.00" }),
  })));
  const unnamed = document.querySelector('[role="dialog"]')!;
  const announcement = ["h2", "code", "p"].map((selector) => unnamed.querySelector(selector)!.textContent).join(" ");
  assert.equal(announcement, "liquidity $9.42M Token: 12.5M, Quote: 0.0₁₇1");
  assert.equal(announcement.split(/\s+/).length, 6);
  assert.doesNotMatch(renderToStaticMarkup(view(fixtureMarket(), { market: fixtureCoinMarket({ pool, liquidity_usd: null }) })), /Liquidity/);
});

test("the coin page reads the coin market on Home's public root, keyed by the sale's coin", () => {
  const client = createTestQueryClient();
  const detail = fixtureDetail("kstl");
  client.setQueryData([...queryKeys.home.all, "market", detail.presale.sale_token], fixtureCoinMarket());
  const html = renderToStaticMarkup(withQueryClient(client, <SaleMarket nowMs={FIXTURE_NOW} sale={detail.presale} terms={detail.terms} />));
  assert.match(html, /<dt>FDV<\/dt><dd>.*\$412\.7M/);
  assert.match(html, /<span>Price<\/span><strong>—<\/strong>/);
  assert.doesNotMatch(html, /\$0\.0137/);
  // Another coin's answer is never drawn.
  client.setQueryData([...queryKeys.home.all, "market", detail.presale.sale_token], fixtureCoinMarket({ coin_type: "0x2::other::OTHER" }));
  assert.doesNotMatch(renderToStaticMarkup(withQueryClient(client, <SaleMarket nowMs={FIXTURE_NOW} sale={detail.presale} terms={detail.terms} />)), /FDV|\$0\.0137/);
  client.clear();
});

test("a graduated pool shows a dash until its current close is confirmed", () => {
  const client = createTestQueryClient();
  const detail = fixtureDetail("kstl");
  const sale = { ...detail.presale, price_usd: null };
  const pool = { id: `0x${"9".repeat(64)}`, venue: "cetus", coin_atoms: "1", quote_atoms: "1", as_of_ms: FIXTURE_NOW };
  const market = fixtureCoinMarket({ pool, price_usd: null, price_as_of_ms: null });
  client.setQueryData([...queryKeys.home.all, "market", sale.sale_token], market);
  client.setQueryData(queryKeys.prices.history(`presale:${sale.presale_id}`, "24h"), {
    coin_type: sale.sale_token,
    quote: { coin_type: market.quote.type, symbol: market.quote.symbol, price: "0.0123", as_of_ms: FIXTURE_NOW },
  });
  const html = renderToStaticMarkup(withQueryClient(client, <SaleMarket nowMs={FIXTURE_NOW} sale={sale} terms={detail.terms} />));
  assert.match(html, /<span>Price<\/span><strong>—<\/strong>/);
  assert.doesNotMatch(html, /\+\$0\.0137/);
  client.clear();
});

test("before its first trade read, the headline keeps the width of the sale quote's largest trade", () => {
  const client = createTestQueryClient();
  const sale = fixtureDetail("kstl").presale;
  const html = renderToStaticMarkup(withQueryClient(client, <SaleTradeFeed sale={sale}><ChartLastTrade placement="headline" /></SaleTradeFeed>));
  assert.match(html, new RegExp(`data-width-sample="Large buy · 8+\\u00a0${sale.quote_symbol}"`));
  client.clear();
});

const SWAP_CHART = "/api/social/prices?source=pool_swaps";
const UNCHARTED = "No price history for this pool yet";

/** A graduated sale's market on a pool of `venue`, with every read answering not found. */
async function mountGraduatedSale(t: test.TestContext, venue: string) {
  // A market socket that stays quiet.
  const live = installLiveSocket();
  const client = createTestQueryClient();
  const detail = fixtureDetail("kstl");
  const pool = { id: `0x${"9".repeat(64)}`, venue, coin_atoms: "1", quote_atoms: "1", as_of_ms: FIXTURE_NOW };
  client.setQueryData([...queryKeys.home.all, "market", detail.presale.sale_token], fixtureCoinMarket({ pool }));
  const asked: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (String(input) === LIVE_TICKET_PATH) return liveTicket();
    const url = new URL(String(input), "https://blast.test");
    asked.push(url.pathname + (url.searchParams.get("source") ? `?source=${url.searchParams.get("source")}` : ""));
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    live.restore();
  });
  await act(async () => root.render(withQueryClient(client, <SaleMarket nowMs={FIXTURE_NOW} sale={detail.presale} terms={detail.terms} />)));
  await waitFor(() => document.body.textContent!.includes(UNCHARTED), "the empty state", 5_000);
  return { asked, shared: `/api/launchpad/market/pools/${venue}/${pool.id}/candles` };
}

test("a graduated sale charts its verified pool on the shared market read, and shows the empty state when that read does not know the pool", async (t) => {
  const { asked, shared } = await mountGraduatedSale(t, "bluefin");
  assert.ok(asked.includes(shared), "the verified venue and pool id select the candles");
  assert.equal(asked.filter((path) => path === shared).length, 1);
  assert.ok(!asked.includes(SWAP_CHART), "never the database swap candles");
});

test("a graduated sale on a venue the shared market feed does not index shows the empty state", async (t) => {
  const { asked, shared } = await mountGraduatedSale(t, "aftermath");
  assert.ok(!asked.includes(shared), "the shared read is never asked for a pool it cannot key");
  assert.ok(!asked.includes(SWAP_CHART), "never the database swap candles");
});
