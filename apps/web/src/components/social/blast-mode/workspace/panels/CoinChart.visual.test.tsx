import assert from "node:assert/strict";
import test from "node:test";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import type { NativeCoinChart as NativeHistory } from "./coin-reads";

import {
  installTestDom,
  testEvent,
} from "../../../../../../test/fixtures/social/test-dom.ts";
const { window, document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ChartVisual, NativeCoinChart } = await import("./NativeCoinChart");
const { ChartTradesContext } = await import("./chart-trades-context");
const { chartPostsFixture, chartTradesFixture } = await import("../../../../../../test/fixtures/workspace/chart-trades-fixture");
const { DEFAULT_TRADE_FILTERS, filterChartTrades, withChartPosts } = await import("./chart-trades");
const { CoinChart, CoinPriceWindow } = await import("./CoinChart");
const { CoinDetailsSlots, PanelAssetContext } = await import("./panel-context");
const { WorkspaceFrame, ESCAPE_SETTLE_MS } = await import("../../WorkspaceFrame");
const { notifyShellPrefs } = await import(
  "#web/components/blast-ui/use-shell-prefs.ts"
);
import type { SocialPriceHistory } from "@blast/core/modules/social/contracts/prices.ts";

const observations = [
  { at: 0, value: "0.00000000000000123456789", source: "curve" },
  { at: 60_000, value: "0.00000000000000234567891", source: "curve" },
  { at: 180_000, value: "0.00000000000000345678912", source: "venue" },
];
function mount() {
  document.body.innerHTML = '<div data-blast-ui><div id="mount"></div></div>';
  return {
    dom: { window },
    root: createRoot(document.getElementById("mount")!),
  };
}

test("an empty recent TSUI period, an opening observation, older history and a failed read keep distinct chart states", async () => {
  const { root } = mount();
  const oldPoints = [[1_790_000_000_000, "0.000088"], [1_790_000_300_000, "0.000088"]] as const;
  const history: SocialPriceHistory = {
    coin_type: "ALON", presale_id: "alon", tier: "5m", from_ms: oldPoints[0][0],
    price_usd: null, price_24h_usd: null, change_24h_bps: null, day_open_ms: null, day_open_usd: null, points: [],
    quote: { coin_type: "test::sui::TSUI", symbol: "TSUI", price: "0.000088", as_of_ms: oldPoints[1][0], points: [], change_24h_bps: null },
  };
  const show = async (data: SocialPriceHistory | null, failed = false, window: "24h" | "launch" = "24h") => {
    await act(async () => root.render(<><CoinPriceWindow chart={{ renderer: "recharts", window, viewport: null }} history={data} onChart={() => {}} /><CoinChart activity={{ status: "ready", value: null, checkedAt: null, unavailable: false, retry() {}, refresh() {} }} chart={{ renderer: "recharts", window, viewport: null }} coin={null} failed={failed} history={data} onChart={() => {}} pending={false} retry={() => {}} /></>));
  };
  try {
    await show(history);
    assert.match(document.querySelector('[data-chart-empty="empty"]')?.textContent ?? "", /No recorded prices in this range/);
    assert.doesNotMatch(document.body.textContent!, /USD pricing unavailable/);
    assert.doesNotMatch(document.body.textContent!, /0\.00%/);
    await show({ ...history, quote: { ...history.quote!, points: [oldPoints[0]] } });
    assert.match(document.querySelector('[data-chart-empty="sparse"]')?.textContent ?? "", /Not enough price history/);
    await show({ ...history, quote: { ...history.quote!, points: oldPoints } }, false, "launch");
    assert.equal(document.querySelector('[data-chart-empty]'), null);
    assert.match(document.querySelector('[role="img"][aria-label="Observed pool price history"]')?.textContent ?? '', /Close price in TSUI/);
    assert.equal(Array.from(document.querySelectorAll('button')).find(button => button.textContent === "All")?.getAttribute("aria-pressed"), "true");
    await show(null, true);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /Price history could not load/);
    assert.ok(document.querySelector('[aria-label="Retry price history"]'));
    await show(null);
    assert.match(document.querySelector('[data-chart-empty="unavailable"]')?.textContent ?? "", /Price history unavailable/);
    const usd = { ...history, quote: undefined, price_usd: "0.002", price_24h_usd: "0.002", change_24h_bps: 0, points: [[oldPoints[0][0], "0.002"], [oldPoints[1][0], "0.002"]] as const };
    await show(usd);
    assert.match(document.querySelector('[role="img"][aria-label="Observed pool price history"]')?.textContent ?? '', /Close price in USD/);
    assert.doesNotMatch(document.body.textContent!, /Indexed USD observations/);
  } finally {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  }
});

