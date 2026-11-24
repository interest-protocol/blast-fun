import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import { BondingCoinScreen } from "./BondingCoinScreen.tsx";
import { CoinExecution } from "#web/components/launchpad/coin/CoinExecution.tsx";
import type { CoinPage } from "@blast/core/modules/launchpad-coin/contracts.ts";
import { coinScreenFixture } from "../../../../test/fixtures/social/bonding/coin-screen-fixtures.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

function coinScreen(page: CoinPage, verified = false) {
  return <BondingCoinScreen page={page} verified={verified} details={{ tagline: "A permanent coin", iconUrl: "https://example.com/launch.webp", cover: null, links: [] }} slots={{
    chart: <p>Chart fixture</p>, execution: <CoinExecution page={page} />,
    activity: <p>Recent trades fixture</p>, holders: <p>Top holders fixture</p>,
    theses: <p>Theses fixture</p>, market: null, overview: null, discovery: null,
  }} />;
}

function render(page: CoinPage, verified = false) {
  return new JSDOM(renderToStaticMarkup(coinScreen(page, verified))).window.document;
}

test("graduated page leads with venue economics and pool volume instead of the emptied curve", () => {
  const page = coinScreenFixture();
  const doc = render(page);
  const overview = doc.querySelector('[aria-label="Market overview"]')!;
  assert.match(doc.body.textContent!, /Price.*0\.0₄156.*SUI.*Chart fixture.*FDV.*\$53\.9K.*Holders.*Volume 24h.*\$310\.69.*DEX/);
  assert.match(overview.textContent!, /FDV.*Holders.*Volume 24h.*DEX/);
  assert.ok(page.coin.state === "available");
  const tag = doc.querySelector("[data-page-head] [data-coin-type-tag]");
  assert.equal(tag?.querySelector("code")?.textContent, "0x3f1e…8b2c");
  assert.match(tag?.parentElement?.textContent ?? "", /Created by.*Address/);
  assert.ok(tag?.querySelector('button[aria-label$="Copy full coin address"]'));
  assert.equal(doc.querySelector("progress"), null);
  assert.doesNotMatch(doc.body.textContent!, /to graduate|Locked forever|Graduates to|Starting liquidity/);
  assert.match(doc.body.textContent!, /Graduated/);
  assert.equal(doc.querySelector('[aria-label="Launch progress"]'), null);
  assert.equal(doc.querySelector('[aria-label="Launch history"] button')?.getAttribute("aria-expanded"), "false");
});

test("the creator byline uses the wallet’s SuiNS name when available", () => {
  const page = coinScreenFixture();
  const creator = '[data-page-head] .creator';
  const named = render({ ...page, creatorName: "creator.sui" }).querySelector(creator);
  const unnamed = render(page).querySelector(creator);
  assert.equal(named?.textContent, "Created by creator.sui");
  assert.equal(unnamed?.textContent, "Created by 0x5e9f…0b17");
  assert.ok(page.coin.state === "available");
  assert.ok(named?.querySelector('button[aria-label="Created by creator.sui. Copy creator wallet address"]'));
  assert.ok(!named?.innerHTML.includes(page.coin.data.creator!));
});

test("the byline shows the public launch wallet for unclaimed Blast creator rights", () => {
  const page = coinScreenFixture("live");
  assert.ok(page.coin.state === "available" && page.fresh.status === "read");
  const launcher = page.coin.data.creator!;
  const unclaimed = {
    ...page,
    coin: { ...page.coin, data: { ...page.coin.data, creator: null, creatorSource: null, launcher } },
    fresh: { ...page.fresh, launch: { ...page.fresh.launch, creatorRecipient: { kind: "account" as const, accountCommitment: new Uint8Array(32).fill(0xab) } } },
  };
  const selector = '[data-page-head] .creator';
  const byline = render(unclaimed).querySelector(selector);
  assert.equal(byline?.textContent, "Created by 0x5e9f…0b17");
  assert.ok(byline?.querySelector('button[aria-label="Created by 0x5e9f…0b17. Copy creator wallet address"]'));
  assert.ok(!byline?.innerHTML.includes(launcher));

  const missing = render({ ...unclaimed, coin: { ...unclaimed.coin, data: { ...unclaimed.coin.data, launcher: null } } }).querySelector(selector);
  assert.equal(missing?.textContent, "Created by a Blast account");
  assert.equal(missing?.getAttribute("title"), null);
  assert.equal(missing?.querySelector("button"), null);
});

