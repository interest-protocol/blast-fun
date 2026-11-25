import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { QueryProvider } from "#web/lib/query/provider.tsx";
import type { HomeCoin, HomeWindow } from "@blast/core/modules/social/contracts/home.ts";
import { CoinCard } from "./CoinCard";
import type { HomeBuyCue } from "./home-model";
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

test("streamed prices revalue the existing row's market cap without reordering it", async (t) => {
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
  // The live socket is off: the ticket answers 204 and the tab uses the SSE relay.
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
    client.clear();
    if (original) Object.defineProperty(globalThis, "EventSource", original);
    else Reflect.deleteProperty(globalThis, "EventSource");
  });

  const type = (id: string) => `0x${id.repeat(64)}::coin::COIN`;
  // A million whole coins in circulation: market cap = price × 1M.
  const supply = { total_supply: "1000000000000000", circulating_supply: "1000000000000000", open_1h_usd: null, open_24h_usd: null, baselines_until_ms: 1000 };
  const coins = [
    { ...coin, coin_type: type("1"), price_usd: "0.05", price_as_of_ms: 500, mobile_market: { market_cap_usd: "50000", change_1h_bps: null }, live_inputs: supply },
    { ...coin, coin_type: type("2"), price_usd: "0.01", price_as_of_ms: 500, mobile_market: { market_cap_usd: "10000", change_1h_bps: null }, live_inputs: supply },
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
  assert.equal(host.querySelector(".hMcap")?.textContent, "MCap");
  assert.equal(host.querySelector('[aria-label="Refresh market prices"]'), null);
  const rows = [...host.querySelectorAll("[data-list-row]")];
  const mcap = (row = 1) => rows[row]?.querySelector('[data-slot="coin-mcap"]')?.textContent;
  await act(async () => {});
  assert.equal(streams.length, 1);
  const stream = streams[0]!;
  assert.deepEqual(new URL(stream.url, "https://blast.test").searchParams.getAll("price_coin"), coins.map((row) => row.coin_type));
  const send = (checkpoint: number, price: string, asOf: number) => act(() => {
    stream.dispatchEvent(new dom.window.MessageEvent("prices", { data: JSON.stringify({ checkpoint, prices: [
      { coin_type: type("2"), usd_price: price, as_of_ms: asOf },
    ] }) }));
  });
  await send(11, "0.9", 500);
  assert.equal(mcap(), "$10K", "HTTP wins timestamp ties across different checkpoints");
  const stamped = (priceCheckpoint: number) => coins.map(row => ({ ...row, live_inputs: { ...supply, price_checkpoint: priceCheckpoint } }));
  await renderRows(10, stamped(11));
  assert.equal(mcap(), "$10K", "HTTP wins on the same market checkpoint");
  await renderRows(10, stamped(10));
  assert.equal(mcap(), "$900K", "a later committed market checkpoint corrects the same price timestamp");
  await renderRows(10);
  await send(11, "2", 600);
  assert.deepEqual([...host.querySelectorAll("[data-list-row]")], rows);
  assert.deepEqual([mcap(0), mcap()], ["$50K", "$2M"]);
  await send(11, "3", 550);
  assert.equal(mcap(), "$2M");
  await send(10, "3", 650);
  assert.equal(mcap(), "$2M");
  await renderRows(12);
  assert.equal(mcap(), "$10K");
  await send(12, "4", 700);
  assert.equal(mcap(), "$4M");
  assert.ok(animations.all.length > 0);
  assert.ok(animations.all.every(animation => rows[1]?.querySelector(".mcap")?.contains(animation.target)),
    "only the changing market cap pulses");
  assert.equal(streams.length, 1);
});

