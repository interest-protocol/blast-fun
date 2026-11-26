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
  assert.equal(slot.querySelector("[data-trade-cue]")?.hasAttribute("title"), false);
  assert.match(slot.querySelector("time")?.getAttribute("title") ?? "", /UTC$/);
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
  assert.equal(full.hasAttribute("title"), false);
  assert.ok(host.querySelector('[aria-hidden="true"][data-width-sample]')?.getAttribute("data-width-sample")?.endsWith(symbol));
  wallClock += 20_000;
  await act(async () => document.dispatchEvent(new dom.window.Event("visibilitychange")));
  assert.equal(host.querySelector("time")?.textContent, "20s ago");
  assert.equal(effects.all.length, 4);
  await act(() => root.render(<ChartLastTrade />));
  assert.equal(host.querySelector("[data-chart-last-trade]"), null, "a chart without a live market has no empty strip");
});

test("a stream trade under a dollar never becomes the Last-trade pill; the latest real trade stays", async t => {
  const { CREATE_QUOTE_TYPE } = await import("@blast/core/web/contracts/create.ts");
  const host = dom.document.createElement("div");
  const root = createRoot(host);
  t.after(async () => { await act(() => root.unmount()); });
  const render = (cursor: number, quoteAmount: bigint) => act(async () => {
    const trade = { cursor: `10:0:${cursor}:0`, timestampMs: TRADE_TIME, side: "buy", quoteAmount } as MarketTrade["trade"];
    root.render(<WalletTradesProvider deployer={null}>
      <PublishedHistory position="9:0:1:0" timestampMs={TRADE_TIME - 12 * 60_000} />
      <ChartTradeContext value={{ trade, poolKey: "curve", receivedAt: null, decimals: 6, symbol: "USDC", quoteType: CREATE_QUOTE_TYPE }}>
        <ChartLastTrade />
      </ChartTradeContext>
    </WalletTradesProvider>);
  });
  await render(1, 100n);
  assert.equal(host.querySelector("[data-trade-cue]")?.textContent, "Sell · 250 USDC", "$0.0001 of USDC is dust");
  await render(2, 1_000_000n);
  assert.equal(host.querySelector("[data-trade-cue]")?.textContent, "Buy · 1 USDC", "a dollar is a trade");
});

test("the pill speaks the page's unit: dollars while the page shows USD, the quote otherwise", async t => {
  const { CREATE_QUOTE_TYPE } = await import("@blast/core/web/contracts/create.ts");
  const { CoinPriceCurrencyProvider, useCoinPriceCurrency } = await import("./CoinPriceCurrency.tsx");
  const host = dom.document.createElement("div");
  const root = createRoot(host);
  t.after(async () => { await act(() => root.unmount()); });
  function Picker() {
    const currency = useCoinPriceCurrency();
    return <button data-pick="quote" onClick={() => currency?.setCurrency("quote")} type="button" />;
  }
  const trade = { cursor: "10:0:1:0", timestampMs: TRADE_TIME, side: "buy", quoteAmount: 12_400_000n } as MarketTrade["trade"];
  await act(async () => root.render(<CoinPriceCurrencyProvider quoteType={CREATE_QUOTE_TYPE} quoteSymbol="USDC">
    <Picker />
    <ChartTradeContext value={{ trade, poolKey: "venue", receivedAt: null, decimals: 6, symbol: "USDC", quoteType: CREATE_QUOTE_TYPE }}>
      <ChartLastTrade />
    </ChartTradeContext>
  </CoinPriceCurrencyProvider>));
  assert.equal(host.querySelector("[data-trade-cue]")?.textContent, "Buy · $12.4");
  await act(async () => host.querySelector<HTMLButtonElement>("[data-pick]")!.click());
  assert.equal(host.querySelector("[data-trade-cue]")?.textContent, "Buy · 12.4 USDC");
});

test("lastTradeUsd: recorded dollars first, then the page's rate for the page's own quote only", async () => {
  const { lastTradeUsd } = await import("./ChartLastTrade.tsx");
  const SUI = "0x2::sui::SUI";
  const usd = { currency: "usd", quoteType: SUI, quoteUsd: "2.5" } as const;
  const sui = { quoteType: SUI, decimals: 9 };
  assert.equal(lastTradeUsd(4_000_000_000n, null, sui, usd), "$10", "4 SUI at $2.50");
  assert.equal(lastTradeUsd(4_000_000_000n, "9.87", sui, usd), "$9.87", "the trade's recorded value wins");
  assert.equal(lastTradeUsd(4_000_000_000n, null, { quoteType: "0xabc::other::OTHER", decimals: 9 }, usd), null, "another quote is never priced at this rate");
  assert.equal(lastTradeUsd(4_000_000_000n, null, sui, { ...usd, quoteUsd: null }), null, "no rate keeps the quote amount");
  assert.equal(lastTradeUsd(4_000_000_000n, "9.87", sui, { ...usd, currency: "quote" }), null, "a page in the quote shows the quote");
  assert.equal(lastTradeUsd(4_000_000_000n, null, sui, null), null);
  assert.equal(lastTradeUsd(4_000_000_000n, null, { quoteType: null, decimals: 9 }, usd), null, "a trade of unknown quote is never priced at this rate");
});
