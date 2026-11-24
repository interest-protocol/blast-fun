import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { QueryProvider } from "#web/lib/query/provider.tsx";
import type { HomeCoin, HomeWindow } from "@blast/core/modules/social/contracts/home.ts";
import { CoinCard } from "./CoinCard";
import { HomeMarketActivity } from "./HomeMarketActivity";
import { CoinList, type ListProps } from "./sources";
import { installTestDom, recordAnimations } from "../../../../test/fixtures/social/test-dom.ts";

const coin: HomeCoin = {
  presale_id: null, coin_type: "0x1::fixture::TEST", symbol: "TEST", name: "A long fixture token name",
  icon_url: null, decimals: 9, lifecycle: "migrated", venue: "cetus", tradable: true,
  opened_ms: null, launched_ms: null, launch_id: null, quote: { type: "0x2::sui::SUI", symbol: "SUI", decimals: 9 }, sale: null,
  price_usd: null, price_as_of_ms: null, change_24h_bps: null, holders: null,
  holders_as_of_ms: null, fdv_usd: null, spark: [],
  activity: { scope: "pool", window: "24h", from_ms: 0, to_ms: 1, participants: 0, events: 0,
    buyers: 0, sellers: 0, backers: 0, claimers: 0, bought: [], sold: [], committed: [], latest_ms: null, preview: [] },
  top_holders: { holders: [], share_bps: null }, discussion: { posts: 0 }, rank: { score: 0, why: "" },
};

const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };

test("streamed prices update the existing row without reordering it or changing its FDV", async (t) => {
  const dom = installTestDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const client = new QueryClient();
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host);
  const animations = recordAnimations();
  const streams: Events[] = [];
  class Events extends dom.window.EventTarget {
    constructor(readonly url: string) { super(); streams.push(this); }
    close() {}
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  Object.defineProperty(globalThis, "EventSource", { value: Events, configurable: true });
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
    client.clear();
    if (original) Object.defineProperty(globalThis, "EventSource", original);
    else Reflect.deleteProperty(globalThis, "EventSource");
  });

  const type = (id: string) => `0x${id.repeat(64)}::coin::COIN`;
  const coins = [
    { ...coin, coin_type: type("1"), price_usd: "0.05", price_as_of_ms: 500, fdv_usd: "1000" },
    { ...coin, coin_type: type("2"), price_usd: "0.01", price_as_of_ms: 500, fdv_usd: "200" },
  ];
  const noop = () => undefined;
  const props: ListProps = { source: "discover", window: "24h", nowMs: 1000, sort: "held", streamPrices: true,
    trading: false, page: 1, rows: 10, onPage: noop, onRows: noop };
  const renderRows = (checkpoint: number, shown: readonly HomeCoin[] = coins) => act(() => root.render(
    <AppRouterContext value={router}><QueryProvider client={client}>
      <CoinList coins={shown} props={props} checkpoint={checkpoint} />
    </QueryProvider></AppRouterContext>,
  ));
  await renderRows(10);
  assert.equal(host.querySelector(".hPrice")?.textContent, "Price");
  assert.equal(host.querySelector('[aria-label="Refresh market prices"]'), null);
  const rows = [...host.querySelectorAll("[data-list-row]")];
  assert.equal(streams.length, 1);
  const stream = streams[0]!;
  assert.deepEqual(new URL(stream.url, "https://blast.test").searchParams.getAll("price_coin"), coins.map((row) => row.coin_type));
  const send = (checkpoint: number, price: string, asOf: number) => act(() => {
    stream.dispatchEvent(new dom.window.MessageEvent("prices", { data: JSON.stringify({ checkpoint, prices: [
      { coin_type: type("2"), usd_price: price, as_of_ms: asOf },
    ] }) }));
  });
  await send(11, "0.9", 500);
  assert.equal(rows[1]?.querySelector(".price")?.textContent, "$0.0100", "HTTP wins timestamp ties across different checkpoints");
  const stamped = (priceCheckpoint: number) => coins.map(row => ({ ...row, live_inputs: {
    price_checkpoint: priceCheckpoint, total_supply: null, circulating_supply: null,
    open_1h_usd: null, open_24h_usd: null, baselines_until_ms: 1000,
  } }));
  await renderRows(10, stamped(11));
  assert.equal(rows[1]?.querySelector(".price")?.textContent, "$0.0100", "HTTP wins on the same market checkpoint");
  await renderRows(10, stamped(10));
  assert.equal(rows[1]?.querySelector(".price")?.textContent, "$0.9000", "a later committed market checkpoint corrects the same price timestamp");
  await renderRows(10);
  await send(11, "2", 600);
  assert.deepEqual([...host.querySelectorAll("[data-list-row]")], rows);
  assert.deepEqual(rows.map((row) => row.querySelector(".price")?.textContent), ["$0.0500", "$2.00"]);
  assert.equal(rows[1]?.querySelector(".fdv")?.textContent, "$200");
  await send(11, "3", 550);
  assert.equal(rows[1]?.querySelector(".price")?.textContent, "$2.00");
  await send(10, "3", 650);
  assert.equal(rows[1]?.querySelector(".price")?.textContent, "$2.00");
  await renderRows(12);
  assert.equal(rows[1]?.querySelector(".price")?.textContent, "$0.0100");
  await send(12, "4", 700);
  assert.equal(rows[1]?.querySelector(".price")?.textContent, "$4.00");
  assert.ok(animations.all.length > 0);
  assert.ok(animations.all.every(animation => rows[1]?.querySelector(".price")?.contains(animation.target)),
    "Only the changing price pulses on an older snapshot without supply inputs");
  await send(13, "0.0000839", 710);
  assert.equal(rows[1]?.querySelector(".price")?.textContent, "$0.0₄839");
  await send(14, "0.000084", 720);
  assert.equal(rows[1]?.querySelector(".price")?.textContent, "$0.0₄840");
  assert.equal(streams.length, 1);
});