test("native charts distinguish no trades from unreadable prices", async () => {
  const { root } = mount();
  const source = {
    expected: null, curvePoolKey: "curve", venuePoolKey: null, migration: null,
    symbol: "COIN", quoteSymbol: "SUI", memeDecimals: 9, quoteDecimals: 9,
  };
  const provenance = {
    source: "blast-infra", network: "mainnet", deployment: null,
    checkpoint: 1, timestampMs: 60_000, observedAt: 60_000, lagMs: 0,
  } as const;
  const chart = { renderer: "recharts", window: "24h", viewport: null } as const;
  const show = async (curve: NativeHistory["chart"]["curve"], memeDecimals: number | null = 9) => {
    const history: NativeHistory = {
      kind: "native", coin_type: "coin", source: { ...source, memeDecimals },
      chart: { curve, venue: null, migration: null },
    };
    await act(async () => root.render(<NativeCoinChart history={history} chart={chart} onChart={() => {}} />));
  };
  try {
    const noTrades = { state: "empty", provenance } as const;
    await show(noTrades);
    assert.ok(document.querySelector('[data-chart-empty="empty"]'));
    assert.match(document.body.textContent!, /No trades in this range/);

    await show({ state: "unavailable", reason: "failed read" });
    assert.ok(document.querySelector('[data-chart-empty="unavailable"]'));
    assert.doesNotMatch(document.body.textContent!, /No trades in this range/);

    await show({
      state: "available", provenance,
      data: {
        poolKey: "curve", source: "curve", venue: "blast_curve", interval: "1m", migration: null,
        candles: [{
          bucketStart: 60_000, open: "1", high: "1", low: "1", close: "1",
          volumeQuote: 1n, volumeMeme: 1n, volumeUsd: null, buys: 1, sells: 0, trades: 1,
        }],
      },
    }, null);
    assert.ok(document.querySelector('[data-chart-empty="unavailable"]'));
    assert.match(document.body.textContent!, /Price units couldn’t load/);
    assert.doesNotMatch(document.body.textContent!, /No trades in this range/);

    const chartSlot = document.createElement("div");
    const tradeSlot = document.createElement("div");
    document.querySelector("[data-blast-ui]")!.append(chartSlot, tradeSlot);
    const history: NativeHistory = {
      kind: "native", coin_type: "coin", source,
      chart: { curve: noTrades, venue: null, migration: null },
    };
    await act(async () => root.render(
      <PanelAssetContext value={() => {}}>
        <CoinDetailsSlots value={{ chart: chartSlot, trade: tradeSlot }}>
          <NativeCoinChart history={history} chart={chart} onChart={() => {}} />
        </CoinDetailsSlots>
      </PanelAssetContext>,
    ));
    const trigger = chartSlot.querySelector('button[aria-label="View chart values"]')!;
    assert.ok(trigger, "the chart values trigger uses the chart header slot");
    assert.equal(tradeSlot.childElementCount, 0);
    await act(async () => {
      trigger.dispatchEvent(testEvent("pointerdown", { button: 0, pointerType: "mouse" }));
      trigger.dispatchEvent(testEvent("pointerup", { button: 0, pointerType: "mouse" }));
      trigger.dispatchEvent(testEvent("click", { button: 0, detail: 1 }));
    });
    const details = document.querySelector('[role="dialog"][aria-label="View chart values"]');
    assert.match(details?.textContent ?? "", /No trades in this range/);
  } finally {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  }
});

