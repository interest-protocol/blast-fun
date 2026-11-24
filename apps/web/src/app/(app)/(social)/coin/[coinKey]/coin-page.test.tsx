import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";
import sharp from "sharp";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";

import {
  getAccessFallbackHTTPStatus,
  isHTTPAccessFallbackError,
} from "next/dist/client/components/http-access-fallback/http-access-fallback.js";

import type { BondingCoinScreen } from "#web/components/social/bonding/BondingCoinScreen.tsx";
import { AppShell } from "#web/components/blast-ui/AppShell.tsx";
import type { ComponentProps } from "react";
import type { ChartControls } from "#web/components/launchpad/chart/chart-model.ts";
import type { CoinActionSlots } from "#web/components/launchpad/coin/CoinSlots.tsx";
import { CoinMigrationSlot } from "#web/components/launchpad/migration/CoinMigrationSlot.tsx";
import { isRedirectError } from "next/dist/client/components/redirect-error.js";
import { getURLFromRedirectError } from "next/dist/client/components/redirect.js";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { BLAST_V1_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { COIN_FIXTURE } from "../../../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { FOREIGN_OBJECT_ID, startCoinFixtureServer, type CoinFixtureServer } from "../../../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixture-server.ts";
import { TEST_BLAST_INFRA_KEY } from "../../../../../../test/fixtures/modules/launchpad-market/testing.ts";

// The page reads through the private backend relay. This presentation test keeps the
// real Web reader and the canonical backend handler, and skips only the signed
// transport (native relay parity is exercised by the backend integration suites).
const webReader = import.meta.resolve("#web/lib/backend-api/coin-page.ts");
const backendHandler = import.meta.resolve("@blast/server/private/coin-page.ts");
const runtime = import.meta.resolve("@blast/server/modules/launchpad-coin/runtime.ts");
const serverRead = import.meta.resolve("@blast/server/modules/launchpad-coin/read.ts");
const SALE_TYPE = `0x${"12".repeat(32)}::sale::SALE`;
const SALE_ID = `0x${"24".repeat(32)}`;
const UNAVAILABLE_SALE_ID = `0x${"42".repeat(32)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/headers")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const headers = async () => new Headers(); export const cookies = async () => new Map();",
      };
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "#web/lib/backend-api/coin-page.ts")
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`
          import { coinObjectBackendPageRead, coinTypeBackendPageRead } from ${JSON.stringify(webReader)};
          import { coinPageReadHandler } from ${JSON.stringify(backendHandler)};
          import { coinPageDependencies, coinPageExplorer } from ${JSON.stringify(runtime)};
          import { readCoinPage } from ${JSON.stringify(serverRead)};
          const relay = coinPageReadHandler({
            read: readCoinPage, configured: coinPageDependencies, explorer: coinPageExplorer,
            creatorName: async (address) => address === ${JSON.stringify(COIN_FIXTURE.creator)} ? "creator.sui" : null,
            presaleExists: async (id) => {
              if (id === ${JSON.stringify(UNAVAILABLE_SALE_ID)}) throw new Error("Presale lookup unavailable");
              return id === ${JSON.stringify(SALE_ID)};
            },
            resolve: async (coinType) => {
              if (coinType === ${JSON.stringify(COIN_FIXTURE.coinType)}) return { kind: "launch", coinType, launchId: ${JSON.stringify(COIN_FIXTURE.launchId)} };
              if (coinType === ${JSON.stringify(SALE_TYPE)}) return { kind: "presale", coinType, presaleId: ${JSON.stringify(SALE_ID)} };
              if (coinType === ${JSON.stringify(SUI_COIN_TYPE)}) return { kind: "generic", coinType, name: "Sui", symbol: "SUI" };
              return { kind: "not-found", coinType };
            },
          });
          const dependencies = { origin: "https://www.blast.fun", headers: async () => new Headers(), relay };
          export const readCoinObjectPageFromBackend = coinObjectBackendPageRead(dependencies);
          export const readCoinTypePageFromBackend = coinTypeBackendPageRead(dependencies);
        `)}`,
      };
    return nextResolve(specifier, context);
  },
});

