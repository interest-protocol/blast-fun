import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { installNoopCanvas, installTestDom, waitFor } from "../../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
installNoopCanvas(dom);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./TradingViewChart" && context.parentURL?.endsWith("/charts/PoolCandleChart.tsx")) return {
    shortCircuit: true,
    url: `data:text/javascript,${encodeURIComponent(`import React from ${JSON.stringify(import.meta.resolve("react"))}; export const VOLUME_SCALE = 'volume'; export const MIGRATION_LABEL_ROOM_PX = 72; export function TradingViewChart({series, priceFormatter, onProject, projectionKey, latestPrice, preview}) {
      React.useLayoutEffect(() => {
        let settled = false;
        const handle = {
          chart: {
            timeScale: () => ({ getVisibleLogicalRange: () => ({from: 0, to: 12}), options: () => ({ barSpacing: 8 }), timeToCoordinate: time => series[0]?.data.some(point => point.time === time) ? Number((settled ? undefined : document.documentElement.dataset.testSyncCandleX) ?? document.documentElement.dataset.testCandleX ?? 83) : null, width: () => 100 }),
            panes: () => series.some(s => s.pane === 1) ? [{}, {}] : [{}],
            paneSize: () => ({ width: 100, height: 140 })
          },
          series: series.map(s => ({ priceToCoordinate: price => s.data.some(point => price === (point.close ?? point.value)) ? 40 : null }))
        };
        onProject(handle, false);
        if (document.documentElement.dataset.testProjectionSettled !== "false") {
          let mounted = true;
          queueMicrotask(() => { if (mounted) { settled = true; onProject(handle, true); } });
          return () => { mounted = false; };
        }
      }, [series, projectionKey]);
      return React.createElement('div', {'data-latest-series': latestPrice?.seriesIndex, 'data-series': series.map(s=>s.type).join(','), 'data-tags': series.map(s=>String(s.options?.lastValueVisible)).join(','), 'data-points': series[0]?.data.map(p => p.time + ':' + priceFormatter(p.value ?? p.close)).join(','), 'data-last-points': series.at(-1)?.data.map(p => p.time + ':' + priceFormatter(p.value ?? p.close)).join(',')}, preview); }`)}`,
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
  const { preferredChartControls } = await import("./chart-model.ts");
  const { saveChartControls } = await import("./chart-preferences.ts");
  const key = "blast.coin-chart.controls";
  try {
    saveChartControls({ interval: "5m", range: "all" }, { interval: "15m", range: "all" });
    const saved = dom.window.localStorage.getItem(key) ?? "";
    assert.equal(saved, "interval.all=15m");
    assert.deepEqual(preferredChartControls(saved, "", { interval: "5m", range: "24h" }), {
      interval: "5m",
      range: "24h",
    });
  } finally {
    dom.window.localStorage.removeItem(key);
  }
});

test("a link's range and interval open the chart when nothing is saved", async (t) => {
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
  function Probe() {
    const { controls, ready } = useCoinChartControls(true, { range: "24h", interval: "5m" }, false);
    return <p>{ready ? `${controls.range} / ${controls.interval}` : "waiting"}</p>;
  }
  for (const [search, shown] of [
    ["?interval=5m&range=all", "all / 5m"],
    ["?interval=15m&range=all", "all / 15m"],
    ["?interval=5m&range=24h", "24h / 5m"],
    ["", "24h / 5m"],
  ] as const) {
    window.localStorage.removeItem(key);
    window.history.replaceState(null, "", search || window.location.pathname);
    await act(async () => root.render(<Probe key={search} />));
    assert.equal(node.textContent, shown, search);
  }
  // The link still wins over a saved choice.
  window.localStorage.setItem(key, "interval=1h&range=7d");
  window.history.replaceState(null, "", "?interval=15m&range=all");
  await act(async () => root.render(<Probe key="saved" />));
  assert.equal(node.textContent, "all / 15m");
});

