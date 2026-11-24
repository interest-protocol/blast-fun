import { venueRoute } from "./coin-view";
import assert from "node:assert/strict";
import test from "node:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { decodeLaunchObject } from "@interest-protocol/blast-sdk/launchpad";

import type { LaunchLifecycle } from "@blast/core/modules/launchpad-contract/discovery.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import type { FreshLaunch, RecordedRoute } from "@blast/core/modules/launchpad-coin/fresh-types.ts";
import {
  COIN_FIXTURE,
  CURVE_POOL_KEY,
  VENUE_POOL_KEY,
  coinBody,
  curvePoolBody,
  errorBody,
  launchObjectFixture,
  venuePoolBody,
  wireProvenance,
} from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { createLastGood, readCoinPage, type LastGood } from "@blast/server/modules/launchpad-coin/read.ts";
import type { CoinPage } from "@blast/core/modules/launchpad-coin/contracts.ts";

import type { ChartControls } from "../chart/chart-model";
import { CoinTheses } from "../theses/CoinTheses";
import type { ThesesPosting } from "../theses/theses-model";
import { coinTerminalSlots, type ActivityOptions, type CoinActionSlots, type ThesesSlot } from "./CoinSlots";

const NOW = 1_790_235_061_630;
const ROUTE: RecordedRoute = { venue: "bluefin", tickSpacing: 60, feeRate: 3000n, supported: true, reason: null };

type Answer = Readonly<{ status: number; body: unknown }> | "unreachable";

function infra(routes: Record<string, Answer>): MarketDataDependencies {
  return {
    origin: "https://infra.test",
    now: () => NOW,
    timeoutMs: 1_000,
    statusCacheMs: 0,
    expected: null,
    fetch: (async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/status") return Response.json({ provenance: wireProvenance(NOW) });
      const answer = routes[url.pathname] ?? { status: 404, body: errorBody("not_found", "no such pool") };
      if (answer === "unreachable") throw new TypeError("fetch failed");
      return Response.json(answer.body, { status: answer.status });
    }) as typeof fetch,
  };
}

const CURVE_PATH = `/v1/pools/blast_curve/${COIN_FIXTURE.launchId}`;
const COIN_PATH = `/v1/coins/${COIN_FIXTURE.coinType}`;
const VENUE_PATH = `/v1/pools/bluefin/${COIN_FIXTURE.venuePoolId}`;

function indexed(lifecycle: LaunchLifecycle): Record<string, Answer> {
  return {
    [CURVE_PATH]: { status: 200, body: curvePoolBody(lifecycle, NOW) },
    [COIN_PATH]: { status: 200, body: coinBody(lifecycle, NOW) },
    [VENUE_PATH]: { status: 200, body: venuePoolBody(NOW) },
  };
}

function freshAt(lifecycle: LaunchLifecycle, route: RecordedRoute = ROUTE): FreshLaunch {
  return { status: "read", launch: decodeLaunchObject(launchObjectFixture(lifecycle)), route, readAtMs: NOW };
}

