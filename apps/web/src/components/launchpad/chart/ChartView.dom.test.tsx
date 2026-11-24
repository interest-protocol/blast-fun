import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { installTestDom, recordAnimations } from "../../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./TradingViewChart" && context.parentURL?.endsWith("/charts/PoolCandleChart.tsx")) return {
    shortCircuit: true,
    url: `data:text/javascript,${encodeURIComponent(`import React from ${JSON.stringify(import.meta.resolve("react"))}; export const VOLUME_SCALE = 'volume'; export const MIGRATION_LABEL_ROOM_PX = 72; export function TradingViewChart({series, priceFormatter, onProject, projectionKey, latestPrice}) {
      React.useLayoutEffect(() => {
        let settled = false;
        const handle = {
          chart: {
            timeScale: () => ({ getVisibleLogicalRange: () => ({from: 0, to: 12}), options: () => ({ barSpacing: 8 }), timeToCoordinate: time => time === series[0]?.data.at(-1)?.time ? Number((settled ? undefined : document.documentElement.dataset.testSyncCandleX) ?? document.documentElement.dataset.testCandleX ?? 83) : null, width: () => 100 }),
            panes: () => series.some(s => s.pane === 1) ? [{}, {}] : [{}],
            paneSize: () => ({ width: 100, height: 140 })
          },
          series: series.map(s => ({ priceToCoordinate: price => price === (s.data.at(-1)?.close ?? s.data.at(-1)?.value) ? 40 : null }))
        };
        onProject(handle, false);
        if (document.documentElement.dataset.testProjectionSettled !== "false") {
          let mounted = true;
          queueMicrotask(() => { if (mounted) { settled = true; onProject(handle, true); } });
          return () => { mounted = false; };
        }
      }, [series, projectionKey]);
      return React.createElement('div', {'data-latest-series': latestPrice?.seriesIndex, 'data-series': series.map(s=>s.type).join(','), 'data-tags': series.map(s=>String(s.options?.lastValueVisible)).join(','), 'data-points': series[0]?.data.map(p => p.time + ':' + priceFormatter(p.value ?? p.close)).join(',')}); }`)}`,
  };
  return next(specifier, context);
} });
const { chartRequest } = await import("./chart-model.ts");
const { ChartTradeContext } = await import("./chart-trade-context.ts");
const { WalletTradesProvider, usePublishWalletTrades } = await import("../activity/wallet-trades.tsx");
const { ChartView } = await import("./ChartView.tsx");
hook.deregister();

test("an open chart keeps its initial saved controls until it is mounted again", async () => {
  const { useChartPreference } = await import("./chart-preferences.ts");
  const key = "blast.coin-chart.controls";
  function Probe({ render }: { render: number }) {
    return <output>{useChartPreference("controls")} / {render}</output>;
  }
  const node = dom.document.createElement("div");
  dom.document.body.append(node);
  const root = createRoot(node);
  try {
    dom.window.localStorage.setItem(key, "?range=all");
    await act(async () => root.render(<Probe key="open" render={1} />));
    dom.window.localStorage.setItem(key, "?range=24h");
    await act(async () => root.render(<Probe key="open" render={2} />));
    assert.equal(node.textContent, "?range=all / 2");
    await act(async () => root.render(<Probe key="fresh" render={3} />));
    assert.equal(node.textContent, "?range=24h / 3");
  } finally {
    await act(async () => root.unmount());
    dom.window.localStorage.removeItem(key);
    node.remove();
  }
});

test("changing the interval leaves an untouched range at its coin default", async () => {
  const { preferredChartControls, saveChartControls } = await import("./chart-preferences.ts");
  const key = "blast.coin-chart.controls";
  try {
    saveChartControls({ interval: "5m", range: "all" }, { interval: "15m", range: "all" });
    const saved = dom.window.localStorage.getItem(key) ?? "";
    assert.equal(saved, "interval=15m");
    assert.deepEqual(preferredChartControls(saved, "", { interval: "5m", range: "24h" }), {
      interval: "15m",
      range: "24h",
    });
  } finally {
    dom.window.localStorage.removeItem(key);
  }
});

