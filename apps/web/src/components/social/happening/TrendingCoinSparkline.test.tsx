import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import { createTestQueryClient, settleQueries, withQueryClient } from "#web/lib/query/test-client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import type { HappeningCoin } from "@blast/core/modules/social/contracts/happening.ts";
import { TrendingCoinStripView } from "./TrendingCoinStrip";
import { trendingSparkPath } from "./trending-spark";

test("trending paths sort real times, retain gaps, reject invalid prices and deduplicate observations", () => {
  assert.equal(trendingSparkPath([[40, "2"], [0, "1"], [10, "3"], [10, "4"], [20, "NaN"], [30, "0"], [Infinity, "5"]]), "M0.0,21.0 L18.0,3.0 L72.0,15.0");
  assert.equal(trendingSparkPath([[0, "4"], [40, "1"]]), "M0.0,3.0 L72.0,21.0");
  assert.equal(trendingSparkPath([[0, "1e100"], [40, "1e100"]]), "M0.0,12.0 L72.0,12.0");
  for (const points of [undefined, [], [[0, "1"]] as const, [[0, "1"], [0, "2"]] as const, [[0, "-1"], [1, "Infinity"], [2, ""]] as const]) assert.equal(trendingSparkPath(points), null);
});

test("trending history batches sales, shares cached lines, refreshes with Home and leaves missing/failed slots empty", async () => {
  const { document } = installTestDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  const coins: HappeningCoin[] = [100, -100, 0, null].map((change_24h_bps, index) => ({ coin_type: `0x2::coin::C${index}`, presale_id: `0x${String(index + 1).padStart(64, "0")}`, name: `Coin ${index}`, symbol: `C${index}`, icon_url: null, price_usd: "2", change_24h_bps, buyers_24h: 2, holders: 10 }));
  const prices = coins.slice(0, 3).map((coin, index) => ({
    presale_id: coin.presale_id,
    coin_type: coin.coin_type,
    points: [[0, index === 1 ? "3" : index === 2 ? "2" : "1"], [40, "2"]],
    tier: "5m", from_ms: 0, price_usd: coin.price_usd, price_24h_usd: null,
    change_24h_bps: coin.change_24h_bps, day_open_usd: null, day_open_ms: null,
  }));
  const requests: URL[] = [];
  let fail = false;
  let hold = false;
  let answer: ((response: Response) => void) | undefined;
  const before = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://fixture.test");
    requests.push(url);
    if (hold) return new Promise<Response>((resolve) => { answer = resolve; });
    if (fail) return new Response("", { status: 503 });
    return Response.json({
      window: "24h", clock_ms: 40, as_of: { checkpoint: 1, timestamp_ms: 40, lag_ms: 0 },
      prices: prices.filter((price) => url.searchParams.getAll("presale").includes(price.presale_id!)),
    });
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (expanded: boolean, refresh: number) => act(async () => { root.render(withQueryClient(client, <TrendingCoinStripView coins={coins} expanded={expanded} refresh={refresh} onOpen={() => undefined} />)); });
  const settle = () => act(async () => settleQueries(client));
  try {
    await render(false, 1);
    assert.equal(requests.length, 0, "the compact rail does not ask for charts");
    hold = true;
    await render(true, 1);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(container.querySelectorAll('[data-slot="trending-sparkline"]').length, 4);
    assert.equal(container.querySelectorAll("[data-tradingview-plot]").length, 0, "loading draws no line");
    await act(async () => { answer!(new Response("", { status: 503 })); await settleQueries(client); });
    assert.equal(container.querySelectorAll("[data-tradingview-plot]").length, 0, "a failed initial read draws no line");
    hold = false;
    await render(true, 2);
    await settle();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0]!.searchParams.getAll("presale"), coins.map((coin) => coin.presale_id));
    assert.equal(requests[0]!.searchParams.get("window"), null, "the API's default is rolling 24 hours");
    assert.equal(container.querySelectorAll("[data-tradingview-plot]").length, 3);
    const slots = container.querySelectorAll('[data-slot="trending-sparkline"]');
    assert.match(slots[0]!.className, /up/);
    assert.match(slots[1]!.className, /down/);
    assert.doesNotMatch(slots[2]!.className, /up|down/);
    const buttons = [...container.querySelectorAll("button")];
    const histories = () => coins.map((coin) => client.getQueryData(queryKeys.prices.history(`presale:${coin.presale_id}`, "24h")));
    const loaded = histories();
    assert.deepEqual(loaded.slice(0, 3), prices);
    assert.equal(loaded[3], null, "the missing sale has no history");
    await render(false, 2);
    assert.equal(container.querySelectorAll('[data-slot="trending-sparkline"]').length, 0);
    await render(true, 2);
    await settle();
    assert.equal(requests.length, 2, "re-expanding reuses a fresh cached answer");
    fail = true;
    await render(true, 3);
    await settle();
    assert.equal(container.querySelectorAll("[data-tradingview-plot]").length, 3);
    assert.deepEqual(histories(), loaded, "a failed refresh keeps valid real history");
    assert.deepEqual([...container.querySelectorAll("button")], buttons);
    assert.equal(requests.length, 3, "Home's refresh asks once for the whole list");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = before;
  }
});