test("the byline uses the on-chain wallet while the indexed creator is missing", () => {
  const page = coinScreenFixture("live");
  assert.ok(page.coin.state === "available" && page.fresh.status === "read");
  const address = page.coin.data.creator!;
  const doc = render({
    ...page,
    coin: { ...page.coin, data: { ...page.coin.data, creator: null, creatorSource: null, launcher: `0x${"a".repeat(64)}` } },
    fresh: { ...page.fresh, launch: { ...page.fresh.launch, creatorRecipient: { kind: "address", address } } },
  });
  const creator = doc.querySelector('[data-page-head] .creator');
  assert.equal(creator?.textContent, "Created by 0x5e9f…0b17");
  assert.ok(!creator?.innerHTML.includes(address));
});

test("clicking the creator byline copies the full wallet behind a SuiNS name", async (t) => {
  const { document, window } = installTestDom();
  const { createRoot } = await import("react-dom/client");
  const page = coinScreenFixture();
  assert.ok(page.coin.state === "available" && page.coin.data.creator);
  const copies: string[] = [];
  const writeText = async (address: string) => { copies.push(address); };
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(coinScreen({ ...page, creatorName: "creator.sui" })));
  const button = container.querySelector<HTMLButtonElement>('button[aria-label$="Copy creator wallet address"]');
  assert.ok(button);
  assert.ok(button.querySelector("svg"));
  const byline = [...button.querySelectorAll("span")].find((span) => span.textContent === "Created by creator.sui");
  assert.ok(byline);
  await act(async () => byline.click());
  assert.deepEqual(copies, [page.coin.data.creator]);
  assert.equal(button.getAttribute("aria-label"), "Copied");
});

test("fresh graduation wins over a lagging curve lifecycle and source", () => {
  const graduated = coinScreenFixture();
  const lagging = coinScreenFixture("live");
  const doc = render({ ...graduated, curve: lagging.curve, source: lagging.source, conflict: { indexed: "live", fresh: "migrated" } });
  assert.ok(doc.querySelector('[aria-label="Market overview"]'));
  assert.equal(doc.querySelector("progress"), null);
  assert.match(doc.body.textContent!, /Graduated.*index is catching up/);
});

test("graduated reading order keeps trades before holders and historical launch information", () => {
  const text = render(coinScreenFixture()).body.textContent!;
  assert.ok(text.indexOf("Chart fixture") < text.indexOf("Recent trades fixture"));
  assert.ok(text.indexOf("Recent trades fixture") < text.indexOf("FDV"));
  assert.ok(text.indexOf("Recent trades fixture") < text.indexOf("Top holders fixture"));
  assert.ok(text.indexOf("Top holders fixture") < text.indexOf("A permanent coin"));
  assert.ok(text.indexOf("Recent trades fixture") < text.indexOf("Tokenomics"));
  assert.equal(text.split("Recent trades fixture").length - 1, 1);
  assert.equal(text.split("Top holders fixture").length - 1, 1);
  assert.match(text, /Pool fees.*Pool trading fee/);
  assert.doesNotMatch(text, /Curve fees|Trade fee · Quote/);
});

test("venue facts remain visible when curve history cannot be read", () => {
  const page = coinScreenFixture();
  const doc = render({ ...page, curve: { state: "unavailable", reason: "down" } });
  assert.match(doc.body.textContent!, /Price.*Chart fixture.*Volume 24h/);
  assert.match(doc.body.textContent!, /Graduated/);
  assert.equal(doc.querySelector('[aria-label="Launch history"]'), null);
});

test("venue economics retain their own units when both coin and curve reads fail", () => {
  const page = coinScreenFixture();
  const doc = render({ ...page, curve: { state: "unavailable", reason: "down" }, coin: { state: "unavailable", reason: "down" } });
  assert.match(doc.body.textContent!, /Price.*0\.0₄156.*Chart fixture.*FDV.*\$53\.9K.*Volume 24h.*\$310\.69/);
});