let fixture: CoinFixtureServer;
let CoinPage: typeof import("#web/app/(app)/(social)/coin/[coinKey]/page.tsx").default;
let shareImage: typeof import("#web/app/(app)/(social)/coin/[coinKey]/share-image/route.ts").GET;
let generateMetadata: typeof import("#web/app/(app)/(social)/coin/[coinKey]/page.tsx").generateMetadata;

before(async () => {
  // A keyed blast-infra: the server's reads must carry BLAST_INFRA_API_KEY.
  fixture = await startCoinFixtureServer({ apiKey: TEST_BLAST_INFRA_KEY });
  // The page's process-wide dependencies read these once, on first use.
  Object.assign(process.env, {
    NODE_ENV: "development",
    BLAST_INFRA_ORIGIN: fixture.origin,
    BLAST_INFRA_API_KEY: TEST_BLAST_INFRA_KEY,
  });
  ({ default: CoinPage, generateMetadata } = await import("#web/app/(app)/(social)/coin/[coinKey]/page.tsx"));
  ({ GET: shareImage } = await import("#web/app/(app)/(social)/coin/[coinKey]/share-image/route.ts"));
});

after(() => fixture.close());

/** The page's terminal: its first child. */
function terminalOf<P>(element: ReactElement): ReactElement<P> {
  const [screen] = (element as ReactElement<{ children: ReactElement<{ slots: P }>[] }>).props.children;
  return { ...screen!, props: screen!.props.slots };
}

function params(coinKey: string, search: Record<string, string | string[]> = {}) {
  return { params: Promise.resolve({ coinKey }), searchParams: Promise.resolve(search) };
}

/** The HTTP status a page-level throw answers with, or null when the page rendered. */
async function pageStatus(launchId: string): Promise<number | null> {
  try {
    await CoinPage(params(launchId));
    return null;
  } catch (error) {
    if (isHTTPAccessFallbackError(error)) return getAccessFallbackHTTPStatus(error);
    throw error;
  }
}

test("malformed, unknown and foreign launch IDs answer 404 from the page itself, before any slot", async () => {
  for (const id of ["not-a-launch", "0x2%3", COIN_FIXTURE.launchId.toUpperCase(), "0x2", COIN_FIXTURE.unknownLaunchId, FOREIGN_OBJECT_ID]) {
    assert.equal(await pageStatus(id), 404, id);
  }
  assert.equal((await generateMetadata(params(COIN_FIXTURE.unknownLaunchId))).title, "Page not found");
});

test("the same launch URL renders every lifecycle as one page", async () => {
  for (const lifecycle of ["opening_round", "live", "migration_ready", "migrated"] as const) {
    Object.assign(fixture.state, { indexed: lifecycle, fresh: lifecycle });
    const element = (await CoinPage(params(COIN_FIXTURE.launchId))) as ReactElement<{ children: ReactElement[] }>;
    assert.ok(isValidElement(element));
    const [, live] = element.props.children as ReactElement<Record<string, unknown>>[];
    const terminal = terminalOf<Record<string, unknown>>(element);
    assert.ok(terminal && live);
    assert.equal(live.props.launchId, COIN_FIXTURE.launchId);
    assert.equal(live.props.tradable, false, `${lifecycle}: indexed data cannot enable signing without a released deployment`);
    assert.ok(terminal.props.market && terminal.props.overview && terminal.props.execution);
  }
  const meta = await generateMetadata(params(COIN_FIXTURE.launchId));
  const canonical = `/coin/${encodeURIComponent(COIN_FIXTURE.coinType)}`;
  assert.equal(meta.title, "Froggy (FROGGY)");
  assert.equal(meta.alternates?.canonical, canonical);
  assert.equal(meta.openGraph?.title, "Froggy (FROGGY)");
  assert.equal(meta.openGraph?.url, `https://www.blast.fun${canonical}`);
  assert.deepEqual(meta.openGraph?.images, [{
    url: `https://www.blast.fun${canonical}/share-image?v=2`,
    alt: "Froggy on Blast",
    width: 1200,
    height: 630,
    type: "image/png",
  }]);
  assert.ok(meta.twitter && "card" in meta.twitter);
  assert.equal(meta.twitter.card, "summary_large_image");
  assert.deepEqual(meta.twitter.images, meta.openGraph?.images);
});