test("reopening a Live link preserves the saved history interval when leaving Live", async (t) => {
  const { useCoinChartControls } = await import("./chart-preferences.ts");
  const key = "blast.coin-chart.controls";
  const original = window.location.href;
  const node = dom.document.createElement("div");
  dom.document.body.append(node);
  const root = createRoot(node);
  t.after(async () => {
    await act(async () => root.unmount());
    node.remove();
    window.localStorage.removeItem(key);
    window.history.replaceState(null, "", original);
  });
  window.localStorage.setItem(key, "interval=15m&range=7d");
  window.history.replaceState(null, "", "?range=live&interval=1s");
  function Probe() {
    const { controls, commit } = useCoinChartControls(true, { range: "live", interval: "1s" });
    return <button onClick={() => commit({ ...controls, range: "1h" })}>{controls.range} / {controls.interval}</button>;
  }
  await act(async () => root.render(<Probe />));
  assert.equal(node.textContent, "live / 1s");
  await act(async () => node.querySelector("button")?.click());
  assert.equal(node.textContent, "1h / 15m");
  assert.equal(window.location.search, "?range=1h&interval=15m");
  assert.equal(window.localStorage.getItem(key), "interval=15m&range=1h");
});

test("compact style controls update a single plot and show trades on its live candle", async t => {
  const poolKey = "blast_curve:0x1";
  const venuePoolKey = `bluefin:0x${"a7".repeat(32)}`;
  const page = { poolKey, source: "curve" as const, venue: "blast_curve" as const, interval: "1m" as const, migration: null, candles: [{ bucketStart: 1_790_337_600_000, open: "1", high: "2", low: "1", close: "2", volumeQuote: 20n, volumeMeme: 10n, volumeUsd: null, buys: 1, sells: 0, trades: 1 }] };
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  try {
    const controls = { interval: "1m", range: "all" } as const;
    const buy = { cursor: "1:0:1:0", side: "buy" as const, timestampMs: 1_790_337_600_000, price: "2", memeAmount: 9_631_238_640_097n, quoteAmount: 100_000_000n };
    const actor = `0x${"11".repeat(32)}`;
    const walletRows: readonly ActivityRow[] = [{
      kind: "curve_sell", source: "user", actor, lifecycle: null,
      labels: ["whale"], position: "2:0:2:0", checkpoint: 1, digest: "trade",
      timestampMs: 1_790_337_621_000, amounts: { quote: 20n, meme: 10n },
    }];
    function Tape() {
      usePublishWalletTrades(walletRows);
      return null;
    }
    const receipts = new Map<string, number>();
    const receivedAt = (cursor: string) => {
      if (!receipts.has(cursor)) receipts.set(cursor, performance.now());
      return receipts.get(cursor)!;
    };
    const render = (hidden: readonly "curve"[], trade: Omit<typeof buy, "side"> & { side: "buy" | "sell" } = buy, market = poolKey, close = "2", empty = false) => act(async () => root.render(
      <WalletTradesProvider deployer={actor}><Tape /><ChartTradeContext value={{ trade, poolKey: market, receivedAt: receivedAt(trade.cursor), decimals: 9, symbol: "SUI" }}>
      <ChartView
        compact
        source={{ expected: null, curvePoolKey: poolKey, venuePoolKey, migration: null, symbol: "PIP", quoteSymbol: "SUI", memeDecimals: 9, quoteDecimals: 9, opening: { timestampMs: 1_790_337_617_000, price: "0.5" } }}
        quoteUsd="0.70"
        state={{
          key: "1m|all",
          curve: { state: "available", data: { ...page, candles: empty ? [] : page.candles.map(c => ({ ...c, close })) }, provenance: { source: "blast-infra", network: "localnet", deployment: "fixture", checkpoint: 1, timestampMs: 1_790_337_631_000, observedAt: 1_790_337_631_000, lagMs: 0 } },
          venue: { state: "loading" },
          migration: null,
        }}
        controls={controls}
        request={chartRequest(controls, 1_790_337_660_000)}
        hidden={hidden}
        updates={null}
        pending={false}
        onControls={() => {}}
        onToggle={() => {}}
        onRefresh={() => {}}
      /></ChartTradeContext></WalletTradesProvider>,
    ));
    await render([], buy, poolKey, "2", true);
    const cue = container.querySelector("[data-trade-cue]");
    assert.equal(cue?.textContent, "Buy · 0.1\u00a0SUI", "an observed trade remains readable without plotted geometry");
    assert.equal(container.querySelector("[data-series]"), null);
    await render([]);
    assert.equal(container.querySelector("[data-trade-cue]"), cue, "showing the plot retains the original cue");
    assert.ok(container.querySelector("[data-chart-last-trade]")?.nextElementSibling?.querySelector("[data-series]"), "the readout sits immediately above the real chart figure");
    const plot = () => container.querySelector("[data-series]")!;
    const button = (name: string) => [...container.querySelectorAll("button")].find(b => b.textContent === name)!;
    const sellBadge = () => container.querySelector<HTMLElement>('[data-coin-plot] [data-side="sell"] [title]');
    const sellIcons = () => [...sellBadge()!.querySelectorAll("[data-wallet-label]")].map(icon => icon.getAttribute("data-wallet-label"));
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    const originalPlot = plot();
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    assert.equal(dom.window.localStorage.getItem("blast.coin-chart.wallet-tags"), "hidden");
    assert.equal(sellBadge(), null);
    assert.equal(container.querySelector("[data-wallet-label]"), null);
    assert.equal(plot(), originalPlot);
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    assert.equal(sellBadge()?.textContent, "↓");
    assert.equal(sellBadge()?.getAttribute("aria-label"), "Open seller wallet 0x1111…1111");
    assert.deepEqual(sellIcons(), ["deployer", "whale"]);
    assert.ok(parseFloat(sellBadge()!.style.top) + 24 <= 40, "the sell badge is above the actual wick inside the price plot");
    const dot = container.querySelector('[data-coin-plot] [data-side="sell"] circle');
    assert.equal(dot?.getAttribute("cy"), "40");
    assert.equal(dot?.getAttribute("cx"), "83");
    assert.equal(dot?.getAttribute("r"), "3.7");
    assert.equal(container.querySelector("[data-wallet-ripple]"), null, "historical dots are static");
    assert.equal(container.querySelector('[data-coin-plot] [data-side="sell"] line'), null);
    assert.equal(plot().getAttribute("data-series"), "Candlestick,Histogram");
    assert.equal(button("Candles & volume").getAttribute("aria-pressed"), "true");
    assert.equal(button("Candles & volume").nextElementSibling, button("Line chart"));
    await act(async () => button("Line chart").click());
    assert.deepEqual(sellIcons(), ["deployer", "whale"], "the line marker follows the shifted first line point");
    assert.equal(plot().getAttribute("data-series"), "Area");
    assert.match(plot().getAttribute("data-points") ?? "", /^1790337617:\$0\.35,1790337631:\$1\.4$/, "the curve starts at its opening price before the first close");
    await act(async () => button("Candles & volume").click());
    assert.equal(plot().getAttribute("data-series"), "Candlestick,Histogram");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let now = 1000;
    t.mock.method(performance, "now", () => now);
    const advance = async (ms: number) => {
      now += ms;
      await act(async () => t.mock.timers.tick(ms));
    };
    const { all: animations } = recordAnimations();
    const ripples = () => animations.filter(animation => animation.target.hasAttribute("data-wallet-ripple"));
    const amount = () => container.querySelector<HTMLElement>("[data-candle-trade-amount]");
    assert.equal(amount(), null, "switching into candles does not replay the retained trade");
    await render([], { ...buy, cursor: "2:0:1:0" });
    const label = amount();
    assert.equal(label?.textContent, "+9.63K");
    assert.equal(label?.parentElement?.style.left, "79px", "the label clears the full candle body");
    assert.equal(label?.parentElement?.style.top, "40px", "the actual scaled close was passed to the drawn series");
    assert.equal(ripples().length, 0, "an untagged trade does not ripple another dot");
    await render([], { ...buy, cursor: "2:0:2:0", side: "sell", memeAmount: 1_000_000_000n });
    assert.equal(amount(), label, "burst trades share one label");
    assert.equal(amount()?.textContent, "−1");
    assert.equal(ripples().length, 1);
    const pulse = ripples()[0]!;
    assert.equal(pulse.target.getAttribute("cx"), dot?.getAttribute("cx"));
    assert.equal(pulse.target.getAttribute("cy"), dot?.getAttribute("cy"));
    assert.equal(pulse.timing.duration, 280);
    await advance(800);
    await render([], { ...buy, cursor: "2:0:2:0", side: "sell", memeAmount: 1_000_000_000n });
    assert.equal(ripples().length, 1, "a retained and reprojected trade cannot replay the ring");
    await advance(650);
    assert.ok(amount()?.hasAttribute("data-leaving"), "a duplicate cannot renew the hold");
    await advance(100);
    await render([], { ...buy, cursor: "2:0:2:1" });
    assert.equal(amount(), label, "a trade during the fade reuses the label");
    assert.equal(amount()?.textContent, "+9.63K");
    assert.equal(amount()?.hasAttribute("data-leaving"), false, "an interrupted exit ends immediately");
    await advance(1449);
    assert.equal(amount()?.hasAttribute("data-leaving"), false, "the replacement gets its full hold");
    await advance(201);
    assert.equal(amount(), null, "the label is gone when the market stays quiet");
    await render([], { ...buy, cursor: "2:0:3:0", price: "4" });
    assert.equal(amount(), null, "an unmatched candle cannot carry the trade");
    await render([], { ...buy, cursor: "2:0:4:0" }, venuePoolKey);
    assert.equal(amount(), null, "a venue trade cannot mark the curve");
    const delayed = { ...buy, cursor: "2:0:5:0" };
    await render([], delayed, poolKey, "1");
    await advance(850);
    assert.equal(amount(), null);
    await render([], delayed);
    assert.equal(amount()?.textContent, "+9.63K");
    await advance(1449);
    assert.equal(amount()?.hasAttribute("data-leaving"), false, "the full reading time starts after the candle matches");
    await advance(1);
    assert.ok(amount()?.hasAttribute("data-leaving"));
    await advance(200);
    assert.equal(amount(), null);

    dom.document.documentElement.dataset.testCandleX = "110";
    await render([], { ...buy, cursor: "2:0:6:0" });
    assert.equal(amount(), null);
    delete dom.document.documentElement.dataset.testCandleX;
    await render([], { ...buy, cursor: "2:0:6:0" });
    assert.equal(amount(), null, "panning back cannot replay an offscreen arrival");

    dom.document.documentElement.dataset.testProjectionSettled = "false";
    dom.document.documentElement.dataset.testCandleX = "110";
    const newBucket = { ...buy, cursor: "2:0:7:0" };
    await render([], newBucket);
    assert.equal(amount(), null, "the new candle has no visible location on the old scale");
    delete dom.document.documentElement.dataset.testProjectionSettled;
    delete dom.document.documentElement.dataset.testCandleX;
    await render([], newBucket);
    assert.equal(amount()?.textContent, "+9.63K", "settling the new bucket can place its first label");

    await advance(1650);
    dom.window.reducedMotion = true;
    dom.document.documentElement.dataset.testSyncCandleX = "110";
    await render([], { ...buy, cursor: "2:0:8:0" });
    assert.equal(amount()?.textContent, "+9.63K");
    assert.equal(amount()?.hasAttribute("data-leaving"), false, "reduced motion receives the trade at the first in-bounds native frame");
    delete dom.document.documentElement.dataset.testSyncCandleX;
    dom.window.reducedMotion = false;

    const stale = { ...buy, cursor: "2:0:9:0" };
    await render([], stale, poolKey, "1");
    await advance(2000);
    await render([], stale);
    assert.equal(amount(), null, "late matching history cannot revive an old receipt");
    assert.equal(container.querySelector('[aria-label="Bluefin pool candles"]'), null);
    assert.equal(container.querySelector('button[aria-label="Source details"]'), null);
    assert.doesNotMatch(container.textContent ?? "", new RegExp(venuePoolKey));
    assert.equal(container.querySelectorAll("[data-series]").length, 1);
    await act(async () => button("Line chart").click());
    assert.equal(plot().getAttribute("data-series"), "Area");
    await render([], { ...buy, cursor: "2:0:10:0" });
    assert.equal(amount()?.textContent, "+9.63K", "line charts cue the trade beside the latest price");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a migrated coin tags only the venue's last price, in both chart styles", async () => {
  dom.window.localStorage.clear();
  const migration = { cursor: "22:2:2:0", timestampMs: 1_790_337_660_000, curvePoolKey: "blast_curve:0x1", venuePoolKey: `cetus:0x${"c3".repeat(32)}` };
  const candle = (bucketStart: number, close: string) => ({ bucketStart, open: close, high: close, low: close, close, volumeQuote: 20n, volumeMeme: 10n, volumeUsd: null, buys: 1, sells: 0, trades: 1 });
  const provenance = { source: "blast-infra" as const, network: "localnet" as const, deployment: "fixture", checkpoint: 1, timestampMs: 1_790_337_800_000, observedAt: 1_790_337_800_000, lagMs: 0 };
  const curve = { poolKey: migration.curvePoolKey, source: "curve" as const, venue: "blast_curve" as const, interval: "1m" as const, migration, candles: [candle(1_790_337_600_000, "2")] };
  const venue = { poolKey: migration.venuePoolKey, source: "venue" as const, venue: "cetus" as const, interval: "1m" as const, migration, candles: [candle(1_790_337_720_000, "3")] };
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  try {
    const controls = { interval: "1m", range: "all" } as const;
    await act(async () => root.render(
      <ChartView
        compact
        source={{ expected: null, curvePoolKey: migration.curvePoolKey, venuePoolKey: migration.venuePoolKey, migration, symbol: "PIP", quoteSymbol: "SUI", memeDecimals: 9, quoteDecimals: 9 }}
        state={{ key: "1m|all", curve: { state: "available", data: curve, provenance }, venue: { state: "available", data: venue, provenance }, migration }}
        controls={controls}
        request={chartRequest(controls, 1_790_337_800_000)}
        hidden={[]}
        updates={null}
        pending={false}
        onControls={() => {}}
        onToggle={() => {}}
        onRefresh={() => {}}
      />,
    ));
    const plot = () => container.querySelector("[data-series]")!;
    const button = (name: string) => [...container.querySelectorAll("button")].find(b => b.textContent === name)!;
    assert.equal(plot().getAttribute("data-series"), "Candlestick,Candlestick,Histogram");
    assert.equal(plot().getAttribute("data-tags"), "false,false,false");
    assert.equal(plot().getAttribute("data-latest-series"), "1", "the neutral latest-price line belongs to the venue candles");
    await act(async () => button("Line chart").click());
    assert.equal(plot().getAttribute("data-series"), "Area,Area");
    assert.equal(plot().getAttribute("data-tags"), "false,false");
    assert.equal(plot().getAttribute("data-latest-series"), "1", "the neutral latest-price line belongs to the venue line");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Live ages out old candles during a quiet market", async (t) => {
  const start = 1_800_000_000_000;
  let now = start;
  t.mock.method(Date, "now", () => now);
  const poolKey = "blast_curve:0x1";
  const candle = (bucketStart: number, close: string) => ({
    bucketStart, open: close, high: close, low: close, close, volumeQuote: 20n, volumeMeme: 10n, volumeUsd: null, buys: 1, sells: 0, trades: 1,
  });
  const page = {
    poolKey, source: "curve" as const, venue: "blast_curve" as const, interval: "1s" as const, migration: null,
    candles: [candle(start - 300_000, "91"), candle(start - 299_000, "92")],
  };
  const provenance = { source: "blast-infra" as const, network: "localnet" as const, deployment: "fixture", checkpoint: 1, timestampMs: start, observedAt: start, lagMs: 0 };
  const controls = { interval: "1s", range: "live" } as const;
  const container = dom.document.createElement("div");
  const root = createRoot(container);
  t.after(() => act(async () => root.unmount()));
  const noRows: readonly ActivityRow[] = [];
  function TradeHistory({ row }: Readonly<{ row: ActivityRow | null }>) {
    usePublishWalletTrades(noRows, row);
    return null;
  }
  const render = (updates: string | null, trade: { cursor: string; timestampMs: number; side: "buy"; price: string; quoteAmount: bigint; memeAmount: bigint } | null = null, history: ActivityRow | null = null) => act(async () => root.render(
    <WalletTradesProvider deployer={null}><TradeHistory row={history} /><ChartTradeContext value={{ trade, poolKey, receivedAt: trade ? performance.now() : null, decimals: 9, symbol: "SUI" }}><ChartView
      compact
      livePreset
      source={{ expected: null, curvePoolKey: poolKey, venuePoolKey: null, migration: null, symbol: "PIP", quoteSymbol: "SUI", memeDecimals: 9, quoteDecimals: 9 }}
      state={{ key: "1s|live", curve: { state: "available", data: trade ? { ...page, candles: [candle(trade.timestampMs, trade.price)] } : page, provenance: { ...provenance, observedAt: now, timestampMs: now } }, venue: null, migration: null }}
      controls={controls}
      request={chartRequest(controls, start)}
      hidden={[]}
      updates={updates}
      pending={false}
      onControls={() => {}}
      onToggle={() => {}}
      onRefresh={() => {}}
    /></ChartTradeContext></WalletTradesProvider>,
  ));
  await render(null);
  const plot = container.querySelector("[data-series]");
  assert.equal(plot?.getAttribute("data-series"), "Candlestick,Histogram");
  assert.equal(plot?.getAttribute("data-points"), "1799999701:92");
  assert.ok(container.querySelector('button[aria-label="Chart range: Live, last 5 minutes"]'));

  now += 1_000;
  await act(async () => document.dispatchEvent(new dom.window.Event("visibilitychange")));
  assert.equal(container.querySelector("[data-series]"), null);
  assert.match(container.textContent ?? "", /No trades in this range/);

  await render("Trade updates delayed.");
  assert.match(container.querySelector('[role="status"]')?.textContent ?? "", /Trade updates delayed/);
  assert.doesNotMatch(container.textContent ?? "", /No trades in this range/);

  const buy = { cursor: "2:0:1:0", timestampMs: now, side: "buy" as const, price: "93", quoteAmount: 20n, memeAmount: 1_000_000_000n };
  await render(null, buy);
  assert.equal(container.querySelector("[data-candle-trade-amount]")?.textContent, "+1", "the first trade after the quiet period cues its new candle");
  await render(null, buy, { position: "2:0:2:0", checkpoint: 2, timestampMs: now, digest: "newer", kind: "curve_sell",
    source: "user", actor: null, lifecycle: null, amounts: { quote: 100_000_000n, meme: 1_000_000_000n } });
  assert.equal(container.querySelector("[data-chart-last-trade] [data-trade-cue]")?.textContent, "Sell · 0.1\u00a0SUI");
  assert.equal(container.querySelector("[data-candle-trade-amount]"), null, "the earlier buy callout leaves when newer history wins");
});

test("panning the live candle out of the price pane hides its amount", async () => {
  const { projectCandleTrade } = await import("../../charts/candle-trade.ts");
  type Handle = Parameters<typeof projectCandleTrade>[0];
  const time = 1 as import("lightweight-charts").UTCTimestamp;
  const specs = [{ type: "Candlestick", data: [{ time, open: 12, high: 14, low: 9, close: 10 }] }] as const;
  let x = 99;
  let y = 49;
  const handle = {
    chart: { timeScale: () => ({ options: () => ({ barSpacing: 8 }), timeToCoordinate: () => x }), paneSize: () => ({ width: 100, height: 50 }) },
    series: [{ priceToCoordinate: () => y }],
  } as unknown as Handle;
  assert.deepEqual(projectCandleTrade(handle, specs, 0), { x: 95, y, width: 95, left: true, below: false });
  x = 8;
  assert.deepEqual(projectCandleTrade(handle, specs, 0), { x: 12, y, width: 88, left: false, below: false });
  x = 101;
  assert.equal(projectCandleTrade(handle, specs, 0), "offscreen");
  x = -1;
  assert.equal(projectCandleTrade(handle, specs, 0), "offscreen");
  x = 20;
  y = 51;
  assert.equal(projectCandleTrade(handle, specs, 0), "offscreen", "a label never spills into volume");
});