test("venue outage retains graduation and recovery without curve-price fallback or active trade controls", () => {
  const page = coinScreenFixture();
  const doc = render({ ...page, venue: { state: "unavailable", reason: "down" }, availability: { kind: "venue-unavailable", route: page.fresh.status === "read" ? page.fresh.route : assert.fail(), reason: "unreachable" } });
  const overview = doc.querySelector('[aria-label="Market overview"]')!;
  assert.match(doc.body.textContent!, /Market data is catching upReload/);
  assert.doesNotMatch(doc.body.textContent!, /Complete migration|closed at migration|Couldn’t load pool market data/);
  assert.doesNotMatch(overview.textContent!, /FDV|Volume 24h|Price/);
  assert.match(doc.body.textContent!, /Graduated/);
  assert.equal(doc.querySelectorAll('[aria-label="Trade"] button:not([disabled])').length, 0);
});

test("a full market outage shows one recovery state and keeps the published launch logo", () => {
  const page = coinScreenFixture();
  const route = page.fresh.status === "read" ? page.fresh.route : assert.fail();
  const down = { state: "unavailable", reason: "unreachable" } as const;
  const doc = render({ ...page, curve: down, coin: down, venue: { state: "unavailable", reason: "no venue pool recorded" }, availability: { kind: "venue-unavailable", route, reason: "no venue pool recorded" } });
  assert.equal(doc.body.textContent!.split("Market data is catching up").length - 1, 1);
  assert.doesNotMatch(doc.body.textContent!, /Complete migration|Chart fixture|Recent trades fixture/);
  assert.ok(doc.querySelector('img[src="https://example.com/launch.webp"]'));
});

test("last-good data during a market outage keeps launch facts and only one delay notice", () => {
  const page = coinScreenFixture();
  const cached = coinScreenFixture("migration_ready");
  assert.ok(cached.curve.state === "available" && cached.coin.state === "available");
  const route = page.fresh.status === "read" ? page.fresh.route : assert.fail();
  const reason = "no venue pool recorded";
  const doc = render({
    ...page, curve: { ...cached.curve, state: "stale", reason: "not_ready" },
    coin: { ...cached.coin, state: "stale", reason: "not_ready" },
    conflict: { indexed: "migration_ready", fresh: "migrated" },
    venue: { state: "unavailable", reason },
    availability: { kind: "venue-unavailable", route, reason },
  });
  assert.match(doc.querySelector('[aria-label="Market overview"]')!.textContent!, /Holders/);
  assert.equal(doc.body.textContent!.split("Market data is catching up").length - 1, 1);
  assert.doesNotMatch(doc.body.textContent!, /Market data is delayed|index is catching up|Complete migration|Chart fixture|Recent trades fixture/);
});

test("missing optional price/FDV are omitted; confirmed zero pool volume remains visible", () => {
  const page = coinScreenFixture();
  assert.ok(page.venue?.state === "available");
  const pool = page.venue.data;
  const doc = render({ ...page, venue: { ...page.venue, data: { ...pool, fdvUsd: null, economics: { ...pool.economics, price: null, marketCap: null }, stats: { ...pool.stats, day: { ...pool.stats.day, volumeQuote: 0n, volumeUsd: "0" } } } } });
  const overview = doc.querySelector('[aria-label="Market overview"]')!;
  assert.doesNotMatch(doc.body.textContent!, /Price[^a-z]*[\d.].*SUI|FDV/);
  assert.match(overview.textContent!, /Volume 24h\$0/);
});

test("missing USD conversion omits FDV without relabeling quote amounts as dollars", () => {
  const page = coinScreenFixture();
  assert.ok(page.venue?.state === "available");
  const doc = render({ ...page, venue: { ...page.venue, data: { ...page.venue.data, fdvUsd: null } } });
  const overview = doc.querySelector('[aria-label="Market overview"]')!;
  assert.doesNotMatch(overview.textContent!, /FDV/);
  assert.match(doc.body.textContent!, /Price.*SUI.*Chart fixture.*Volume 24h\$310\.69/);
});

test("stale venue data is marked delayed without losing the graduated view", () => {
  const page = coinScreenFixture();
  assert.ok(page.venue?.state === "available");
  const doc = render({ ...page, venue: { ...page.venue, state: "stale", reason: "lagging" } });
  assert.match(doc.body.textContent!, /Market data is delayed/);
  assert.ok(doc.querySelector('[aria-label="Market overview"]'));
});