function render(value: HomeCoin, loading = false, nowMs = 1, window: HomeWindow = "24h") {
  const client = new QueryClient();
  try {
    return new JSDOM(renderToStaticMarkup(<AppRouterContext value={router}><QueryProvider client={client}>
      <CoinCard coin={value} marketLoading={loading} window={window} nowMs={nowMs} trading />
    </QueryProvider></AppRouterContext>));
  } finally { client.clear(); }
}

test("Home distinguishes first-observation changes from full 24-hour changes and missing prices", () => {
  const launched = Date.UTC(2026, 10, 20, 12);
  const quoted = { ...coin, launched_ms: launched, price_usd: "1" };
  const young = render({ ...quoted, change_24h_bps: 1000, change_24h_from_ms: launched }, false, launched + 23 * 3_600_000);
  const mature = render(quoted, false, launched + 24 * 3_600_000);
  const flat = render({ ...quoted, change_24h_bps: 0 });
  const down = render({ ...quoted, change_24h_bps: -7739 });
  try {
    assert.equal(young.window.document.querySelector(".price")?.textContent, "$1.00");
    const shortChange = young.window.document.querySelector(".desktopChange");
    assert.match(shortChange?.getAttribute("title") ?? "", /first priced observation at Fri, 20 Nov 2026 12:00:00 GMT/);
    assert.match(shortChange?.textContent ?? "", /\+10%$/);
    for (const kind of [".desktopChange", ".mobileChange"]) {
      assert.equal(young.window.document.querySelector(`${kind} [aria-hidden="true"]`)?.textContent?.trim(), "≤24h");
    }
    assert.equal(mature.window.document.querySelector(".change"), null);
    assert.equal(flat.window.document.querySelector(".change.up")?.textContent, "+0%");
    assert.equal(flat.window.document.querySelector(".desktopChange")?.getAttribute("title"), null);
    assert.equal(down.window.document.querySelector(".change.down")?.textContent, "−77.39%");
  } finally {
    young.window.close();
    mature.window.close();
    flat.window.close();
    down.window.close();
  }
});

test("Home market activity skips stale or undated moves", () => {
  const nowMs = Date.UTC(2026, 10, 20, 12);
  const fresh = { ...coin, price_usd: "1", price_as_of_ms: nowMs, change_24h_bps: 300 };
  const stale = { ...fresh, symbol: "STALE", price_as_of_ms: nowMs - 120_001, change_24h_bps: -5000 };
  const undated = { ...fresh, symbol: "UNDATED", price_as_of_ms: null, change_24h_bps: 8000 };
  const client = new QueryClient();
  const strip = new JSDOM(renderToStaticMarkup(<AppRouterContext value={router}><QueryProvider client={client}>
    <HomeMarketActivity coins={[stale, undated, fresh]} move={null} nowMs={nowMs} window="24h" />
  </QueryProvider></AppRouterContext>));
  try {
    const link = strip.window.document.querySelector("[data-market-activity] a");
    assert.equal(link?.getAttribute("aria-label"), "$TEST up 3% in 24h");
    assert.match(link?.textContent ?? "", /Market activity.*TEST/);
  } finally {
    strip.window.close();
    client.clear();
  }
});