async function coinPage(routes: Record<string, Answer>, fresh: FreshLaunch, lastGood: LastGood = createLastGood()): Promise<CoinPage> {
  const read = await readCoinPage(COIN_FIXTURE.launchId, { market: infra(routes), readFresh: async () => fresh, lastGood });
  if (read.kind !== "coin") throw new Error("expected a coin page");
  return read.page;
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function render(page: CoinPage, actions?: CoinActionSlots) {
  const slots = coinTerminalSlots(page, actions);
  return {
    market: renderToStaticMarkup(<>{slots.market}</>),
    chart: renderToStaticMarkup(<>{slots.chart}</>),
    overview: renderToStaticMarkup(<>{slots.overview}</>),
    execution: renderToStaticMarkup(<>{slots.execution}</>),
  };
}

test("the selected-coin header names the coin, its permanent launch ID, creator, lifecycle and market", async () => {
  const { market } = render(await coinPage(indexed("live"), freshAt("live")));
  assert.match(market, /<h1[^>]*>Froggy<\/h1>/);
  const header = text(market);
  for (const fact of [
    "FROGGY / SUI",
    COIN_FIXTURE.launchId,
    "Launched by 0x5e9f…0b17",
    "Live",
    "Bonding curve",
    "0.000002528… SUI",
    "$1,070.15",
    "Indexed holders 184",
  ]) {
    assert.ok(header.includes(fact), `header shows ${fact}: ${header}`);
  }
});

test("the overview shows every lifecycle, economic, configuration fact", async () => {
  const { overview } = render(await coinPage(indexed("live"), freshAt("live")));
  const facts = text(overview);
  for (const fact of [
    // Lifecycle and graduation.
    "Lifecycle Live",
    "Public start 23 Sept ’26",
    "Opening round 1 h",
    "Graduation target 3,000 SUI",
    "SUI raised 260 SUI",
    "Progress 8.66%",
    // Starting economics, from the SDK.
    "Virtual starting liquidity 1,500 SUI",
    "Curve supply 800,000,000 FROGGY",
    "Opening valuation 1,875 SUI",
    "Valuation at graduation 16,874.99 SUI",
    "Pool opening valuation 15,473.68 SUI",
    // Fees and splits.
    "Creation fee 1 SUI",
    "Curve trade fee 1% SUI · 0% FROGGY",
    "Creator 50%",
    "Added to liquidity 20%",
    "Holder rewards 20%",
    "Buyback & burn 10%",
    // Allocation.
    "Curve 80%",
    "Liquidity 19% FROGGY · 98% SUI",
    "Blast 1% FROGGY · 2% SUI",
    // Venue, route and identity.
    "Migration venue Bluefin",
    "Pool tier Tick spacing 60 · fee rate 3000",
    "Quote SUI",
    COIN_FIXTURE.coinType,
    "Partner 0x0000…00bb Admitted",
    "Creator 0x5e9f…0b17",
    "Launch object",
  ]) {
    assert.ok(facts.includes(fact), `overview shows "${fact}"`);
  }
  assert.doesNotMatch(facts, /NaN|undefined|null|Checkpoint|blast_curve:/);
});

test("execution follows the fresh lifecycle: curve trading, bids, migration, venue", async () => {
  const actions: CoinActionSlots = {
    trade: ({ poolKey }) => <p>TRADE {poolKey}</p>,
    bid: ({ launchId, round }) => <p>BID {launchId} from {String(round.startsAtMs)} to {String(round.endsAtMs)} pot {String(round.totalQuote)}</p>,
    migration: ({ route }) => <p>MIGRATE {route.venue}</p>,
  };

  const live = text(render(await coinPage(indexed("live"), freshAt("live")), actions).execution);
  assert.ok(live.includes(`TRADE ${CURVE_POOL_KEY}`));
  assert.ok(!live.includes("MIGRATE"));

  const opening = render(await coinPage(indexed("opening_round"), freshAt("opening_round")), actions).execution;
  // The bid slot receives the fresh launch object's round, never an indexed estimate.
  assert.ok(text(opening).includes(`BID ${COIN_FIXTURE.launchId} from 1790200000000 to 1790203600000 pot 0`), text(opening));
  assert.doesNotMatch(text(opening), /Curve trading opens when the opening round settles/);
  assert.ok(!text(opening).includes("TRADE"));
  assert.match(opening, /<button[^>]*disabled=""[^>]*>Buy<\/button>/);

  const ready = render(await coinPage(indexed("migration_ready"), freshAt("migration_ready")), actions).execution;
  assert.ok(text(ready).includes("MIGRATE bluefin"));
  assert.ok(!text(ready).includes("TRADE"));

  const unsupported: RecordedRoute = { ...ROUTE, venue: "cetus", supported: false, reason: "the launch migrates through another migrators package" };
  const elsewhere = text(render(await coinPage(indexed("migration_ready"), freshAt("migration_ready", unsupported)), actions).execution);
  assert.ok(!elsewhere.includes("MIGRATE"), "no Complete migration on an unsupported route");
  assert.ok(elsewhere.includes("This app cannot complete a Cetus migration: the launch migrates through another migrators package."));

  const migrated = text(render(await coinPage(indexed("migrated"), freshAt("migrated")), actions).execution);
  assert.ok(migrated.includes(`TRADE ${VENUE_POOL_KEY}`));
});

test("default action slots are honest placeholders, never live controls", async () => {
  const live = render(await coinPage(indexed("live"), freshAt("live"))).execution;
  assert.ok(text(live).includes("Buy and sell on the bonding curve open here once trading is connected."));
  const ready = render(await coinPage(indexed("migration_ready"), freshAt("migration_ready"))).execution;
  assert.ok(text(ready).includes("Complete migration to Bluefin opens here once migration is connected."));
});

test("a migrated page reads its venue and keeps the curve's history", async () => {
  const { market, overview, chart } = render(await coinPage(indexed("migrated"), freshAt("migrated")));
  assert.ok(text(market).includes("Migrated"));
  assert.ok(text(market).includes("Bluefin pool"));
  assert.ok(text(market).includes("0.00001562… SUI"));
  assert.ok(text(overview).includes("Price 0.000015625 SUI"));
  assert.ok(text(chart).includes("Price chart couldn’t load."));
  const facts = text(overview);
  for (const fact of [
    "Lifecycle Migrated",
    "Migrated at 24 Sept ’26",
    "FROGGY in pool 190,000,000 FROGGY",
    "SUI in pool 2,940 SUI",
    `Pool address ${VENUE_POOL_KEY.split(":")[1]}`,
    "0xeeee…eeee 1,000,000 FROGGY · 6 SUI",
  ]) {
    assert.ok(facts.includes(fact), `overview shows "${fact}"`);
  }
});

test("an indexer outage cannot offer migration once the launch object is migrated", async () => {
  const routes = { ...indexed("migrated"), [VENUE_PATH]: { status: 503, body: errorBody("not_ready", "starting") } };
  const { execution, market } = render(await coinPage(routes, freshAt("migrated")), { trade: () => <p>TRADE</p>, migration: () => <p>MIGRATE</p> });
  assert.ok(text(market).includes("Market data couldn’t load."), text(market));
  assert.match(text(execution), /Market data is catching up.*Reload/);
  assert.doesNotMatch(text(execution), /TRADE|MIGRATE|closed at migration/);
});

test("a missing venue pool after graduation keeps its distinct explanation", async () => {
  const { execution } = render(await coinPage(indexed("live"), freshAt("migrated")));
  assert.match(text(execution), /Trading on Bluefin is unavailable: no venue pool is recorded/);
  assert.doesNotMatch(text(execution), /Market data is catching up|Complete migration/);
});

test("an indexed/fresh conflict is visible and names which source decides actions", async () => {
  const { market, execution } = render(await coinPage(indexed("live"), freshAt("migration_ready")));
  const notice = text(market);
  assert.ok(notice.includes("The launch is now Migration ready."));
  assert.doesNotMatch(notice, /checkpoint|blast-infra/);
  assert.doesNotMatch(execution, />Buy<\/button>/);
});

test("an outage keeps the last facts Stale with their provenance; nothing is invented", async () => {
  const lastGood = createLastGood();
  const routes: Record<string, Answer> = { ...indexed("live") };
  await coinPage(routes, freshAt("live"), lastGood);
  routes[CURVE_PATH] = "unreachable";
  routes[COIN_PATH] = "unreachable";
  const { overview, market } = render(await coinPage(routes, freshAt("live"), lastGood));
  assert.match(overview, /data-state="stale"/);
  assert.match(text(overview), /Launch facts may be out of date/);
  assert.doesNotMatch(text(overview), /Checkpoint|blast-infra/);
  assert.match(text(market), /Price updates delayed/);

  const never = render(await coinPage({ [CURVE_PATH]: "unreachable", [COIN_PATH]: "unreachable" }, freshAt("live")));
  assert.match(never.overview, /data-state="unavailable"/);
  assert.doesNotMatch(text(never.overview), /SUI\b.*Progress/);
  assert.ok(text(never.market).includes("Unavailable"));
});

test("without a fresh launch object the page explains why nothing can be traded", async () => {
  const fresh: FreshLaunch = { status: "unavailable", reason: "The launch object could not be read from Sui just now." };
  const { execution } = render(await coinPage(indexed("live"), fresh));
  assert.ok(text(execution).includes("Trading is unavailable. The launch object could not be read from Sui just now."));
  assert.match(execution, /<button[^>]*disabled=""[^>]*>Buy<\/button>/);
});

test("an unconfirmed ID shows no source or lifecycle it cannot know", async () => {
  const fresh: FreshLaunch = { status: "unavailable", reason: "The launch object could not be read from Sui just now." };
  const page = await coinPage({ [CURVE_PATH]: "unreachable", [COIN_PATH]: "unreachable" }, fresh);
  const { market, chart } = render(page);
  const header = text(market);
  for (const label of ["Bonding curve", "Lifecycle unknown", "Live", "pool"]) {
    assert.ok(!header.includes(label), `no "${label}" in ${header}`);
  }
  assert.ok(header.includes("Launch details couldn’t be confirmed."));
  assert.ok(!text(chart).includes("blast_curve:"));
});

test("the Holders destination reads the coin's native holder snapshot in the browser, through the app's market route", async () => {
  const page = await coinPage(indexed("live"), freshAt("live"));
  const holders = (shown: CoinPage, market?: Parameters<typeof coinTerminalSlots>[2]) =>
    text(renderToStaticMarkup(<>{coinTerminalSlots(shown, undefined, market).holders}</>));

  const reading = holders(page, { expected: null });
  assert.match(reading, /Loading Loading holders/);
  assert.doesNotMatch(reading, /not connected yet/);

  // Without blast-infra's origin, or before the coin type is known, holders are Unavailable, never zero.
  assert.match(holders(page), /Unavailable Holders couldn’t load/);
  const unknown: CoinPage = { ...page, curve: { state: "unavailable", reason: "unreachable" }, fresh: { status: "unavailable", reason: "down" } };
  assert.match(holders(unknown, { expected: null }), /Unavailable Holders couldn’t load/);
  const unconfirmed: CoinPage = { ...page, confirmed: false };
  assert.match(holders(unconfirmed, { expected: null }), /Unavailable Holders couldn’t load/);
});

test("after the deadline by the server's read the opening slot says the round ended and waits for settlement", async () => {
  const fresh = freshAt("opening_round");
  const ended = render(await coinPage(indexed("opening_round"), { ...fresh, readAtMs: 1_790_203_600_000 } as FreshLaunch), {}).execution;
  assert.ok((/Opening round ended on 23 Sept ’26 ?\. Anyone can settle it\./).test(text(ended)), text(ended));
  const open = render(await coinPage(indexed("opening_round"), { ...fresh, readAtMs: 1_790_203_599_999 } as FreshLaunch), {}).execution;
  assert.ok(text(open).includes("Opening round: bids are open."));
});

test("the chart reads the curve and the recorded venue pool from blast-infra in the browser, around the committed migration", async () => {
  const market = { expected: null };
  const chartMarkup = (shown: CoinPage, chartControls?: ChartControls) =>
    renderToStaticMarkup(<>{coinTerminalSlots(shown, undefined, market, { chartControls }).chart}</>);
  const chart = (shown: CoinPage, chartControls?: ChartControls) => text(chartMarkup(shown, chartControls));

  const page = await coinPage(indexed("migrated"), freshAt("migrated"));
  const migrated = chart(page, { interval: "1h", range: "7d" });
  assert.match(migrated, /Bonding curve/);
  assert.doesNotMatch(migrated, /blast_curve:|bluefin:0x/);
  assert.match(migrated, /Bluefin pool/);
  assert.match(migrated, /Loading bonding curve candles…/);
  assert.match(migrated, /Loading bluefin pool candles…/);
  assert.match(chartMarkup(page), /data-marker="legend"/);
  const liveControls = { interval: "1s", range: "live" } as const;
  assert.match(chartMarkup(page, liveControls), /<option value="live" selected=""/);
  assert.doesNotMatch(migrated, /not connected yet/);

  // Before migration the curve is the only source.
  const live = chart(await coinPage(indexed("live"), freshAt("live")));
  assert.match(live, /Bonding curve/);
  assert.doesNotMatch(live, /Bluefin|Migration committed/);

  // A migration that opened no pool blast-infra tracks keeps the curve and says so.
  const curve = page.curve.state === "available" ? page.curve.data : null;
  assert.ok(curve?.launch.migration);
  const untracked: CoinPage = {
    ...page,
    source: { kind: "venue", venue: "bluefin", poolKey: null },
    curve: { ...page.curve, data: { ...curve, launch: { ...curve.launch, migration: { ...curve.launch.migration, poolKey: null } } } } as CoinPage["curve"],
  };
  assert.match(chart(untracked), /Venue pool candles couldn’t load/);
  assert.match(chartMarkup(untracked, liveControls), /<option value="24h" selected=""/);

  // An unconfirmed launch names no pool.
  const unconfirmed = chart({ ...page, confirmed: false });
  assert.match(unconfirmed, /Price chart couldn’t load/);
  assert.doesNotMatch(unconfirmed, /blast_curve:/);
});

test("the overview carries the launch's fees, read in the browser; without blast-infra or a confirmed launch they are Unavailable", async () => {
  const live = await coinPage(indexed("live"), freshAt("live"));
  const overview = (shown: CoinPage, browser?: Parameters<typeof coinTerminalSlots>[2]) =>
    text(renderToStaticMarkup(<>{coinTerminalSlots(shown, undefined, browser).overview}</>));
  assert.match(overview(live, { expected: null }), /Fees and payouts Loading Reading the launch's fees from blast-infra/);
  assert.match(overview(live), /Fees and payouts Unavailable Fees couldn’t load/);
  assert.match(overview({ ...live, confirmed: false }, { expected: null }), /Fees and payouts Unavailable Fees couldn’t load/);
});

test("the Activity destination reads the launch's activity and flow from blast-infra in the browser", async () => {
  const market = { expected: null };
  const explorer = { environment: "non-production", explorer: { baseUrl: "http://127.0.0.1:9001" } } as const;
  const activity = (shown: CoinPage, browser?: Parameters<typeof coinTerminalSlots>[2], options?: ActivityOptions) =>
    coinTerminalSlots(shown, undefined, browser, { activity: options }).activity as ReactElement<{ source?: Record<string, unknown> }>;
  const words = (element: ReactNode) => text(renderToStaticMarkup(<>{element}</>));

  const live = await coinPage(indexed("live"), freshAt("live"));
  const reading = activity(live, market, { explorer, anchor: "325910100:0:1:1" });
  assert.match(words(reading), /Loading Loading trade flow/);
  assert.match(words(reading), /Loading Loading launch activity/);
  assert.doesNotMatch(words(reading), /not connected yet|Venue trades/);
  assert.deepEqual(reading.props.source, {
    launchId: COIN_FIXTURE.launchId,
    expected: null,
    units: {
      symbol: "FROGGY",
      memeDecimals: 6,
      coinType: COIN_FIXTURE.coinType,
      iconUrl: "https://example.com/froggy.png",
      quoteSymbol: "SUI",
      quoteDecimals: 9,
      quoteType: COIN_FIXTURE.quoteType,
    },
    explorer,
    anchor: "325910100:0:1:1",
    // The chart's pools: the list's trade frames ride the chart's stream.
    livePools: [CURVE_POOL_KEY],
  });

  // After migration the venue pool's swaps are rows of the same classified list: no second list, no second read.
  const migrated = await coinPage(indexed("migrated"), freshAt("migrated"));
  assert.doesNotMatch(words(activity(migrated, market)), /Venue trades|pool's trades/);
  assert.equal(activity(migrated, market).props.source?.venue, undefined);
  assert.deepEqual(activity(migrated, market).props.source?.livePools, [CURVE_POOL_KEY, VENUE_POOL_KEY]);

  // Without blast-infra's origin or a confirmed launch, activity is Unavailable, never empty.
  assert.match(words(activity(live)), /Unavailable Launch activity couldn’t load/);
  assert.match(words(activity({ ...live, confirmed: false }, market)), /Unavailable Launch activity couldn’t load/);
});

test("the chart takes the venue pool from the committed migration, whatever the page's source names", async () => {
  const market = { expected: null };
  const migrated = await coinPage(indexed("migrated"), freshAt("migrated"));
  const both = (page: CoinPage) => {
    const slot = coinTerminalSlots(page, undefined, market).chart as ReactElement<{ page: CoinPage }>;
    return { chart: text(renderToStaticMarkup(slot)), venuePoolKey: venueRoute(slot.props.page)?.poolKey };
  };
  const OTHER_POOL = `bluefin:0x${"c3".repeat(32)}`;
  // The curve records the migration while the coin summary still names the curve.
  const lagging = both({ ...migrated, source: { kind: "curve", poolKey: CURVE_POOL_KEY } });
  assert.equal(lagging.venuePoolKey, VENUE_POOL_KEY);
  // The page's source names another pool than the committed migration: the migration's pool wins for both.
  const other = both({ ...migrated, source: { kind: "venue", venue: "bluefin", poolKey: OTHER_POOL } });
  assert.equal(other.venuePoolKey, VENUE_POOL_KEY);
  assert.doesNotMatch(other.chart, new RegExp(OTHER_POOL));
  // A page source that names no pool yet: the committed migration's pool serves both.
  const sourceUnknown = both({ ...migrated, source: { kind: "venue", venue: "bluefin", poolKey: null } });
  assert.equal(sourceUnknown.venuePoolKey, VENUE_POOL_KEY);
  // Without the curve's record, it falls back to the page's venue source.
  const curveDown = both({ ...migrated, curve: { state: "unavailable", reason: "unreachable" } });
  assert.equal(curveDown.venuePoolKey, VENUE_POOL_KEY);
  // Before migration it has no venue.
  const live = both(await coinPage(indexed("live"), freshAt("live")));
  assert.doesNotMatch(live.chart, /Bluefin/);
});

test("the Theses destination reads the launch's public theses and offers posting only where this app can take posts", async () => {
  const page = await coinPage(indexed("live"), freshAt("live"));
  const posting = (configured: ThesesPosting): ThesesSlot =>
    function PostingTheses({ launchId, symbol }) {
      return <CoinTheses launchId={launchId} symbol={symbol} posting={configured} />;
    };
  const theses = (shown: CoinPage, slot?: ThesesSlot) =>
    text(renderToStaticMarkup(<>{coinTerminalSlots(shown, undefined, null, slot ? { theses: slot } : {}).theses}</>));

  const open = theses(page, posting({ network: "mainnet", privyAppId: "privy-app", nonce: "n" }));
  assert.doesNotMatch(open, /Thesis are their authors' claims, not Blast's/);
  assert.match(open, /Loading Fetching thesis…/);
  assert.match(open, /Post a thesis .* Post with Privy Post with wallet/);
  assert.doesNotMatch(open, /not connected yet/);
  const walletOnly = theses(page, posting({ network: "mainnet", privyAppId: null, nonce: "n" }));
  assert.match(walletOnly, /Post with wallet/);
  assert.doesNotMatch(walletOnly, /Post with Privy/);

  const readOnly = theses(page);
  assert.match(readOnly, /Fetching thesis…/);
  assert.match(readOnly, /Posting is not configured here\./);
  assert.doesNotMatch(readOnly, /Post with/);

  let asked: unknown = null;
  coinTerminalSlots(page, undefined, null, { theses: (launch) => void (asked = launch) });
  assert.deepEqual(asked, { launchId: COIN_FIXTURE.launchId, symbol: "FROGGY" }, "the slot names the launch and its ticker");

  const unconfirmed: CoinPage = { ...page, confirmed: false };
  assert.match(theses(unconfirmed), /Unavailable Thesis couldn’t load/);
});