test("test quote amounts use the same TSUI display alias after graduation", () => {
  const page = coinScreenFixture();
  assert.ok(page.curve.state === "available");
  const curve = page.curve.data;
  const doc = render({ ...page, curve: { ...page.curve, data: { ...curve, launch: { ...curve.launch, quoteType: CREATE_TEST_SUI_QUOTE_TYPE } } } });
  const overview = doc.querySelector('[aria-label="Market overview"]')!;
  assert.match(doc.body.textContent!, /Price.*TSUI.*Chart fixture.*Volume 24h\$310\.69/);
  assert.match(overview.textContent!, /FDV\$53\.9K/);
});

test("bonding keeps progress while migration-ready shows target reached and keeps curve trading closed", () => {
  const bonding = render(coinScreenFixture("live"));
  assert.ok(bonding.querySelector("progress"));
  assert.match(bonding.body.textContent!, /to graduate/);
  const pending = render(coinScreenFixture("migration_ready"));
  assert.match(pending.body.textContent!, /Graduation target reachedMigration pending/);
  assert.equal(pending.querySelector("progress"), null);
  assert.equal(pending.querySelectorAll('[aria-label="Trade"] button:not([disabled])').length, 0);
});

 test("unknown USD volume omits the figure and label", () => {
  const page = coinScreenFixture("migrated");
  if (!page.venue || !("data" in page.venue)) throw new Error("fixture");
  const pool = page.venue.data;
  const doc = render({ ...page, venue: { ...page.venue, data: { ...pool, stats: { ...pool.stats, day: { ...pool.stats.day, volumeUsd: null } } } } });
  assert.doesNotMatch(doc.querySelector('[aria-label="Market overview"]')!.textContent!, /Volume 24h/);
});


test("active curve puts activity before tokenomics and exposes a single Trades/Holders switch", () => {
  const doc = render(coinScreenFixture("live"));
  const words = doc.body.textContent!;
  assert.ok(words.indexOf("Chart fixture") < words.indexOf("Recent trades fixture"));
  assert.ok(words.indexOf("Recent trades fixture") < words.indexOf("Tokenomics"));
  assert.equal(doc.querySelectorAll('[role="tablist"][aria-label="Trading activity"]').length, 1);
  assert.equal(doc.querySelector('[role="tabpanel"][hidden]')?.textContent, "Top holders fixture");
});

test("known TSUI decimals fill missing indexed fields and unknown quote amounts stay hidden", () => {
  const page = coinScreenFixture("live");
  assert.ok(page.curve.state === "available" && page.coin.state === "available");
  const curve = page.curve.data;
  const economics = curve.launch.economics;
  const coin = page.coin;
  const section = page.curve;
  const missingScale = (quoteType: string) => render({ ...page,
    coin: { ...coin, data: { ...coin.data, quoteDecimals: null } },
    curve: { ...section, data: { ...curve, launch: { ...curve.launch, quoteType, economics: {
      ...economics, inputs: { ...economics.inputs, quoteDecimals: null, quoteReserve: 0n, graduationTarget: 8_000_000_000_000n },
    } } } },
  });
  const known = missingScale(CREATE_TEST_SUI_QUOTE_TYPE);
  known.querySelectorAll('[aria-hidden="true"]').forEach((mark) => mark.remove());
  const text = known.body.textContent!;
  assert.match(text, /0TSUIof 8,000TSUI to graduate/);
  assert.match(text, /Graduates toBluefin/);
  assert.doesNotMatch(text, /8000000000000/);
  const unknown = missingScale("0x123::test_sui::TEST_SUI").body.textContent!;
  assert.match(unknown, /Raise target—/);
  assert.doesNotMatch(unknown, /8000000000000/);
});

test("known deployers get an accessible badge beside the ticker without extra text", () => {
  const page = coinScreenFixture();
  const verified = render(page, true).querySelector("header")!;
  const unverified = render(page).querySelector("header")!;
  const mark = verified.querySelector('h1 [role="img"][aria-label="Known deployer"]');
  assert.ok(mark);
  assert.equal(mark.querySelector("title")?.textContent, "Known deployer");
  assert.equal(verified.querySelector("h1")?.textContent?.match(/\$FROGGY/g)?.length, 1);
  assert.equal(unverified.querySelector('[aria-label="Known deployer"]'), null);
  mark.remove();
  assert.equal(verified.textContent, unverified.textContent);
});