test("a trade with a call and no thesis text keeps its call badge and canonical post link", async () => {
  const { root } = mount();
  const page = chartTradesFixture("coin");
  const post = { ...chartPostsFixture("coin", "market").items[0]!, call: true, why: null };
  const trades = filterChartTrades(page.participants, DEFAULT_TRADE_FILTERS, new Set(["maralin"]), new Map(), () => false);
  const annotations = withChartPosts(trades, [post], "market", DEFAULT_TRADE_FILTERS, new Set(["maralin"]), new Map(), () => false);
  const at = post.occurred_at_ms;
  try {
    await act(async () => root.render(
      <ChartTradesContext value={{ trades: annotations, coin: null, enabled: true, notice: null, partial: false, ready: true, window: "24h" }}>
        <ChartVisual observations={[{ at: at - 60_000, value: "1", source: "curve" }, { at: at + 60_000, value: "2", source: "curve" }]} intervalMs={120_000} units="SUI" label="Price history" />
      </ChartTradesContext>,
    ));
    const marker = document.querySelector<HTMLButtonElement>('[data-chart-trade-marker][aria-label*="Call available"]')!;
    assert.ok(marker, "joined call-only posts remain visible on their trade");
    assert.match(marker.textContent!, /C/);
    await act(async () => {
      marker.dispatchEvent(testEvent("pointerdown", { button: 0, pointerType: "mouse" }));
      marker.dispatchEvent(testEvent("pointerup", { button: 0, pointerType: "mouse" }));
      marker.dispatchEvent(testEvent("click", { button: 0, detail: 1 }));
    });
    const popup = document.querySelector('[aria-label="Chart trade details"]')!;
    assert.ok(popup, "call details open");
    assert.match(popup.textContent!, /Call/);
    const link = [...popup.querySelectorAll("a")].find(node => node.textContent === "View post");
    assert.equal(link?.getAttribute("href"), `/p/${post.entry_id.replaceAll(":", "-")}`);
    assert.equal(document.querySelector('[aria-label="Inspect price history"]')!.textContent!.includes("Trades · 24h"), false, "coverage is outside the interactive plot");
  } finally {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  }
});

test("TradingView chart keeps an accessible description and exact keyboard inspection without writing setup", async () => {
  const { dom, root } = mount();
  try {
    await act(async () =>
      root.render(
        <ChartVisual
          observations={observations}
          intervalMs={60_000}
          units="Quote atoms / coin atom"
          label="Native pool candles"
        />,
      ),
    );
    assert.ok(document.querySelector("[data-tradingview-plot]"), "plot is delegated to TradingView");
    assert.match(document.querySelector('[role="img"][aria-label="Native pool candles"]')!.textContent!, /Missing observations and source changes are gaps/);
    const frame = document.querySelector<HTMLElement>(
      '[aria-label="Inspect price history"]',
    )!;
    await act(async () => frame.focus());
    assert.ok(
      document.querySelector(
        '[aria-label*="Close 0.00000000000000345678912 Quote atoms / coin atom"]',
      ),
    );
    await act(async () =>
      frame.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      ),
    );
    assert.ok(
      document.querySelector(
        '[aria-label*="Close 0.00000000000000123456789 Quote atoms / coin atom"]',
      ),
    );
    await act(async () =>
      frame.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
        }),
      ),
    );
    assert.ok(
      document.querySelector(
        '[aria-label*="Close 0.00000000000000234567891 Quote atoms / coin atom"]',
      ),
    );
    const inspect = document.querySelector<HTMLButtonElement>(
      '[aria-label*="Close 0.00000000000000234567891 Quote atoms / coin atom"]',
    )!;
    assert.equal(inspect.closest('[aria-label="Inspect price history"]'), null, "exact readout is outside the fixed plot so coarse labels can grow without clipping");
    await act(async () => inspect.focus());
    assert.equal(
      document.activeElement,
      inspect,
      "keyboard can reach the exact inspection button without unmounting it",
    );
    await act(async () => {
      inspect.dispatchEvent(
        testEvent("pointerdown", { button: 0, pointerType: "mouse" }),
      );
      inspect.dispatchEvent(
        testEvent("pointerup", { button: 0, pointerType: "mouse" }),
      );
      inspect.dispatchEvent(testEvent("click", { button: 0, detail: 1 }));
    });
    assert.ok(
      document.querySelector('[aria-label="Full chart observation"]'),
      "exact inspection stays mounted when focus enters its portal",
    );
    assert.match(
      document.querySelector('[aria-label="Full chart observation"]')!
        .textContent!,
      /0.00000000000000234567891/,
    );
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Close")!
        .click(),
    );
    await act(async () =>
      frame.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    assert.equal(document.querySelector('[data-active="true"]'), null);
  } finally {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  }
});