test("a type tag opens the same Blast launch before trading and after graduation", async () => {
  for (const lifecycle of ["opening_round", "migrated"] as const) {
    Object.assign(fixture.state, { indexed: lifecycle, fresh: lifecycle, infra: "ok", venue: "ok" });
    const element = (await CoinPage(params(encodeURIComponent(COIN_FIXTURE.coinType)))) as ReactElement<{ children: ReactElement<{ launchId: string }>[] }>;
    assert.equal(element.props.children[1]?.props.launchId, COIN_FIXTURE.launchId);
  }
  assert.equal((await generateMetadata(params(COIN_FIXTURE.coinType))).alternates?.canonical, `/coin/${encodeURIComponent(COIN_FIXTURE.coinType)}`);
});

test("a presale coin type forwards to the presale and preserves the query", async () => {
  await assert.rejects(CoinPage(params(SALE_TYPE, { from: "home" })), (error) =>
    isRedirectError(error) && getURLFromRedirectError(error) === `/presale/${SALE_ID}?from=home`);
});

test("a presale object ID redirects even when launch data is unavailable", async () => {
  Object.assign(fixture.state, { infra: "down", fresh: "down" });
  try {
    await assert.rejects(CoinPage(params(SALE_ID, { from: "home", tab: ["sale", "claims"], ref: "" })), (error) =>
      isRedirectError(error) && getURLFromRedirectError(error) === `/presale/${SALE_ID}?from=home&tab=sale&tab=claims&ref=`);
  } finally {
    Object.assign(fixture.state, { infra: "ok", fresh: "live" });
  }
});

test("an unavailable presale lookup does not turn a possible sale into a 404", async () => {
  await assert.rejects(pageStatus(UNAVAILABLE_SALE_ID), { message: "Coin read unavailable" });
});

