import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { createTestQueryClient, withQueryClient } from "#web/lib/query/test-client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import type { SocialPriceHistory } from "@blast/core/modules/social/contracts/prices.ts";
import { SocialViewerProvider } from "#web/components/social/SignInGate.tsx";
import { FIXTURE_NOW, fixtureDetail, fixtureViewerEntry } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";

import { SalePriceChart, SalePriceChartView } from "./SalePriceChart";
import { SaleView, TokenomicsCard } from "./SaleView";
import { SideBox } from "./SaleAside";

const sale = fixtureDetail("kstl");
const history: SocialPriceHistory = {
  presale_id: sale.presale.presale_id,
  coin_type: sale.presale.sale_token,
  tier: "5m",
  from_ms: FIXTURE_NOW - 86_400_000,
  points: [[FIXTURE_NOW - 300_000, "0.002"], [FIXTURE_NOW, "0.0021"]],
  price_usd: "0.0021",
  price_24h_usd: "0.002",
  change_24h_bps: 500,
  day_open_usd: null,
  day_open_ms: null,
};
const chart = (data: SocialPriceHistory | null | undefined, loading = false) => renderToStaticMarkup(
  <SalePriceChartView history={data} loading={loading} onWindow={() => {}} trade={<button>Trade KSTL</button>} window="24h" />,
);

test("quote history draws without supplying a current price", () => {
  const quote = { coin_type: "test::sui::TSUI", symbol: "TSUI", price: "0.000088098231292", as_of_ms: FIXTURE_NOW, points: history.points, change_24h_bps: null };
  const data = { ...history, price_usd: null, points: [], quote };
  const html = chart(data);
  assert.match(html, /<span>Price<\/span><strong>—<\/strong>/);
  assert.match(html, /data-price-history="available"/);
  assert.doesNotMatch(html, /USD price unavailable/);
  assert.doesNotMatch(html, /Last observation|Last checked/);
  assert.doesNotMatch(html, /\$|\+5\.00%/);
  const opening = chart({ ...data, quote: { ...quote, points: [quote.points[0]!] } });
  assert.doesNotMatch(opening, /data-price-history="available"/);
  assert.match(opening, /Waiting for more indexed prices/);
  assert.doesNotMatch(chart({ ...data, price_usd: "0.0021" }), /data-price-history="available"/, "the USD series takes priority");
});

test("old quote observations stay in the historical range", () => {
  const oldPoints = [[FIXTURE_NOW - 172_800_000, "0.000088"], [FIXTURE_NOW - 129_600_000, "0.000088"]] as const;
  const quote = { coin_type: "test::sui::TSUI", symbol: "TSUI", price: "0.000088", as_of_ms: oldPoints[1][0], points: oldPoints, change_24h_bps: null };
  const oldHistory = { ...history, price_usd: null, price_24h_usd: null, change_24h_bps: null, points: [], quote };
  const recent = chart({ ...oldHistory, quote: { ...quote, points: [] } });
  assert.match(recent, /No recorded prices in this period/);
  assert.doesNotMatch(recent, /today/, "an unmeasured change is left out with its label");
  assert.doesNotMatch(recent, /0\.00%|data-price-history="available"/);
  const all = renderToStaticMarkup(<SalePriceChartView history={oldHistory} loading={false} onWindow={() => {}} trade={null} window="launch" />);
  assert.match(all, /data-price-history="available"/);
  assert.match(all, /<span>Price<\/span><strong>—<\/strong>/);
  assert.doesNotMatch(all, /USD price unavailable/);
  assert.doesNotMatch(all, /0\.00%|\$|converted to USD/);
  const opening = chart({ ...oldHistory, quote: { ...quote, points: [oldPoints[0]] } });
  assert.match(opening, /Waiting for more indexed prices/);
  assert.doesNotMatch(opening, /today/);
  assert.doesNotMatch(opening, /0\.00%|data-price-history="available"/);
});

test("a SUI-quoted sale keeps its USD history while current price is unconfirmed", () => {
  const suiSale = fixtureDetail("drft").presale;
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.prices.history(`presale:${suiSale.presale_id}`, "24h"), { ...history, coin_type: suiSale.sale_token, presale_id: suiSale.presale_id });
  const html = renderToStaticMarkup(withQueryClient(client, <SalePriceChart sale={suiSale} trade={<button>Trade DRFT</button>} />));
  assert.match(html, /data-price-history="available"/);
  assert.match(html, /<span>Price<\/span><strong>—<\/strong>/);
  assert.doesNotMatch(html, /today|\$0\.0021/);
  assert.doesNotMatch(html, /USD price unavailable|Not enough history/);
  client.clear();
});