test("price privacy hides axis and inspection amounts, then restores exact observation", async () => {
  const { root } = mount();
  try {
    await act(async () =>
      root.render(
        <ChartVisual
          observations={observations}
          intervalMs={60_000}
          units="SUI"
          label="Observed pool price history"
        />,
      ),
    );
    await act(async () => {
      document
        .querySelector("[data-blast-ui]")!
        .setAttribute("data-amounts", "hidden");
      notifyShellPrefs();
      document
        .querySelector<HTMLElement>('[aria-label="Inspect price history"]')!
        .focus();
    });
    assert.doesNotMatch(document.body.textContent!, /3\.4567e-15/);
    assert.equal(
      document.querySelector('[aria-label*="chart observation"]'),
      null,
    );
    await act(async () => {
      document
        .querySelector("[data-blast-ui]")!
        .setAttribute("data-amounts", "shown");
      notifyShellPrefs();
    });
    assert.ok(
      document.querySelector('[aria-label*="0.00000000000000345678912 SUI"]'),
    );
  } finally {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  }
});

test("indexed quote-only chart keeps its real units and existing window/viewport commands", async () => {
  const { root } = mount();
  const changes: PanelSetup["coin"]["chart"][] = [];
  const chart = {
    renderer: "recharts",
    window: "24h",
    viewport: null,
  } as const;
  try {
    await act(async () =>
      root.render(
        <>
          <CoinPriceWindow
            chart={chart}
            onChart={(next) => changes.push(next)}
          />
          <CoinChart
            activity={{ status: "ready", value: null, checkedAt: null, unavailable: false, retry() {}, refresh() {} }}
            coin={null}
            pending={false}
            chart={chart}
            onChart={(next) => changes.push(next)}
            history={{
              coin_type: "coin",
              presale_id: null,
              tier: "5m",
              from_ms: 0,
              price_usd: null,
              price_24h_usd: null,
              change_24h_bps: null,
              day_open_ms: null,
              day_open_usd: null,
              points: [],
              quote: {
                coin_type: "sui",
                symbol: "SUI",
                price: "0.123456789",
                as_of_ms: 600_000,
                change_24h_bps: null,
                points: [
                  [0, "0.1"],
                  [300_000, "0.11"],
                  [600_000, "0.123456789"],
                ],
              },
            }}
          />
        </>,
      ),
    );
    assert.doesNotMatch(document.body.textContent!, /USD price unavailable/);
    assert.ok(document.querySelector('[data-tradingview-plot]'));
    assert.doesNotMatch(document.body.textContent!, /\$/);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Chart range"] button')].find(button => button.textContent === "All")!.click();
    });
    assert.deepEqual(changes.at(-1), {
      renderer: "recharts",
      window: "launch",
      viewport: null,
    });
    await act(async () =>
      buttons
        .find((button) => button.textContent === "Zoom to the latest half")!
        .click(),
    );
    assert.deepEqual(changes.at(-1), {
      renderer: "recharts",
      window: "24h",
      viewport: { from_ms: 300_000, to_ms: 600_000 },
    });
  } finally {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  }
});


test("active inspection consumes Escape before actual WorkspaceFrame exit and a later Escape exits", async () => {
  const { root } = mount();
  let exits = 0;
  try {
    await act(async () => root.render(<WorkspaceFrame onExit={() => { exits++; }}><ChartVisual observations={observations} intervalMs={60_000} units="Quote atoms / coin atom" label="Native pool candles" /></WorkspaceFrame>));
    const frame = document.querySelector<HTMLElement>('[aria-label="Inspect price history"]')!;
    await act(async () => frame.focus());
    const escape = new window.KeyboardEvent("keydown", {key:"Escape",bubbles:true,cancelable:true});
    // The chart stops this Escape before the frame's listener; the frame learns that only when the next Escape arrives.
    await act(async () => { frame.dispatchEvent(escape); });
    assert.ok(document.querySelector('[data-active="true"]')===null);
    assert.equal(exits,0,"active local dismissal must not invoke workspace exit");
    assert.equal(escape.defaultPrevented,true);
    assert.equal(document.activeElement,frame);
    await act(async () => frame.dispatchEvent(new window.KeyboardEvent("keydown", {key:"Escape",bubbles:true,cancelable:true})));
    assert.equal(exits,0,"an Escape right after one that closed a layer never exits (audit F4)");
    const settled = new window.KeyboardEvent("keydown", {key:"Escape",bubbles:true,cancelable:true});
    Object.defineProperty(settled, "timeStamp", { value: escape.timeStamp + ESCAPE_SETTLE_MS });
    await act(async () => frame.dispatchEvent(settled));
    assert.equal(exits,1,"once nothing closed for the settle window, Escape exits");
  } finally { await act(async () => root.unmount()); }
});