test("Home shows the same FDV in desktop and mobile rows", () => {
  const dom = render({ ...coin, fdv_usd: "12000", mobile_market: { market_cap_usd: "7000", change_1h_bps: null } });
  try {
    assert.equal(dom.window.document.querySelector(".fdv")?.textContent, "$12K");
    assert.equal(dom.window.document.querySelector(".mobileFdv")?.textContent, "FDV$12K");
  } finally {
    dom.window.close();
  }
});

test("the selected change window determines which percentage appears", () => {
  const quoted = { ...coin, price_usd: "1", change_24h_bps: -3200, mobile_market: { market_cap_usd: null, change_1h_bps: 1200 } };
  for (const [window, value, expected] of [
    ["1h", quoted, "+12%"],
    ["24h", quoted, "−32%"],
    ["1h", { ...quoted, mobile_market: { ...quoted.mobile_market, change_1h_bps: null } }, undefined],
  ] as const) {
    const dom = render(value, false, 1, window);
    try {
      assert.equal(dom.window.document.querySelector(".desktopChange")?.textContent, expected);
      assert.equal(dom.window.document.querySelector(".mobileChange")?.textContent, expected === undefined
        ? undefined
        : `${window === "1h" ? "1-hour" : "24-hour"} price change ${window}${expected}`);
    } finally {
      dom.window.close();
    }
  }
});

test("Home volume distinguishes partial USD, unknown USD and confirmed zero in the row", () => {
  const zero = { usd: "0", usd_complete: true };
  const unpriced = { usd: null, usd_complete: false };
  const cetus = { usd: "0.043878733", usd_complete: true };
  const trade = { quote_type: coin.quote.type, quote_symbol: coin.quote.symbol, quote_decimals: 9, atoms: "1234000000", usd: "1234.00", usd_complete: false };
  const tracked = { ...coin.activity, bought: [trade] };
  const followed = { ...tracked, scope: "followed" as const };
  for (const [volume, activity, text, label] of [
    [{ ...cetus, usd_complete: true, venues: { cetus, bluefin: zero } }, coin.activity, "$0.0439", "24h volume: $0.0439"],
    [{ ...cetus, usd_complete: false, venues: { cetus, bluefin: unpriced } }, coin.activity, "$0.0439+", "24h volume: $0.0439 (partial)"],
    [{ ...unpriced, venues: { cetus: zero, bluefin: unpriced } }, coin.activity, "—", "24h volume unavailable"],
    [{ ...zero, venues: { cetus: zero, bluefin: zero } }, coin.activity, "$0", "24h volume: $0"],
    [undefined, coin.activity, "—", "24h volume unavailable"],
    [undefined, tracked, "$1.2K+", "24h volume: $1.2K (partial, tracked trades)"],
    [undefined, followed, "$1.2K+", "24h volume: $1.2K (partial, followed trades)"],
    [undefined, { ...followed, bought: [{ ...trade, usd_complete: true }] }, "$1.2K", "24h volume: $1.2K (followed trades)"],
    [undefined, { ...tracked, bought: [{ ...trade, usd: null }] }, "—", "24h volume unavailable"],
  ] satisfies readonly [HomeCoin["dex_volume"], HomeCoin["activity"], string, string][]) {
    const dom = render({ ...coin, dex_volume: volume, activity });
    try {
      const volumeCell = dom.window.document.querySelector(".vol");
      assert.equal(volumeCell?.querySelector('[aria-hidden="true"]')?.textContent, text);
      const spoken = volumeCell?.querySelector(".sr-only")?.textContent;
      assert.equal(spoken, label);
      assert.ok(spoken.split(/\s+/).length <= 6);
    } finally {
      dom.window.close();
    }
  }
});

test("unavailable prices stay visually blank, pending reads show a status, and actual zero stays visible", () => {
  for (const loading of [false, true]) {
    const dom = render(coin, loading);
    const { document } = dom.window;
    try {
      const price = document.querySelector(".price");
      const fdv = document.querySelector(".fdv");
      assert.equal(price?.querySelector('[aria-label="Loading Price"]') != null, loading);
      assert.equal(fdv?.querySelector('[aria-label="Loading FDV"]') != null, loading);
      if (!loading) {
        assert.equal(price, null, "missing price omits its complete group");
        assert.equal(fdv, null, "missing FDV omits its label and wrapper");
        assert.equal(document.querySelector(".top, .age"), null);
      }
      assert.equal(price?.textContent ?? "", "", "missing price never becomes a dash or a zero");
    } finally { dom.window.close(); }
  }
  const dom = render({ ...coin, price_usd: "0", fdv_usd: "0", top_holders: { holders: [], share_bps: 0 } }, true);
  try {
    const { document } = dom.window;
    assert.equal(document.querySelector(".price")?.textContent, "$0.00");
    assert.equal(document.querySelector(".fdv")?.textContent, "$0");
    assert.equal(document.querySelector(".top")?.textContent, "0%");
    assert.equal(document.querySelectorAll('[role="status"]').length, 0, "refreshing must not replace observed zero with a loader");
  } finally { dom.window.close(); }
});

