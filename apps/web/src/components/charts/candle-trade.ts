import type { ChartCandlePage } from "#web/components/launchpad/chart/chart-model.ts";
import { candleBucketStart, comparePrices, type PoolTrade } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import type { ChartHandle, ChartSeries } from "./TradingViewChart";
import { atLeastPow10, exactAtoms, groupedExact, shiftExact, subscriptZeros } from "@blast/core/lib/exact-amount.ts";
import { T2 } from "#web/components/blast-ui/motion-tokens.ts";
import { formatAmountShort } from "#web/components/launchpad/coin/coin-format.ts";

export type CandleTrade = Readonly<{
  poolKey: string;
  bucketStart?: number;
  receivedAt: number;
  trade: Pick<PoolTrade, "cursor" | "timestampMs" | "price" | "memeAmount" | "side">;
}>;

type Source = Readonly<{ page: ChartCandlePage; observedAt?: number | null }>;

/** Only the current head of the actual pool may carry this trade's label. */
function matchesTrade(head: CandleTrade, source: Source) {
  const candle = source.page.candles.at(-1);
  return source.page.poolKey === head.poolKey && candle !== undefined && head.trade.price !== null
    && source.observedAt != null && source.observedAt >= head.trade.timestampMs
    && candle.bucketStart === (head.bucketStart ?? candleBucketStart(source.page.interval, head.trade.timestampMs))
    && comparePrices(candle.close, head.trade.price) === 0;
}

function candleTradeAmount(atoms: bigint, decimals: number) {
  const amount = exactAtoms(atoms, decimals)!;
  for (const [power, suffix] of [[12, "T"], [9, "B"], [6, "M"], [3, "K"]] as const) {
    if (atLeastPow10(amount, power)) return groupedExact(shiftExact(amount, power), 2, "floor") + suffix;
  }
  return subscriptZeros(formatAmountShort(atoms, decimals));
}

export function candleTradeLabel(trade: CandleTrade | null | undefined, sources: readonly Source[], decimals: number | null, hidden: boolean) {
  if (!trade || decimals === null || hidden) return null;
  const index = sources.findIndex(source => matchesTrade(trade, source));
  if (index < 0) return null;
  const { side, memeAmount } = trade.trade;
  const sign = side === "buy" ? "+" : "−";
  return { index, text: `${sign}${candleTradeAmount(memeAmount, decimals)}`, side, cursor: trade.trade.cursor, receivedAt: trade.receivedAt };
}

export type CandleAnchor = Readonly<{ x: number; y: number; width: number; left: boolean; below: boolean }>;

/** The model's close is in the series' own scale, even for USD or very small prices. */
export function projectCandleTrade(handle: ChartHandle, specs: readonly ChartSeries[], index: number | undefined): CandleAnchor | "offscreen" | null {
  if (index === undefined) return null;
  const spec = specs[index];
  if (spec?.type !== "Candlestick" && spec?.type !== "Area") return null;
  const point = spec.data.at(-1);
  if (!point) return null;
  const price = "close" in point ? point.close : "value" in point ? point.value : undefined;
  if (typeof price !== "number") return null;
  const scale = handle.chart.timeScale();
  const x = scale.timeToCoordinate(point.time);
  const y = handle.series[index]?.priceToCoordinate(price);
  const { width, height } = handle.chart.paneSize(0);
  if (x == null || y == null || width <= 0 || height <= 0) return null;
  if (x < 0 || x >= width || y < 0 || y >= height) return "offscreen";
  // Keep the whole label beside the candle, even when its body spans the pane.
  const left = x > width / 2;
  const halfBar = Math.ceil(scale.options().barSpacing / 2);
  const edge = left ? x - halfBar : x + halfBar;
  const room = left ? edge : width - edge;
  if (room <= 0) return "offscreen";
  return { x: edge, y, width: room, left, below: y < height / 2 };
}

function sameAnchor(previous: CandleAnchor | null, next: CandleAnchor) {
  return previous !== null && previous.x === next.x && previous.y === next.y
    && previous.width === next.width && previous.left === next.left && previous.below === next.below;
}

const TRADE_HOLD_MS = 1_450;

/** Paints the DOM label alongside the native canvas in its projection callback. */
export function mountCandleTrade(slot: HTMLSpanElement) {
  const amount = slot.firstElementChild as HTMLSpanElement;
  let handled: string | null = null;
  let position: CandleAnchor | null = null;
  let fade: ReturnType<typeof setTimeout>;
  let end: ReturnType<typeof setTimeout>;

  function hide() {
    if (slot.hidden) return;
    clearTimeout(fade);
    clearTimeout(end);
    slot.hidden = true;
    amount.removeAttribute("data-candle-trade-amount");
    amount.textContent = "";
  }

  function move(anchor: CandleAnchor) {
    if (sameAnchor(position, anchor)) return;
    position = anchor;
    slot.style.left = `${anchor.x}px`;
    slot.style.top = `${anchor.y}px`;
    slot.style.setProperty("--trade-room", `${anchor.width}px`);
    slot.toggleAttribute("data-left", anchor.left);
    slot.toggleAttribute("data-below", anchor.below);
  }

  function place(label: ReturnType<typeof candleTradeLabel>, anchor: ReturnType<typeof projectCandleTrade>, settled: boolean) {
    if (!label || !anchor || anchor === "offscreen") {
      // A new bucket can sit outside the old scale before the library restores the viewport.
      if (label && settled && anchor === "offscreen") handled = label.cursor;
      hide();
      return;
    }
    if (handled === label.cursor) {
      if (!slot.hidden) move(anchor);
      return;
    }
    handled = label.cursor;
    if (performance.now() - label.receivedAt > TRADE_HOLD_MS) return hide();
    clearTimeout(fade);
    clearTimeout(end);
    move(anchor);
    amount.textContent = label.text;
    amount.dataset.candleTradeAmount = label.side;
    amount.removeAttribute("data-leaving");
    slot.hidden = false;
    // Start the dwell now, when the matched candle has a visible position.
    fade = setTimeout(() => amount.setAttribute("data-leaving", ""), TRADE_HOLD_MS);
    end = setTimeout(hide, TRADE_HOLD_MS + T2);
  }
  return { hide, place };
}
