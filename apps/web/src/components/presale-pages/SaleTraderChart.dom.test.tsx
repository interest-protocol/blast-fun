import assert from "node:assert/strict";
import test from "node:test";
import { TRADER_PROFILES_QUERY } from "#web/components/launchpad/activity/trader-profiles.ts";
import type { DrawnSeries } from "#web/components/launchpad/chart/chart-geometry.ts";
import { createTestQueryClient, withQueryClient } from "#web/lib/query/test-client.ts";
import { installNoopCanvas, installTestDom, waitFor } from "../../../test/fixtures/social/test-dom.ts";
import { proofThread } from "../../../test/fixtures/workspace/redesign-fixtures.ts";
import { FIXTURE_NOW, fixtureDetail } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";

const dom = installTestDom();
installNoopCanvas(dom);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: KLineCoinChart } = await import("#web/components/charts/kline/KLineCoinChart.tsx");
const { SaleTradeFeed } = await import("./SaleTrades.tsx");

test("a graduated presale chart shows public profiles and wallets from its trade feed", async (t) => {
  const { document, window } = dom;
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  t.mock.getter(window.HTMLElement.prototype, "clientWidth", () => 840);
  t.mock.getter(window.HTMLElement.prototype, "clientHeight", () => 420);
  t.mock.getter(window.HTMLElement.prototype, "offsetWidth", () => 840);
  t.mock.getter(window.HTMLElement.prototype, "offsetHeight", () => 420);
  const sale = fixtureDetail("kstl").presale;
  const thread = proofThread("KSTL");
  const buyer = thread.participants[0]!;
  const seller = thread.participants[1]!;
  const buyAt = FIXTURE_NOW - 599_000;
  const sellAt = FIXTURE_NOW - 299_000;
  const participants = [
    { ...buyer, events: [{ ...buyer.events![0]!, occurred_at_ms: buyAt }] },
    { ...seller, events: [{ ...seller.events![0]!, occurred_at_ms: sellAt }] },
  ];
  let tradeReads = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (new URL(String(input), window.location.origin).pathname === "/api/social/home/activity") {
      tradeReads += 1;
      return Response.json({ ...thread, participants, presale_id: sale.presale_id, clock_ms: FIXTURE_NOW });
    }
    return Response.json({}, { status: 404 });
  });
  const candle = { open: "1", high: "2", low: "1", close: "1", volumeQuote: 10n, volumeMeme: 10n, volumeUsd: null, buys: 1, sells: 1, trades: 2 };
  const sources: DrawnSeries[] = [{ source: "venue", page: {
    poolKey: `cetus:0x${"f".repeat(64)}`, venue: "cetus", source: "venue", interval: "5m", migration: null,
    candles: [{ ...candle, bucketStart: FIXTURE_NOW - 600_000 }, { ...candle, bucketStart: FIXTURE_NOW - 300_000 }],
  } }];
  const client = createTestQueryClient();
  const wallet = seller.actor;
  assert.equal(wallet.type, "address");
  client.setQueryData([TRADER_PROFILES_QUERY, "another chart", true], {
    [`${wallet.address}:${sellAt}`]: { callsign: "oldprofile", avatarUrl: null },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const profileMarker = () => container.querySelector('a[aria-label="@maralin"][href="/@maralin"]');
  const walletMarker = () => container.querySelector(`a[aria-label="${wallet.short}"]`);
  await act(async () => root.render(withQueryClient(client, <SaleTradeFeed sale={sale}>
    <KLineCoinChart sources={sources} interval="5m" memeDecimals={9} quoteDecimals={6} quoteUsd="1" quoteSymbol={sale.quote_symbol} latestAvailable label={sale.symbol} style="line" />
  </SaleTradeFeed>)));
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.match(toggle.closest("label")?.textContent ?? "", /Traders \(all venues\)/);
  await waitFor(() => profileMarker() && walletMarker(), "the presale trader markers", 2_000);
  await act(async () => toggle.click());
  assert.equal(profileMarker(), null);
  assert.equal(walletMarker(), null);
  await act(async () => toggle.click());
  await waitFor(() => profileMarker() && walletMarker(), "the restored trader markers", 2_000);
  assert.equal(tradeReads, 1);
});