test("#588: a scheduled sale shows its opening time until the sale opens", () => {
  const start = 10_000_000;
  const sale: HomeCoin = {
    ...coin, presale_id: "0xsale", lifecycle: "open", tradable: false,
    sale: { start_ms: start, end_ms: start + 3 * 86_400_000, raise_target: "1000000000000", raised: "0", participants: 0 },
  };
  const renderAt = (nowMs: number) => render(sale, false, nowMs);
  const before = renderAt(start - 39 * 60_000);
  try {
    const { document } = before.window;
    assert.equal(document.querySelector(".saleStatus .status")?.textContent, "upcoming");
    assert.equal(document.querySelector(".saleStatus .status")?.getAttribute("data-tone"), "pending");
    assert.equal(document.querySelector(".closes")?.textContent, "Opens39m");
    assert.equal(document.querySelector("a")?.getAttribute("href"), "/presale/0xsale");
  } finally { before.window.close(); }
  const after = renderAt(start);
  try {
    const { document } = after.window;
    assert.equal(document.querySelector(".saleStatus .status")?.textContent, "open");
    assert.match(document.querySelector(".closes")!.textContent!, /^Closes3d/);
  } finally { after.window.close(); }
});

test("a Home coin links directly to its page and offers Buy as a separate action", () => {
  const dom = render(coin);
  try {
    const { document } = dom.window;
    const link = document.querySelector("a");
    const buy = document.querySelector('button[aria-label="Buy TEST"]');
    assert.equal(link?.getAttribute("href"), "/coin/0x1%3A%3Afixture%3A%3ATEST");
    assert.equal(link?.getAttribute("aria-label"), `Open ${coin.name} (TEST)`);
    assert.equal(link?.contains(buy), false);
    assert.equal(buy?.getAttribute("aria-haspopup"), "dialog");
    assert.equal(document.querySelector('button[aria-expanded]'), null);
  } finally { dom.window.close(); }

  const unavailable = render({ ...coin, tradable: false });
  try {
    assert.equal(unavailable.window.document.querySelector('button[aria-label="Buy TEST"]'), null);
  } finally { unavailable.window.close(); }
});

test("a newer Home price revalues each supply independently, preserves missing values and updates the observed spark tip", async () => {
  const { coinAtPrice, sparkAtPrice } = await import("./live-market");
  const base: HomeCoin = { ...coin, price_usd: "1", price_as_of_ms: 500, fdv_usd: "100.00",
    change_24h_bps: 0, mobile_market: { market_cap_usd: "45.00", change_1h_bps: 0 },
    live_inputs: { total_supply: "100000000000", circulating_supply: "45000000000", open_1h_usd: "0.5",
      open_24h_usd: "1", baselines_until_ms: 1000 } };
  const tick = { coin_type: base.coin_type, usd_price: "2", as_of_ms: 600 };
  const next = coinAtPrice(base, tick);
  assert.equal(next.fdv_usd, "200.00");
  assert.equal(next.change_24h_bps, 10_000);
  assert.deepEqual(next.mobile_market, { market_cap_usd: "90.00", change_1h_bps: 30_000 });
  assert.equal(coinAtPrice(base, { ...tick, as_of_ms: 400 }), base);
  assert.equal(coinAtPrice(base, { ...tick, as_of_ms: 1000 }).change_24h_bps, 0);
  const rolling = { ...base, live_inputs: { ...base.live_inputs!, open_24h_until_ms: 600 } };
  const expiredDay = coinAtPrice(rolling, tick);
  assert.equal(expiredDay.change_24h_bps, 0);
  assert.equal(expiredDay.mobile_market?.change_1h_bps, 30_000);
  const unknown = coinAtPrice({ ...base, live_inputs: { ...base.live_inputs!, circulating_supply: null } }, tick);
  assert.equal(unknown.mobile_market?.market_cap_usd, null);
  const history = [[100, 0.5], [500, 1]] as const;
  assert.deepEqual(sparkAtPrice(history, next.price_as_of_ms, next.price_usd), [...history, [600, 2]]);
  assert.deepEqual(sparkAtPrice(history, 500, "2"), [[100, 0.5], [500, 2]]);
  assert.equal(sparkAtPrice(history, 499, "2"), history);
  assert.equal(sparkAtPrice(null, 600, "2"), null);
});