function render(value: HomeCoin, loading = false, nowMs = 1, window: HomeWindow = "24h", buy?: HomeBuyCue) {
  const client = new QueryClient();
  try {
    return new JSDOM(renderToStaticMarkup(<AppRouterContext value={router}><QueryProvider client={client}>
      <CoinCard buy={buy} coin={value} marketLoading={loading} window={window} nowMs={nowMs} trading />
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
    const change = young.window.document.querySelector(".change");
    assert.match(change?.getAttribute("title") ?? "", /first price on Nov 20, 12:00 UTC/);
    assert.match(change?.textContent ?? "", /\+10%$/);
    assert.equal(change?.querySelector('[aria-hidden="true"]')?.textContent?.trim(), "≤24h");
    assert.equal(mature.window.document.querySelector(".change")?.textContent, "—Price change unknown");
    assert.equal(flat.window.document.querySelector(".change")?.textContent, "0%");
    assert.equal(flat.window.document.querySelector(".change")?.getAttribute("title"), null);
    assert.equal(down.window.document.querySelector(".change")?.textContent, "−77.39%");
  } finally {
    young.window.close();
    mature.window.close();
    flat.window.close();
    down.window.close();
  }

  const unavailable = render({ ...coin, tradable: false });
  try {
    assert.equal(unavailable.window.document.querySelector('button[aria-label="Buy TEST"]'), null);
  } finally { unavailable.window.close(); }
});

test("the selected change window determines which percentage appears", () => {
  const quoted = { ...coin, price_usd: "1", change_24h_bps: -3200, mobile_market: { market_cap_usd: null, change_1h_bps: 1200 } };
  for (const [window, value, expected] of [
    ["1h", quoted, "+12%"],
    ["24h", quoted, "−32%"],
    ["1h", { ...quoted, mobile_market: { ...quoted.mobile_market, change_1h_bps: null } }, "—Price change unknown"],
  ] as const) {
    const dom = render(value, false, 1, window);
    try {
      assert.equal(dom.window.document.querySelector(".change")?.textContent, expected);
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

test("an unknown market cap or holder count reads as a dash, a pending read shows a status, and zero stays visible", () => {
  for (const loading of [false, true]) {
    const dom = render(coin, loading);
    const { document } = dom.window;
    try {
      const mcap = document.querySelector(".mcap");
      assert.equal(mcap?.querySelector('[aria-label="Loading market cap"]') != null, loading);
      if (!loading) assert.equal(mcap?.textContent, "—Market cap unknown");
      assert.equal(document.querySelector(".holders")?.textContent, "—Holders unknown");
    } finally { dom.window.close(); }
  }
  const dom = render({ ...coin, holders: 0, mobile_market: { market_cap_usd: "0", change_1h_bps: null } }, true);
  try {
    const { document } = dom.window;
    assert.equal(document.querySelector(".mcap")?.textContent, "$0");
    assert.equal(document.querySelector(".holders")?.textContent, "0");
    assert.equal(document.querySelectorAll('[role="status"]').length, 0, "refreshing must not replace observed zero with a loader");
  } finally { dom.window.close(); }
});

test("the age follows the name and the top 10's share sits under the holders, each only when known", () => {
  const now = Date.UTC(2026, 10, 25, 12);
  const known = render({ ...coin, holders: 412, launched_ms: now - 2 * 3_600_000, top_holders: { holders: [], share_bps: 3800 } }, false, now);
  try {
    const { document } = known.window;
    assert.equal(document.querySelector(".coinMeta")?.textContent, "A long fixture token name·Age 2h");
    assert.equal(document.querySelector(".holders")?.textContent, "412top 10 · 38%, top 10 hold 38%");
  } finally { known.window.close(); }
  const unknown = render({ ...coin, holders: 412 }, false, now);
  try {
    const { document } = unknown.window;
    assert.equal(document.querySelector(".coinMeta")?.textContent, "A long fixture token name");
    assert.equal(document.querySelector(".holders")?.textContent, "412");
  } finally { unknown.window.close(); }
  // A name that only repeats the ticker leaves the age alone; an unknown holder count drops the share with it.
  const bare = render({ ...coin, name: "test", launched_ms: now - 2 * 3_600_000, top_holders: { holders: [], share_bps: 3800 } }, false, now);
  try {
    const { document } = bare.window;
    assert.equal(document.querySelector(".coinMeta")?.textContent, "Age 2h");
    assert.equal(document.querySelector(".holders")?.textContent, "—Holders unknown");
  } finally { bare.window.close(); }
});

test("the Status cell names where each coin is in its life", () => {
  const day = 86_400_000;
  const now = 10 * day;
  const status = (value: HomeCoin, nowMs = now) => {
    const dom = render(value, false, nowMs);
    try {
      const cell = dom.window.document.querySelector(".status");
      // The line as seen; a spoken label, when the line drops the bar's figure, follows it.
      const spoken = cell?.querySelector(".sr-only")?.textContent;
      return [cell?.textContent?.replace(spoken ?? "\u0000", ""), cell?.querySelector("progress")?.getAttribute("value") ?? null, ...(spoken ? [spoken] : [])];
    } finally { dom.window.close(); }
  };
  const curve = (lifecycle: NonNullable<HomeCoin["curve"]>["lifecycle"], progress_bps: number | null) => ({
    ...coin, launch_id: "0xlaunch", lifecycle: "open" as const, venue: "blast_curve", curve: { lifecycle, progress_bps, quote_remaining: "310000000000" },
  });
  assert.deepEqual(status(curve("live", 7250)), ["72% · 310 SUI to go", "72"]);
  assert.deepEqual(status({ ...curve("migrated", 10_000), lifecycle: "migrated", graduated_ms: now - 3 * day }), ["Graduated 3d ago", null]);
  assert.deepEqual(status({ ...coin, presale_id: "0xsale", launched_ms: now - 3 * day }), ["Listed 3d ago", null]);
  // A coin with no Blast history: the venue alone, by name for assistive technology.
  assert.match(status(coin)[0] ?? "", /Cetus/);
  // The server sends `curve: null` for every coin that never had a curve.
  assert.match(status({ ...coin, curve: null })[0] ?? "", /Cetus/);

  // #588: a scheduled sale shows its opening time until the sale opens.
  const start = 10_000_000;
  const sale: HomeCoin = {
    ...coin, presale_id: "0xsale", lifecycle: "open", tradable: false,
    sale: { start_ms: start, end_ms: start + 3 * day, raise_target: "1000000000000", raised: "0", participants: 0 },
  };
  assert.deepEqual(status(sale, start - 39 * 60_000), ["Opens in 39m", null]);
  assert.deepEqual(status(sale, start), ["Live · ends in 3d", "0", "Live · ends in 3d · 0% filled"]);
  const before = render(sale, false, start);
  try {
    assert.equal(before.window.document.querySelector("a")?.getAttribute("href"), "/presale/0xsale");
  } finally { before.window.close(); }
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

test("a newer Home price revalues each supply independently and preserves missing values", async () => {
  const { coinAtPrice } = await import("./live-market");
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
});

// Fails if a buy's figure is missing, or a large one lands as quietly as a small one.
test("a buy shows its figure, sized by the buy", () => {
  const cue = (buy?: HomeBuyCue) => {
    const dom = render(coin, false, 1, "24h", buy);
    try {
      const figure = dom.window.document.querySelector("[data-home-buy]");
      return [figure?.textContent, figure?.getAttribute("data-home-buy")];
    } finally { dom.window.close(); }
  };
  assert.deepEqual(cue(), [undefined, undefined]);
  assert.deepEqual(cue({ text: "+$13", tier: "small" }), ["+$13", "small"]);
  assert.deepEqual(cue({ text: "+$420", tier: "big" }), ["+$420", "big"]);
  assert.deepEqual(cue({ text: "+$1.2K", tier: "huge" }), ["+$1.2K", "huge"]);
});