test("the chart draws indexed history when at least two points are available", () => {
  const real = chart(history);
  assert.match(real, /data-price-history="available"/);
  for (const data of [undefined, null, { ...history, points: [] }, { ...history, points: [history.points[0]!] }]) {
    const html = chart(data);
    assert.doesNotMatch(html, /data-price-history="available"/);
    assert.doesNotMatch(html, /recharts|<svg|<canvas/);
    assert.match(html, /Trade KSTL/);
  }
  assert.match(chart(undefined, true), /Loading price history/);
  assert.match(chart(null), /No price history yet/);
  assert.doesNotMatch(chart({ ...history, price_usd: null, change_24h_bps: null }), /today|>-</);
});

test("trading leads with the market, keeps claims above collapsed history, and preserves the active presale layout", () => {
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.prices.history(`presale:${sale.presale.presale_id}`, "24h"), history);
  const html = renderToStaticMarkup(withQueryClient(client, <SaleView detail={sale} nowMs={FIXTURE_NOW} tradingClaims={<button>Claim 440,000,000 KSTL</button>} viewerEntry={null} />));
  assert.ok(html.indexOf("data-sale-market") < html.indexOf("Claim 440,000,000"));
  assert.ok(html.indexOf("Claim 440,000,000") < html.indexOf('id="presaleHistory"'));
  assert.match(html, /<details[^>]*id="presaleHistory"/);
  assert.doesNotMatch(html, /<details[^>]*id="presaleHistory"[^>]*\bopen=/);
  assert.ok(html.indexOf('id="presaleHistory"') < html.indexOf(">Raise<"));
  assert.ok(html.indexOf('id="presaleHistory"') < html.indexOf("sale-raise"), "the pre-sale summary stays accessible in history");
  assert.match(html, />Buy KSTL</);
  const open = renderToStaticMarkup(<SaleView detail={fixtureDetail("mrdn")} nowMs={FIXTURE_NOW} viewerEntry={null} />);
  assert.doesNotMatch(open, /data-sale-market|id="presaleHistory"/);
  assert.match(open, /Raise/);
  client.clear();
});

