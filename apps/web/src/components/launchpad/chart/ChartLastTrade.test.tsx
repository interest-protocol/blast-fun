import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, recordAnimations } from "../../../../test/fixtures/social/test-dom.ts";
import type { ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import type { MarketTrade } from "../market-stream-hub.ts";

const dom = installTestDom();
const { act, useMemo } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ChartLastTrade } = await import("./ChartLastTrade.tsx");
const { ChartTradeContext } = await import("./chart-trade-context.ts");
const { WalletTradesProvider, usePublishWalletTrades } = await import("../activity/wallet-trades.tsx");
const TRADE_TIME = 1_800_000_000_000;
const NO_ROWS: readonly [] = [];
const HISTORY_AMOUNTS = { quote: 250_000_000n, meme: 1n };

function PublishedHistory({ position, timestampMs }: Readonly<{ position: string; timestampMs: number }>) {
  const history = useMemo((): ActivityRow => ({
    kind: "venue_sell", source: null, actor: null, lifecycle: null, position, checkpoint: Number(position.split(":")[0]),
    digest: "history", timestampMs, amounts: HISTORY_AMOUNTS,
  }), [position, timestampMs]);
  usePublishWalletTrades(NO_ROWS, history);
  return null;
}

test("a trade holds once, a burst stays quiet and remounting historical data cannot flash", async t => {
  const host = dom.document.createElement("div");
  const root = createRoot(host);
  t.after(async () => { await act(() => root.unmount()); dom.window.reducedMotion = false; });
  let now = 1_000;
  let wallClock = TRADE_TIME;
  t.mock.method(performance, "now", () => now);
  t.mock.method(Date, "now", () => wallClock);
  const effects = recordAnimations();
  t.mock.method(globalThis, "getComputedStyle", () => ({ opacity: "0.65" }));
  const render = (cursor: number | null, side: "buy" | "sell" = "buy", key = "first", symbol = "SUI", amount = 100_000_000n, live = true, historyPosition = "9:0:1:0") => act(async () => {
    const trade = cursor === null ? null : {
      cursor: `10:0:${cursor}:0`, timestampMs: TRADE_TIME, side, quoteAmount: amount,
    } as MarketTrade["trade"];
    root.render(<WalletTradesProvider deployer={null}>
      <PublishedHistory position={historyPosition} timestampMs={TRADE_TIME - 12 * 60_000} />
      <ChartTradeContext value={{ trade, poolKey: "curve", receivedAt: live ? now : null, decimals: 9, symbol }}>
        <ChartLastTrade key={key} />
      </ChartTradeContext>
    </WalletTradesProvider>);
  });
  await render(null);
  const slot = host.querySelector("[data-chart-last-trade]");
  assert.ok(slot);
  assert.equal(slot.textContent, "Last trade 12m agoSell · 0.25\u00a0SUI");
  assert.equal(effects.all.length, 0);
  await render(1);
  assert.equal(slot.textContent, "Last trade just nowBuy · 0.1\u00a0SUI");
  assert.equal(effects.all.length, 1);
  const entrance = effects.all[0]!;
  assert.equal(entrance.timing.duration, 1_280);
  assert.deepEqual(entrance.keyframes.map(frame => frame.opacity), [0, 1, 1, 0]);
  assert.equal(entrance.keyframes[1]?.offset, 120 / 1_280);
  assert.equal(entrance.keyframes[2]?.offset, 1_000 / 1_280);
  now += 15;
  await render(1);
  await render(2);
  assert.equal(effects.all.length, 1, "neither a duplicate nor a burst restarts the accent");
  await render(3, "sell");
  assert.equal(effects.all[0]!.playState, "idle", "an opposite-side trade interrupts the current cue");
  assert.equal(slot.textContent, "Last trade just nowSell · 0.1\u00a0SUI");
  assert.equal(effects.all.length, 2);
  assert.equal(effects.all[1]!.timing.duration, 120);
  assert.deepEqual(effects.all[1]!.keyframes.map(frame => frame.opacity), [0.65, 0]);
  now += 10_000;
  await render(3, "sell", "reopened");
  assert.equal(effects.all.length, 2, "a retained trade stays historical when the chart remounts");
  await render(4, "buy", "reopened");
  assert.equal(effects.all.length, 3);
  await render(5, "buy", "reopened", "SUI", 200_000_000n, false);
  assert.equal(host.querySelector("[data-trade-cue]")?.textContent, "Buy · 0.2\u00a0SUI");
  assert.equal(effects.all.length, 3, "catch-up can change the text without starting an animation");
  await render(5, "buy", "reopened", "SUI", 200_000_000n, false, "11:0:1:0");
  assert.equal(host.querySelector("[data-trade-cue]")?.textContent, "Sell · 0.25\u00a0SUI", "a newer activity cursor beats an old observed trade");
  assert.equal(effects.all.length, 4, "a newer opposite-side history row only fades the old cue out");
  dom.window.reducedMotion = true;
  now += 10_000;
  await render(5, "sell", "reopened");
  assert.equal(host.querySelector("[data-trade-cue]")?.textContent, "Sell · 0.1\u00a0SUI");
  assert.equal(effects.all.length, 4);
  const symbol = "A_VERY_LONG_QUOTE_SYMBOL";
  await render(6, "buy", "reopened", symbol, 18_446_744_073_709_551_615n);
  const full = host.querySelector("[data-trade-cue]")!;
  assert.equal(full.textContent, `Buy · 18,446,744,073.7 ${symbol}`);
  assert.ok(full.getAttribute("title")?.includes(`18446744073.709551615 ${symbol}`));
  assert.ok(host.querySelector('[aria-hidden="true"][data-width-sample]')?.getAttribute("data-width-sample")?.endsWith(symbol));
  wallClock += 20_000;
  await act(async () => document.dispatchEvent(new dom.window.Event("visibilitychange")));
  assert.equal(host.querySelector("time")?.textContent, "20s ago");
  assert.equal(effects.all.length, 4);
  await act(() => root.render(<ChartLastTrade />));
  assert.equal(host.querySelector("[data-chart-last-trade]"), null, "a chart without a live market has no empty strip");
});