test("compact style controls keep one chart and the trade cue above it", async () => {
  const poolKey = "blast_curve:0x1";
  const venuePoolKey = `bluefin:0x${"a7".repeat(32)}`;
  const page = { poolKey, source: "curve" as const, venue: "blast_curve" as const, interval: "1m" as const, migration: null, candles: [{ bucketStart: 1_790_337_600_000, open: "1", high: "2", low: "1", close: "2", volumeQuote: 20n, volumeMeme: 10n, volumeUsd: null, buys: 1, sells: 0, trades: 1 }] };
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  const router = { push() {} };
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
    const compactChart = (hidden: readonly "curve"[], trade: Omit<typeof buy, "side"> & { side: "buy" | "sell" } = buy, market = poolKey, close = "2", traded = 1) => (
      <AppRouterContext value={router as never}>
      <WalletTradesProvider deployer={actor}><Tape /><ChartTradeContext value={{ trade, poolKey: market, receivedAt: receivedAt(trade.cursor), decimals: 9, symbol: "SUI" }}>
      <ChartView
        compact
        source={{ expected: null, curvePoolKey: poolKey, venuePoolKey, migration: null, symbol: "PIP", quoteSymbol: "SUI", memeDecimals: 9, quoteDecimals: 9, opening: { timestampMs: 1_790_337_617_000, price: "0.5" } }}
        quoteUsd="0.70"
        state={{
          key: "1m|all",
          curve: { state: "available", data: { ...page, candles: Array.from({ length: traded }, (_, i) => ({ ...page.candles[0]!, bucketStart: page.candles[0]!.bucketStart - (traded - 1 - i) * 60_000, close })) }, provenance: { source: "blast-infra", network: "localnet", deployment: "fixture", checkpoint: 1, timestampMs: 1_790_337_631_000, observedAt: 1_790_337_631_000, lagMs: 0 } },
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
      /></ChartTradeContext></WalletTradesProvider>
      </AppRouterContext>
    );
    const render = (...args: Parameters<typeof compactChart>) => act(async () => root.render(compactChart(...args)));
    assert.doesNotMatch(renderToStaticMarkup(compactChart([])), /data-kline-plot/, "the chart loads in the browser only");
    await render([], buy, poolKey, "2", 0);
    const cue = container.querySelector("[data-trade-cue]");
    assert.equal(cue?.textContent, "Buy · 0.1\u00a0SUI", "an observed trade remains readable without plotted geometry");
    assert.equal(container.querySelector("[data-kline-plot]"), null);
    await render([]);
    assert.equal(container.querySelector("[data-trade-cue]"), cue, "showing the plot retains the original cue");
    assert.ok(container.querySelector("[data-chart-last-trade]")?.nextElementSibling?.querySelector("[data-kline-plot]"), "the readout sits immediately above the real chart figure");
    assert.equal(container.querySelectorAll("[data-kline-plot]").length, 1);
    assert.equal(container.querySelector('[aria-label="Chart style"]'), null, "a handful of trades still draws candles, so there is no style picker");
    await render([], buy, poolKey, "2", 10);
    const plot = () => container.querySelector("[data-kline-plot]")!;
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    const originalPlot = plot();
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    assert.equal(dom.window.localStorage.getItem("blast.coin-chart.wallet-tags"), "hidden");
    assert.equal(plot(), originalPlot, "hiding wallet tags keeps the chart");
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    assert.equal(toggle.closest("[data-compact-chart] > :first-child") !== null, true, "Traders sits in the chart's one control row");
    assert.equal(container.querySelector('[aria-label="Chart style"]'), null, "no style picker");
    assert.equal(container.querySelector('[aria-label="Bluefin pool candles"]'), null);
    assert.equal(container.querySelector('button[aria-label="Source details"]'), null);
    assert.doesNotMatch(container.textContent ?? "", new RegExp(venuePoolKey));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("one click on an interval button changes the candles; Live has none", async () => {
  const poolKey = "blast_curve:0x1";
  const candle = { bucketStart: 1_790_337_600_000, open: "1", high: "2", low: "1", close: "2", volumeQuote: 20n, volumeMeme: 10n, volumeUsd: null, buys: 1, sells: 0, trades: 1 };
  const page = { poolKey, source: "curve" as const, venue: "blast_curve" as const, interval: "5m" as const, migration: null, candles: Array.from({ length: 12 }, (_, i) => ({ ...candle, bucketStart: candle.bucketStart + i * 300_000 })) };
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  const picked: unknown[] = [];
  const chart = (controls: { interval: "5m" | "1s"; range: "all" | "live" }) => (
    <AppRouterContext value={{ push() {} } as never}>
      <ChartView
        compact
        source={{ expected: null, curvePoolKey: poolKey, venuePoolKey: null, migration: null, symbol: "PIP", quoteSymbol: "SUI", memeDecimals: 9, quoteDecimals: 9 }}
        quoteUsd="0.70"
        state={{ key: `${controls.interval}|${controls.range}`, curve: { state: "available", data: page, provenance: { source: "blast-infra", network: "localnet", deployment: "fixture", checkpoint: 1, timestampMs: 1_790_341_200_000, observedAt: 1_790_341_200_000, lagMs: 0 } }, venue: null, migration: null }}
        controls={controls}
        request={chartRequest(controls, 1_790_341_260_000)}
        hidden={[]}
        updates={null}
        pending={false}
        onControls={(next) => picked.push(next)}
        onToggle={() => {}}
        onRefresh={() => {}}
      />
    </AppRouterContext>
  );
  try {
    await act(async () => root.render(chart({ interval: "5m", range: "all" })));
    const group = container.querySelector('[aria-label="Candle interval"]');
    assert.ok(group, "the intervals are one row of buttons");
    const hour = [...group.querySelectorAll("button")].find((button) => button.textContent === "1h")!;
    await act(async () => hour.click());
    assert.deepEqual(picked, [{ interval: "1h", range: "all" }], "one click, no picker to open or close");
    await act(async () => root.render(chart({ interval: "1s", range: "live" })));
    assert.equal(container.querySelector('[aria-label="Candle interval"]'), null, "Live has one interval, so no buttons");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("opening the chart's picker focuses its card, not its first field (focusing a field scrolled the page)", async () => {
  const poolKey = "blast_curve:0x1";
  const candle = { bucketStart: 1_790_337_600_000, open: "1", high: "2", low: "1", close: "2", volumeQuote: 20n, volumeMeme: 10n, volumeUsd: null, buys: 1, sells: 0, trades: 1 };
  const page = { poolKey, source: "curve" as const, venue: "blast_curve" as const, interval: "5m" as const, migration: null, candles: [candle] };
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  const controls = { interval: "5m" as const, range: "all" as const };
  try {
    await act(async () => root.render(
      <AppRouterContext value={{ push() {} } as never}>
        <ChartView
          compact
          source={{ expected: null, curvePoolKey: poolKey, venuePoolKey: null, migration: null, symbol: "PIP", quoteSymbol: "SUI", memeDecimals: 9, quoteDecimals: 9 }}
          quoteUsd="0.70"
          state={{ key: "5m|all", curve: { state: "available", data: page, provenance: { source: "blast-infra", network: "localnet", deployment: "fixture", checkpoint: 1, timestampMs: 1_790_341_200_000, observedAt: 1_790_341_200_000, lagMs: 0 } }, venue: null, migration: null }}
          controls={controls}
          request={chartRequest(controls, 1_790_341_260_000)}
          hidden={[]}
          updates={null}
          pending={false}
          onControls={() => {}}
          onToggle={() => {}}
          onRefresh={() => {}}
        />
      </AppRouterContext>,
    ));
    const trigger = container.querySelector<HTMLButtonElement>("button.filterTrigger")!;
    assert.ok(trigger, "the range picker's button");
    await act(async () => trigger.click());
    const focused = await waitFor(() => dom.document.activeElement !== dom.document.body && dom.document.activeElement, "focus moves into the picker");
    assert.ok(focused.matches("[role=dialog]") && focused.querySelector("select"), `focus lands on the card holding the fields, not ${focused.outerHTML.slice(0, 80)}`);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Live is a line chart on desktop and mobile and keeps the newest trade cue", async (t) => {
  const start = 1_800_000_000_000;
  const now = start;
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
  const render = (updates: string | null, trade: { cursor: string; timestampMs: number; side: "buy"; price: string; quoteAmount: bigint; memeAmount: bigint } | null = null, history: ActivityRow | null = null, graduated?: "traded" | "quiet") => {
    const migration = graduated ? {
      cursor: "1:0:0:0", timestampMs: now - (graduated === "quiet" ? 315_000 : 65_000) + 550,
      curvePoolKey: poolKey, venuePoolKey: `cetus:0x${"c3".repeat(32)}`,
    } : null;
    const checkpoint = { ...provenance, observedAt: now, timestampMs: now };
    const curve = { ...page, migration, candles: trade ? [candle(trade.timestampMs, trade.price)] : page.candles };
    const venue = migration && (graduated === "traded" ? {
      state: "available" as const, provenance: checkpoint,
      data: { ...page, poolKey: migration.venuePoolKey, source: "venue" as const, venue: "cetus" as const, migration, candles: [candle(now - 65_000, "93")] },
    } : { state: "empty" as const, provenance: checkpoint });
    return act(async () => root.render(
    <WalletTradesProvider deployer={null}><TradeHistory row={history} /><ChartTradeContext value={{ trade, poolKey, receivedAt: trade ? performance.now() : null, decimals: 9, symbol: "SUI" }}><ChartView
      compact
      livePreset
      source={{ expected: null, curvePoolKey: poolKey, venuePoolKey: migration?.venuePoolKey ?? null, migration, symbol: "PIP", quoteSymbol: "SUI", memeDecimals: 9, quoteDecimals: 9 }}
      state={{ key: "1s|live", curve: { state: "available", data: curve, provenance: checkpoint }, venue, migration }}
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
  };
  await render(null);
  assert.ok(container.querySelector("[data-kline-plot]"));
  assert.ok(container.querySelector('button[aria-label="Chart range: Live, last 5 minutes"]'));
  assert.equal(container.querySelector('[aria-label="Chart style"]'), null, "Live draws candles too, on every screen");

  await render("Trade updates delayed.");
  // A refused or dropped socket says so in the chart's head, beside the title, not under the plot.
  assert.equal(container.querySelector("[data-stream-notice]")?.textContent, "Trade updates delayed.");
  assert.equal(container.querySelector("[data-stream-notice]")?.previousElementSibling?.tagName, "H2");
  assert.doesNotMatch(container.textContent ?? "", /No trades in this range/);

  const buy = { cursor: "2:0:1:0", timestampMs: now, side: "buy" as const, price: "93", quoteAmount: 20n, memeAmount: 1_000_000_000n };
  await render(null, buy);
  assert.match(container.querySelector("[data-chart-last-trade] [data-trade-cue]")?.textContent ?? "", /^Buy/);
  await render(null, buy, { position: "2:0:2:0", checkpoint: 2, timestampMs: now, digest: "newer", kind: "curve_sell",
    source: "user", actor: null, lifecycle: null, amounts: { quote: 100_000_000n, meme: 1_000_000_000n } });
  assert.equal(container.querySelector("[data-chart-last-trade] [data-trade-cue]")?.textContent, "Sell · 0.1\u00a0SUI", "newer history wins the cue");

  await render(null, null, null, "traded");
  assert.equal(container.querySelectorAll("[data-kline-plot]").length, 1, "a graduated coin is one chart");
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