test("a migrated coin with no price or vesting keeps Trade available without invented market figures", () => {
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.prices.history(`presale:${sale.presale.presale_id}`, "24h"), null);
  const detail = { ...sale, vesting: null, team_vesting: null, presale: { ...sale.presale, price_usd: null, presale_price_usd: null, multiple: null } };
  const html = renderToStaticMarkup(withQueryClient(client, <SaleView detail={detail} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  assert.match(html, />Buy KSTL</);
  assert.match(html, /No price history yet/);
  assert.doesNotMatch(html, /<h2>Team vesting<\/h2>|Vesting window|Since launch<\/h3>/);
  client.clear();
});

test("aggregate vesting dates do not imply a shared recipient schedule", () => {
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.prices.history(`presale:${sale.presale.presale_id}`, "24h"), null);
  const html = renderToStaticMarkup(withQueryClient(client, <SaleView detail={{ ...sale, team_vesting: null }} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  assert.match(html, /Vesting window/);
  assert.match(html, /Recipients may have different vesting schedules/);
  assert.match(html, /Earliest unlock/);
  assert.match(html, /Latest vesting end/);
  client.clear();
});

test("the coin page shows a dash while the pool and current price are unconfirmed", () => {
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.prices.history(`presale:${sale.presale.presale_id}`, "24h"), null);
  const html = renderToStaticMarkup(withQueryClient(client, <SaleView detail={sale} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  const market = html.slice(html.indexOf("data-sale-market"), html.indexOf('id="presaleHistory"'));
  assert.match(market, /<span>Price<\/span><strong>—<\/strong>/);
  assert.doesNotMatch(market, /\$0\.0021/);
  assert.match(market, /No price history yet/);
  assert.doesNotMatch(market, /data-price-history="available"/);
  client.clear();
});

test("missing market prices remain empty and settled allocations are clearly claimed", () => {
  const detail = { ...sale, presale: { ...sale.presale, price_usd: null, multiple: null } };
  const visitor = renderToStaticMarkup(<SideBox detail={detail} entry={null} now={FIXTURE_NOW} />);
  assert.equal(visitor, "", "a visitor has no duplicate price or trade availability card");
  assert.doesNotMatch(visitor, /skeleton|price is updating/);
  const entry = fixtureViewerEntry("kstl");
  const settled = { ...entry, mine: { ...entry.mine!, claimed: true, claimable_tokens: "0", claimed_tokens: "440000000000000000" } };
  const html = renderToStaticMarkup(<SocialViewerProvider signedIn><SideBox detail={detail} entry={settled} now={FIXTURE_NOW} /></SocialViewerProvider>);
  assert.match(html, /Presale tokens claimed/);
  // The card's heading names the coin once ("Your KSTL"); the figure doesn't repeat it.
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelector(".side-h")?.textContent, "Your KSTL");
  assert.equal(document.querySelector("[data-amount-fit] .coin-amount")?.textContent, "440,000,000 KSTL");
  assert.doesNotMatch(html, /data-claim="claim_tokens"/);
});

test("the coin's identity carries its essential facts and actions; the supply is the column's Tokenomics", () => {
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.prices.history(`presale:${sale.presale.presale_id}`, "24h"), history);
  const detail = { ...sale, presale: { ...sale.presale, metadata: { ...sale.presale.metadata!, tagline: "A token description", cover: { url: "https://blob.example/nogas-cover.webp", width: 1536, height: 512 } } } };
  const html = renderToStaticMarkup(withQueryClient(client, <SaleView detail={detail} nowMs={FIXTURE_NOW} viewerEntry={null} watch={{ on: false, toggle: () => undefined }} />));
  const profile = html.slice(html.indexOf("data-coin-identity"), html.indexOf("data-sale-market"));
  assert.doesNotMatch(profile, /<details/);
  for (const label of ["Kestrel", "$KSTL", "Graduated", "Known deployer", "Created by", "Follow"]) assert.ok(profile.includes(label), label);
  assert.match(profile, /<button[^>]*aria-label="Add to watchlist"[^>]*aria-pressed="false"/);
  assert.match(profile, /<button[^>]*aria-label="Presale links"[^>]*aria-haspopup="menu"/);
  assert.match(profile, /aria-label="Address [^"]+\. Copy full coin address"/);
  assert.ok(!profile.includes(detail.presale.sale_token));
  assert.doesNotMatch(profile, /Share on X/);
  const document = new JSDOM(html).window.document;
  const cover = document.querySelector("[data-coin-cover] > img");
  assert.equal(cover?.getAttribute("src"), "https://blob.example/nogas-cover.webp");
  assert.match(cover?.closest("section")?.textContent ?? "", /About.*A token description/);
  assert.ok(!document.querySelector("[data-coin-identity] [data-coin-cover]"));
  assert.ok(html.indexOf("data-sale-market") < html.indexOf("A token description"));
  assert.ok(html.indexOf("A token description") < html.indexOf('id="presaleHistory"'));
  const tokenomics = renderToStaticMarkup(<TokenomicsCard sale={sale.presale} terms={sale.terms!} />);
  assert.match(tokenomics.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), /Tokenomics 1B KSTL, fixed supply Presale buyers 45% 450M KSTL/);
  client.clear();
});

test("a price response for another token cannot label this token's chart", () => {
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.prices.history(`presale:${sale.presale.presale_id}`, "24h"), { ...history, coin_type: "other::coin::OTHER", price_usd: "999" });
  const html = renderToStaticMarkup(withQueryClient(client, <SaleView detail={sale} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  assert.doesNotMatch(html, /\$999/);
  assert.doesNotMatch(html, /Observation time unavailable/);
  client.clear();
});

test("quote history takes precedence over an untimestamped USD summary", () => {
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.prices.history(`presale:${sale.presale.presale_id}`, "24h"), {
    ...history, price_usd: null, points: [],
    quote: { coin_type: "test::sui::TSUI", symbol: "TSUI", price: "0.000088098231292", as_of_ms: FIXTURE_NOW, points: history.points, change_24h_bps: null },
  });
  const html = renderToStaticMarkup(withQueryClient(client, <SaleView detail={sale} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  assert.match(html, /data-price-history="available"/);
  assert.match(html, /<span>Price<\/span><strong>—<\/strong>/);
  assert.doesNotMatch(html, /Last observation|Last checked/);
  client.clear();
});

test("chart timestamps and explanatory captions are omitted while empty and failed states remain", () => {
  const render = (data: SocialPriceHistory | null, failed = false) => renderToStaticMarkup(
    <SalePriceChartView failed={failed} history={data} loading={false} onWindow={() => {}} trade={null} window="24h" />,
  );
  for (const data of [history, { ...history, points: [] }, null]) {
    assert.doesNotMatch(render(data), /Last observation|Last checked|Observation time unavailable|Indexed pool prices|executable quotes|Refreshes every/);
  }
  assert.match(render(null), /No price history yet/);
  assert.match(render(history, true), /Price history could not load/);
});