test("a short coin type opens an ordinary coin and an unknown type returns 404", async () => {
  const element = await CoinPage(params("0x2::sui::SUI"));
  const dom = JSDOM.fragment(renderToStaticMarkup(element));
  assert.equal(dom.querySelector("h1")?.textContent, "Sui");
  assert.equal(dom.querySelector('h1 [aria-label="Known deployer"]'), null);
  assert.match(dom.textContent ?? "", /\$SUI/);
  assert.equal(dom.querySelector("[data-coin-type-tag] code")?.textContent, "0x0000…0002");
  assert.ok(dom.querySelector('[data-coin-type-tag] button[aria-label$="Copy full coin address"]'));
  const meta = await generateMetadata(params("0x2::sui::SUI"));
  const canonical = `/coin/${encodeURIComponent(SUI_COIN_TYPE)}`;
  assert.equal(meta.alternates?.canonical, canonical);
  const pageUrl = `https://www.blast.fun${canonical}`;
  assert.equal(meta.openGraph?.url, pageUrl);
  const imageUrl = `${pageUrl}/share-image?v=2`;
  const image = { url: imageUrl, alt: "Sui on Blast", width: 1200, height: 630, type: "image/png" };
  assert.deepEqual(meta.openGraph?.images, [image]);
  assert.deepEqual(meta.twitter?.images, [image]);
  const response = await shareImage(new Request(imageUrl), params(encodeURIComponent(SUI_COIN_TYPE)));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  const png = Buffer.from(await response.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  const logoPixel = await sharp(png).extract({ left: 318, top: 375, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  assert.deepEqual([...logoPixel], [77, 162, 255]);
  const ring = await sharp(png).extract({ left: 302, top: 145, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  assert.deepEqual([...ring], [255, 76, 152]);
  assert.equal(await pageStatus("0x2::sui::UNKNOWN"), 404);
});

test("OurBlastBot renders the inline swap with no open sheet before market data arrives", async () => {
  const coinType = "0x577a8addf60a34d4c705914ad066a3b28c3fc40d365ed0d9dfc408f29b4725d3::blast::BLAST";
  const previous = process.env.BLAST_TRADING_ENABLED;
  process.env.BLAST_TRADING_ENABLED = "true";
  try {
    const input = params(encodeURIComponent(coinType));
    const dom = JSDOM.fragment(renderToStaticMarkup(await CoinPage(input)));
    assert.equal(dom.querySelector("h1")?.textContent, "OurBlastBot$BLASTKnown deployerV1");
    const badge = dom.querySelector('h1 [role="img"][aria-label="Legacy · Blast V1"]');
    assert.equal(badge?.textContent, "V1");
    assert.equal(badge?.querySelector("svg"), null);
    assert.equal(dom.querySelector('.status[data-tone="live"]')?.textContent, "Graduated");
    assert.match(dom.querySelector('aside[id="coin-trade"]')?.textContent ?? "", /Buy BLAST.*You pay.*You get/);
    assert.match(dom.querySelector('[aria-label="Market overview"]')?.textContent ?? "", /DEXBluefin/);
    assert.equal(dom.querySelector('[role="dialog"], [aria-label="Trading activity"]'), null);
    const tradeDetails = [...dom.querySelectorAll("#coin-trade button")].find((button) => button.textContent === "Trade details");
    assert.equal(tradeDetails, undefined, "trade details appear after the inline swap has a quote");
    assert.equal((await generateMetadata(input)).title, "OurBlastBot (BLAST)");
  } finally {
    if (previous === undefined) delete process.env.BLAST_TRADING_ENABLED;
    else process.env.BLAST_TRADING_ENABLED = previous;
  }
});

test("a signed-in visitor has Balance and Fund on a legacy coin page on mobile", async () => {
  const coinKey = encodeURIComponent(BLAST_V1_COINS[0].coinType);
  const router = { push: () => undefined, replace: () => undefined, prefetch: () => undefined } as unknown as AppRouterInstance;
  const page = await CoinPage(params(coinKey));
  const html = renderToStaticMarkup(
    <AppRouterContext value={router}>
      <PathnameContext value={`/coin/${coinKey}`}>
        <AppShell
          portfolio={{ status: "ready", summary: { total_usd: 4760.34, today: null } }}
          signInHref="/sign-in"
          signedIn
          viewer={{ accountId: "a-kai", callsign: "kaimoreno", displayName: "Kai Moreno", avatarUrl: null, verified: true }}
        >
          {page}
        </AppShell>
      </PathnameContext>
    </AppRouterContext>,
  );
  const dom = JSDOM.fragment(html);
  const wallet = dom.querySelector("main .pageWallet");
  assert.match(wallet?.textContent ?? "", /\$4,760\.34.*Fund/);
});

test("all four legacy coin pages show the known deployer helmet, shared chart and their DEX", async () => {
  const expected = ["MANIFEST/Cetus", "Blast Wheels/Bluefin", "OurBlastBot/Bluefin", "Trench Helmet/Cetus"];
  const actual = await Promise.all(BLAST_V1_COINS.map(async ({ coinType, name, symbol }) => {
    const dom = JSDOM.fragment(renderToStaticMarkup(await CoinPage(params(encodeURIComponent(coinType)))));
    const chart = dom.querySelector('section[aria-label="Price chart"]');
    assert.match(chart?.querySelector('button[aria-label^="Chart range and interval"]')?.textContent ?? "", /24H.*5m/);
    assert.match(dom.querySelector("[data-coin-type-tag] code")?.textContent ?? "", /^0x[\da-f]{4}…[\da-f]{4}$/);
    assert.ok(dom.querySelector('[data-coin-type-tag] button[aria-label$="Copy full coin address"]'));
    const heading = dom.querySelector("h1")!;
    const badge = heading.querySelector('[role="img"][aria-label="Known deployer"]');
    assert.ok(badge, name);
    const displayName = name.toLowerCase() === symbol.toLowerCase() ? "" : name;
    assert.equal(heading.textContent, `${displayName}$${symbol}${badge.textContent}V1`);
    assert.equal(badge.nextElementSibling?.textContent, "V1");
    return `${name}/${dom.querySelector('[aria-label="Market overview"] dd:last-child [title]')?.getAttribute("title")}`;
  }));
  assert.deepEqual(actual, expected);
});

test("JustOneSui has a Cetus chart and is marked as a verified community", async () => {
  const coinType = "0xaaffd090b57fcdcf293f7e7ec59c119acc910eeb5fc4aadfb4185fa56b6a2cb5::suipump::SUIPUMP";
  const dom = JSDOM.fragment(renderToStaticMarkup(await CoinPage(params(encodeURIComponent(coinType)))));
  const heading = dom.querySelector("h1");
  assert.match(heading?.textContent ?? "", /JustOneSui\$ONE/);
  assert.ok(heading?.querySelector('[aria-label="Verified community"]'));
  assert.equal(heading?.querySelector('[aria-label="Known deployer"], [aria-label="Legacy · Blast V1"]'), null);
  assert.ok(dom.querySelector('section[aria-label="Price chart"]'));
  assert.ok(dom.querySelector('[aria-label="Market overview"] [title="Cetus"]'));
});

test("WP2: the server reads keyed blast-infra; the browser's market slots are handed no blast-infra origin", async () => {
  Object.assign(fixture.state, { indexed: "live", fresh: "live", infra: "ok" });
  const element = (await CoinPage(params(COIN_FIXTURE.launchId))) as ReactElement<{ children: ReactElement[] }>;
  const terminal = terminalOf<Record<string, ReactElement<Record<string, unknown>>>>(element);
  // The header's indexed facts came from the keyed fixture (it refuses a request without the key).
  const header = renderToStaticMarkup(terminal.props.market).replace(/<[^>]+>/g, " ");
  assert.match(header, /Indexed holders\s+\d/, header.slice(0, 400));
  for (const slot of ["chart", "holders", "activity"] as const) {
    const props = JSON.stringify(terminal.props[slot].props, (_, value) => (typeof value === "bigint" ? String(value) : value));
    assert.ok(!props.includes(fixture.origin), `${slot}: ${props.slice(0, 200)}`);
    assert.ok(!props.includes(TEST_BLAST_INFRA_KEY), slot);
  }
  assert.deepEqual(terminal.props.holders.props.market, { expected: null });
});

test("a blast-infra outage keeps a known launch's page instead of a 404", async () => {
  Object.assign(fixture.state, { indexed: "live", fresh: "live", infra: "ok" });
  assert.equal(await pageStatus(COIN_FIXTURE.launchId), null);
  for (const infra of ["down", "starting", "lagging"] as const) {
    fixture.state.infra = infra;
    assert.equal(await pageStatus(COIN_FIXTURE.launchId), null, infra);
  }
  fixture.state.infra = "ok";
});

test("in a total outage an unconfirmed ID renders noindex, never an indexable coin page", async () => {
  Object.assign(fixture.state, { indexed: "live", fresh: "down", infra: "down", venue: "ok" });
  try {
    assert.equal(await pageStatus(COIN_FIXTURE.unknownLaunchId), null, "cannot be called not found either");
    const metadata = await generateMetadata(params(COIN_FIXTURE.unknownLaunchId));
    assert.deepEqual(metadata.robots, { index: false, follow: false });
    assert.equal(metadata.title, "Launch not confirmed");
  } finally {
    Object.assign(fixture.state, { indexed: "live", fresh: "live", infra: "ok", venue: "ok" });
  }
});

test("a MigrationReady launch on a supported route renders the public Complete migration action for its recorded venue", async () => {
  Object.assign(fixture.state, { indexed: "migration_ready", fresh: "migration_ready", infra: "ok", venue: "ok" });
  try {
    const element = (await CoinPage(params(COIN_FIXTURE.launchId))) as ReactElement<{ children: ReactElement[] }>;
    const terminal = terminalOf<{ execution: ReactElement<{ actions?: CoinActionSlots }> }>(element);
    const execution = terminal!.props.execution as ReactElement<{ children: ReactElement<{ actions?: CoinActionSlots }> }>;
    const migration = execution.props.children.props.actions?.migration;
    assert.ok(migration, "the page wires the migration slot");
    const slot = migration({
      launchId: COIN_FIXTURE.launchId,
      route: { venue: "bluefin", tickSpacing: 60, feeRate: 3000n, supported: true, reason: null },
    }) as ReactElement<{ launchId: string; venue: string }>;
    assert.equal(slot.type, CoinMigrationSlot);
    assert.deepEqual(slot.props, { launchId: COIN_FIXTURE.launchId, venue: "bluefin" });
  } finally {
    Object.assign(fixture.state, { indexed: "live", fresh: "live", infra: "ok", venue: "ok" });
  }
});

test("indexed lifecycle data never enables execution before the launch can be read from a released deployment", async () => {
  for (const lifecycle of ["opening_round", "live", "migration_ready", "migrated"] as const) {
    Object.assign(fixture.state, {indexed: lifecycle, fresh: lifecycle});
    const element = await CoinPage(params(COIN_FIXTURE.launchId)) as ReactElement<{children: ReactElement<{execution: ReactNode}>[]}>;
    const slot = terminalOf<{execution: ReactNode}>(element).props.execution as ReactElement<{actions?: CoinActionSlots}>;
    const html = renderToStaticMarkup(cloneElement(slot, {actions: {...slot.props.actions, migration: undefined}}));
    assert.match(html, /data-availability="unverified"/);
    assert.match(html, /Nothing can be signed until the launch object can be read/);
    assert.doesNotMatch(html, /<button(?![^>]*disabled)[^>]*>(Buy|Sell|Review|Join)/);
  }
  Object.assign(fixture.state, {indexed: "live", fresh: "live"});
});

test("a direct link's chart interval and range reach the chart, so a refresh reads the same history", async () => {
  Object.assign(fixture.state, { indexed: "migrated", fresh: "migrated", infra: "ok", venue: "ok" });
  try {
    const chart = async (search: Record<string, string>) => {
      const element = (await CoinPage(params(COIN_FIXTURE.launchId, search))) as ReactElement;
      return terminalOf<{ chart: ReactElement<{ controls: ChartControls }> }>(element).props.chart;
    };
    const linked = await chart({ interval: "1h", range: "7d" });
    assert.deepEqual(linked.props.controls, { interval: "1h", range: "7d" });
    const details = JSDOM.fragment(renderToStaticMarkup(linked)).querySelector('button[aria-label="Source details"]');
    assert.equal(details, null);
    const plain = await chart({ interval: "bogus" });
    assert.deepEqual(plain.props.controls, { interval: "5m", range: "24h" });
    assert.deepEqual((await chart({ range: "all" })).props.controls, { interval: "5m", range: "all" });
    assert.deepEqual((await chart({ range: "live", interval: "1h" })).props.controls, { interval: "1s", range: "live" });
    Object.assign(fixture.state, { indexed: "live", fresh: "live" });
    assert.deepEqual((await chart({})).props.controls, { interval: "5m", range: "all" });
  } finally {
    Object.assign(fixture.state, { indexed: "live", fresh: "live", infra: "ok", venue: "ok" });
  }
});

test("a durable activity link opens Activity at its record, with the configured explorer", async () => {
  Object.assign(fixture.state, { indexed: "live", fresh: "live" });
  const open = async (activity?: string | string[]) => {
    const element = (await CoinPage({ ...params(COIN_FIXTURE.launchId), searchParams: Promise.resolve(activity === undefined ? {} : { activity }) })) as ReactElement<{
      children: ReactElement[];
    }>;
    const terminal = terminalOf<Record<string, unknown>>(element);
    const slot = terminal.props.activity as ReactElement<{ source: { anchor: string | null; explorer: unknown } }>;
    return { terminal: terminal.props, source: slot.props.source };
  };
  const linked = await open("325910100:0:1:1");
  // The Blast page keeps Trades visible on every viewport, with the same durable anchor.
  assert.equal(linked.source.anchor, "325910100:0:1:1");
  assert.equal(linked.source.explorer, null, "no explorer is invented without a released deployment");
  for (const ignored of [undefined, "not-a-position", "12:1:3", ["1:2:3:4", "5:6:7:8"]]) {
    const plain = await open(ignored);
    assert.equal(plain.terminal.initialDestination, undefined, String(ignored));
    assert.equal(plain.source.anchor, null, String(ignored));
  }
  // The page without search params still renders.
  assert.ok(isValidElement(await CoinPage({ params: Promise.resolve({ coinKey: COIN_FIXTURE.launchId }) })));
  // One query carries both URL-held choices: the chart's controls and the activity link.
  const both = await CoinPage(params(COIN_FIXTURE.launchId, { interval: "1h", activity: "325910100:0:1:1" })) as ReactElement;
  const terminal = terminalOf<{
    activity: ReactElement<{ source: { anchor: string | null } }>;
    chart: ReactElement<{ controls: ChartControls }>;
  }>(both).props;
  assert.equal(terminal.activity.props.source.anchor, "325910100:0:1:1");
  assert.equal(terminal.chart.props.controls.interval, "1h");
});


test("the Blast coin page uses quote and venue icons, preserves cover and links, and mounts trading once", async () => {
  Object.assign(fixture.state, { indexed: "live", fresh: "live", infra: "ok" });
  const element = await CoinPage(params(COIN_FIXTURE.launchId)) as ReactElement<{ children: ReactElement[] }>;
  const screen = element.props.children[0]! as ReactElement<ComponentProps<typeof BondingCoinScreen>>;
  const html = renderToStaticMarkup(cloneElement(screen, {
    details: { tagline: "A permanent launch", cover: { url: "https://example.com/cover.webp", width: 1536, height: 512 }, links: [{ label: "Docs", url: "https://example.com/docs" }] },
    slots: { ...screen.props.slots, chart: <p>Chart fixture</p>, execution: <p>Trading fixture</p>, activity: <p>Trades fixture</p>, holders: <p>Holders fixture</p>, theses: <p>Theses fixture</p> },
  }));
  const words = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(words, /\$FROGGY\s+Bonding/);
  assert.match(words, /Created by creator\.sui/);
  assert.match(words, /A permanent launch/);
  assert.match(html, /https:\/\/example.com\/cover.webp/);
  assert.match(html, /href="https:\/\/example.com\/docs"/);
  // Every quote amount names its ticker right after the quote's icon (#1004); no bare ticker, no other quote.
  const suiIconThenTicker = /<span aria-hidden="true" class="mk-sui"[^>]*><svg[^>]*>(?:(?!<\/svg>).)*href="\/blast-ui\/coins\/sui\.svg"(?:(?!<\/svg>).)*<\/svg><\/span><span>SUI<\/span>/g;
  const currencyOptions = JSDOM.fragment(html).querySelectorAll('[aria-label="Price currency"] button');
  const tickerOptions = Array.from(currencyOptions).filter((button) => button.textContent === "SUI").length;
  const tickers = (words.match(/\bSUI\b/g) ?? []).length - tickerOptions;
  assert.ok(tickers > 0);
  assert.equal((html.match(suiIconThenTicker) ?? []).length, tickers);
  assert.doesNotMatch(words, /\bUSDC\b/);
  assert.match(html, /src="\/blast-ui\/dex\/bluefin\.svg"/);
  assert.equal((words.match(/Trading fixture/g) ?? []).length, 1);
});