test("an open popover owns Escape: a visible dismiss button behind it stays open and Blast mode stays", async () => {
  const { root } = mount();
  let exits = 0;
  let dismissed = 0;
  try {
    await act(async () => root.render(<WorkspaceFrame onExit={() => { exits++; }}>
      <button type="button" data-workspace-escape onClick={() => { dismissed++; }}>Close drawer</button>
      <div role="dialog" data-open="">Popover</div>
      <button type="button">Elsewhere</button>
    </WorkspaceFrame>));
    const outside = [...document.querySelectorAll("button")].find((button) => button.textContent === "Elsewhere")!;
    outside.focus();
    const press = () => act(async () => { outside.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await press();
    assert.equal(dismissed, 0, "one Escape never closes the popover and the drawer behind it");
    assert.equal(exits, 0);
    document.querySelector('[role="dialog"]')!.remove();
    const settled = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    Object.defineProperty(settled, "timeStamp", { value: performance.now() + ESCAPE_SETTLE_MS });
    await act(async () => { outside.dispatchEvent(settled); });
    assert.equal(dismissed, 1, "with the popover gone, Escape closes the drawer");
    assert.equal(exits, 0);
  } finally { await act(async () => root.unmount()); }
});

test("range and interval controls normalize unsupported saved tiers and reset only the viewport", async () => {
  const { root } = mount();
  const changes: PanelSetup["coin"]["chart"][] = [];
  try {
    await act(async () => root.render(<CoinPriceWindow chart={{ renderer: "recharts", window: "7d", interval: "5m", viewport: { from_ms: 1, to_ms: 2 } }} sinceLaunch={false} onChart={next => changes.push(next)} />));
    const ranges = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Chart range"] button')];
    assert.equal(ranges.find(button => button.textContent === "All")!.disabled, true);
    assert.equal(ranges.find(button => button.textContent === "7D")!.getAttribute("aria-pressed"), "true");
    assert.deepEqual(ranges.map(button => button.textContent), ["1H", "6H", "24H", "7D", "30D", "All"]);
    const interval = document.querySelector<HTMLButtonElement>('[aria-label="Chart interval: Auto (1h)"]')!;
    assert.ok(interval, "an unsupported saved interval visibly falls back to the supported automatic tier");
    await act(async () => interval.click());
    const choices = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    assert.deepEqual(choices.map(choice => choice.textContent?.replace("✓", "")), ["Auto (1h)", "1h", "1d"]);
    await act(async () => choices.find(choice => choice.textContent === "1d")!.click());
    assert.deepEqual(changes.at(-1), { renderer: "recharts", window: "7d", interval: "1d", viewport: null });
    await act(async () => ranges.find(button => button.textContent === "30D")!.click());
    assert.deepEqual(changes.at(-1), { renderer: "recharts", window: "30d", viewport: null });
  } finally { await act(async () => root.unmount()); document.body.innerHTML = ""; }
});

test("candle inspection keeps exact OHLC and volume outside the canvas and masks both in privacy mode", async () => {
  const { root } = mount();
  const data = observations.map((point, index) => ({ ...point, candle: { open: point.value, high: "0.000000000000004", low: "0.000000000000001" }, volume: `${index + 1}.000000000000000001` }));
  try {
    await act(async () => root.render(<ChartVisual observations={data} intervalMs={60_000} units="SUI" label="Candles" style="candles" volume volumeUnits="SUI" />));
    assert.ok(document.querySelector('[aria-label*="3.000000000000000001 SUI"]'));
    const frame = document.querySelector<HTMLElement>('[aria-label="Inspect price history"]')!;
    await act(async () => { frame.focus(); frame.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
    assert.ok(document.querySelector('[aria-label*="1.000000000000000001 SUI"]'));
    await act(async () => { document.querySelector('[data-blast-ui]')!.setAttribute("data-amounts", "hidden"); notifyShellPrefs(); });
    assert.equal(document.querySelector('[aria-label*="candle volume"]'), null);
    assert.doesNotMatch(document.querySelector('[aria-label="Candle values"]')!.textContent!, /0\.00000000000000|1\.000000000000000001/);
  } finally { await act(async () => root.unmount()); }
});

test("chart controls retain candle and volume preferences through a range change and explain unsupported feeds", async () => {
  const { root } = mount();
  const changes: PanelSetup["coin"]["chart"][] = [];
  const chart = { renderer: "recharts", window: "24h", style: "candles", volume: false, viewport: null } as const;
  const history = { kind: "market", coin_type: "coin", page: { coinType: "coin", interval: "5m", candles: [], migration: null }, request: { interval: "5m", capped: false }, stale: false, provenance: { source: "blast-infra", network: "mainnet", deployment: null, checkpoint: 1, timestampMs: 0, observedAt: 0, lagMs: 0 }, decimals: 9, quoteDecimals: 9, poolKey: null } as const;
  try {
    await act(async () => root.render(<CoinPriceWindow chart={chart} history={history} onChart={next => changes.push(next)} />));
    assert.ok(document.querySelector('[aria-label="Chart interval: Auto (5m)"]'));
    const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text)!;
    await act(async () => button("7D").click());
    assert.deepEqual(changes.at(-1), { renderer: "recharts", window: "7d", style: "candles", volume: false, viewport: null });
    await act(async () => button("Line").click());
    const changed = changes.at(-1)!;
    assert.ok(changed.renderer === "recharts");
    assert.equal(changed.style, "line");
    await act(async () => root.render(<CoinPriceWindow chart={chart} history={null} onChart={next => changes.push(next)} />));
    // Audit 14: unsupported Candles and Volume stay focusable and explain themselves when pressed, without changing the chart.
    const asked = changes.length;
    assert.equal(button("Candles").hasAttribute("data-unavailable"), true);
    assert.equal(button("Volume").hasAttribute("data-unavailable"), true);
    assert.match(button("Candles").title, /need recorded swaps/);
    await act(async () => button("Candles").click());
    assert.equal(changes.length, asked, "pressing explains instead of switching to candles");
  } finally { await act(async () => root.unmount()); }
});

test("chart details omit observation/check timestamps and indexed-price captions", async () => {
  const { root } = mount();
  const history: SocialPriceHistory = {
    coin_type: "ALON", presale_id: "alon", tier: "5m", from_ms: 1_800_000_000_000,
    price_usd: null, price_24h_usd: null, change_24h_bps: null, day_open_ms: null, day_open_usd: null, points: [],
    quote: { coin_type: "test::sui::TSUI", symbol: "TSUI", price: "0.000088", as_of_ms: 1_790_000_000_000, points: [], change_24h_bps: null },
  };
  const show = async (data: SocialPriceHistory) => {
    await act(async () => root.render(<CoinChart activity={{ status: "ready", value: null, checkedAt: null, unavailable: false, retry() {}, refresh() {} }} chart={{ renderer: "recharts", window: "24h", viewport: null }} coin={null} history={data} onChart={() => {}} pending={false} />));
  };
  try {
    await show(history);
    assert.doesNotMatch(document.body.textContent!, /Last observation|Last checked|executable quotes|USD price unavailable/);
    assert.match(document.body.textContent!, /Last price [\d.,₀-₉]+ TSUI/);
    await show({ ...history, quote: undefined });
    assert.doesNotMatch(document.body.textContent!, /Observation time unavailable|Last checked/);
  } finally {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  }

});


test("migration bucket shows combined volume and retains exact source volume with privacy", async () => {
  const { root } = mount();
  const data = [
    { ...observations[0]!, source: "curve", candle: { open: "1", high: "3", low: "1" }, volume: "1.000000000000000001" },
    { ...observations[0]!, source: "venue", candle: { open: "1", high: "3", low: "1" }, volume: "2.000000000000000002" },
  ];
  try {
    await act(async () => root.render(<ChartVisual observations={data} intervalMs={60_000} units="SUI" label="Migration candles" style="candles" volume volumeUnits="SUI" />));
    assert.match(document.body.textContent!, /Combined vol 3 SUI.*Source vol 2 SUI/);
    assert.ok(document.querySelector('[aria-label*="3.000000000000000003 SUI"]'));
    assert.ok(document.querySelector('[aria-label*="2.000000000000000002 SUI"]'));
    await act(async () => { document.querySelector('[data-blast-ui]')!.setAttribute("data-amounts", "hidden"); notifyShellPrefs(); });
    assert.doesNotMatch(document.querySelector('[aria-label="Candle values"]')!.textContent!, /3.000000000000000003|2.000000000000000002/);
  } finally { await act(async () => root.unmount()); }
});


