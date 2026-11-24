import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { JSDOM } from "jsdom";

import { QueryProvider } from "#web/lib/query/provider.tsx";
import type { HomeCoin, HomeCoinsByIds } from "@blast/core/modules/social/contracts/home.ts";
import { CBLT, KSTL, SABL, TIDE, happeningPresale, happeningRead } from "../../../../test/fixtures/social/happening/happening-fixtures.ts";
import { PresaleSection } from "./PresaleSection";
import { presaleIdsOf } from "./presale-ids";

test("Home rows expire at the deadline across pins, fastest and upcoming cached lists", () => {
  const cancelled = happeningPresale({ presale_id: "cancelled", lifecycle: "cancelled" });
  const read = happeningRead({ today: [TIDE, CBLT, KSTL, cancelled, SABL], fastest: [TIDE], opening_soon: [SABL] });
  const before = presaleIdsOf(read, TIDE.presale.end_ms - 1);
  assert.deepEqual(before.ids, [TIDE.presale.presale_id, SABL.presale.presale_id]);
  assert.deepEqual([...before.featured], before.ids);
  const ended = presaleIdsOf(read, TIDE.presale.end_ms);
  assert.deepEqual(ended.ids, [SABL.presale.presale_id]);
  assert.deepEqual([...ended.featured], ended.ids);
  assert.deepEqual(presaleIdsOf(null, TIDE.presale.end_ms).ids, []);
});

test("an expired pin cannot re-enter Home from the cached fastest list", () => {
  const read = happeningRead({ today: [TIDE], fastest: [TIDE], opening_soon: [] });
  assert.deepEqual(presaleIdsOf(read, TIDE.presale.end_ms).ids, []);
});

test("the production Home section hides an expired cached pin on its first render", () => {
  const read = happeningRead({ today: [TIDE], fastest: [TIDE], opening_soon: [] });
  const client = new QueryClient();
  try {
    const html = renderToStaticMarkup(
      <QueryProvider client={client}>
        <PresaleSection happening={read} initial={null} initialMs={TIDE.presale.end_ms} nowMs={TIDE.presale.end_ms} window="24h" />
      </QueryProvider>,
    );
    assert.match(html, /No presale is open right now/);
  } finally { client.clear(); }
});

test("the Presales cards read the raise in its own coin, the stage and the time left, and open the sale's page", async () => {
  const { FIXTURE_NOW } = await import("../../../../test/fixtures/social/feed-fixtures.ts");
  const read = happeningRead({ today: [TIDE], fastest: [TIDE], opening_soon: [] });
  const presaleId = TIDE.presale.presale_id;
  const coin: HomeCoin = {
    presale_id: presaleId, coin_type: "0x1::tide::TIDE", symbol: "TIDE", name: "Tidal", icon_url: null, decimals: 9, lifecycle: "open", venue: "cetus", tradable: false,
    opened_ms: null, launched_ms: null, launch_id: null, quote: { type: "0x2::usdc::USDC", symbol: "USDC", decimals: 6 },
    sale: { start_ms: FIXTURE_NOW - 86_400_000, end_ms: FIXTURE_NOW + 101_000_000, raise_target: "400000000000", raised: "312400990000", participants: 12 },
    price_usd: null, price_as_of_ms: null, change_24h_bps: null, holders: null, holders_as_of_ms: null, fdv_usd: null, spark: [],
    activity: { scope: "pool", window: "24h", from_ms: 0, to_ms: 1, participants: 0, events: 0, buyers: 0, sellers: 0, backers: 0, claimers: 0, bought: [], sold: [], committed: [], latest_ms: null, preview: [] },
    top_holders: { holders: [], share_bps: null }, discussion: { posts: 0 }, rank: { score: 0, why: "" },
  };
  const initial: HomeCoinsByIds = { coins: [coin], missing: [], window: "24h", clock_ms: FIXTURE_NOW, as_of: { checkpoint: 1, timestamp_ms: FIXTURE_NOW, lag_ms: 0 } };
  const client = new QueryClient();
  try {
    const html = renderToStaticMarkup(
      <QueryProvider client={client}>
        <PresaleSection happening={read} initial={initial} initialMs={FIXTURE_NOW} nowMs={FIXTURE_NOW} window="24h" />
      </QueryProvider>,
    );
    const document = new JSDOM(html).window.document;
    const card = document.querySelector(`a[href*="${presaleId}"]`);
    assert.ok(card, "the card is a link to the sale");
    assert.match(card!.textContent!, /Tidal\$TIDELive/);
    assert.match(card!.textContent!, /312,400\.99 USDC of 400,000 USDC/, "raised of target in the coin the sale raises, the raised figure never rounded up");
    assert.match(card!.textContent!, /1d 4h left/);
    assert.equal(card!.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "78");
    assert.equal(document.querySelector('nav[aria-label="Pages of presales"]'), null, "one row of cards needs no pager");
  } finally { client.clear(); }
});

test("#588: a Presales card for a sale scheduled to open later reads Upcoming with its opening time", async () => {
  const { FIXTURE_NOW } = await import("../../../../test/fixtures/social/feed-fixtures.ts");
  const read = happeningRead({ today: [TIDE], fastest: [], opening_soon: [] });
  const presaleId = TIDE.presale.presale_id;
  const coin: HomeCoin = {
    presale_id: presaleId, coin_type: "0x1::tide::TIDE", symbol: "TIDE", name: "Tidal", icon_url: null, decimals: 9, lifecycle: "open", venue: "cetus", tradable: false,
    opened_ms: null, launched_ms: null, launch_id: null, quote: { type: "0x2::usdc::USDC", symbol: "USDC", decimals: 6 },
    sale: { start_ms: FIXTURE_NOW + 39 * 60_000, end_ms: FIXTURE_NOW + 101_000_000, raise_target: "400000000000", raised: "0", participants: 0 },
    price_usd: null, price_as_of_ms: null, change_24h_bps: null, holders: null, holders_as_of_ms: null, fdv_usd: null, spark: [],
    activity: { scope: "pool", window: "24h", from_ms: 0, to_ms: 1, participants: 0, events: 0, buyers: 0, sellers: 0, backers: 0, claimers: 0, bought: [], sold: [], committed: [], latest_ms: null, preview: [] },
    top_holders: { holders: [], share_bps: null }, discussion: { posts: 0 }, rank: { score: 0, why: "" },
  };
  const initial: HomeCoinsByIds = { coins: [coin], missing: [], window: "24h", clock_ms: FIXTURE_NOW, as_of: { checkpoint: 1, timestamp_ms: FIXTURE_NOW, lag_ms: 0 } };
  const client = new QueryClient();
  try {
    const html = renderToStaticMarkup(
      <QueryProvider client={client}>
        <PresaleSection happening={read} initial={initial} initialMs={FIXTURE_NOW} nowMs={FIXTURE_NOW} window="24h" />
      </QueryProvider>,
    );
    const card = new JSDOM(html).window.document.querySelector(`a[href*="${presaleId}"]`);
    assert.ok(card);
    assert.match(card!.textContent!, /Tidal\$TIDEUpcoming/);
    assert.equal(card!.querySelector(".status")?.getAttribute("data-tone"), "pending");
    assert.match(card!.textContent!, /Opens in 39m/);
    assert.doesNotMatch(card!.textContent!, /left/);
  } finally { client.clear(); }
});
