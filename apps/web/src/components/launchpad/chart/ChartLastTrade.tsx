"use client";

import { useContext, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { HIDDEN_AMOUNT } from "@blast/core/web/format.ts";
import { atLeastPow10, exactAtoms, exactDecimal, multiplyExact } from "@blast/core/web/exact-amount.ts";
import { createQuoteOf } from "@blast/core/web/contracts/create.ts";
import { compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { bxAgo } from "@blast/core/lib/format.ts";
import { EASE_OUT, T1, T3 } from "#web/components/blast-ui/motion-tokens.ts";
import { prefersReducedMotion, useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { useFeelSound } from "#web/components/blast-feel/FeelProvider.tsx";
import { formatAmountShort, formatTime } from "../coin/coin-format.ts";
import { useLatestActivityTrade } from "../activity/wallet-trades.tsx";
import { dustQuoteUsd, isTradeUnderDollar } from "../activity/small-trades.ts";
import { ChartTradeContext, type ChartTradeCue, type TradePlacement } from "./chart-trade-context.ts";
import { useCoinPriceCurrency } from "./CoinPriceCurrency.tsx";
import { useChartClock } from "./use-chart-clock.ts";
import styles from "./ChartLastTrade.module.css";

const FADE_OUT_START_MS = 1_000;
const CUE_DURATION_MS = FADE_OUT_START_MS + T3;
const MAX_QUOTE_ATOMS = BigInt("18446744073709551615"); // On-chain coin amounts are u64.

type LastTrade = Pick<ChartTradeCue, "timestampMs" | "side" | "quoteAmount">;

/** An accepted stream trade or the latest trade from activity history. */
export function ChartLastTrade({ placement = "chart", playSound = false }: Readonly<{
  placement?: TradePlacement;
  playSound?: boolean;
}> = {}) {
  const source = useContext(ChartTradeContext);
  const history = useLatestActivityTrade();
  const currency = useCoinPriceCurrency();
  if (!source || (source.placement ?? "chart") !== placement) return null;
  // Dust never becomes the Last-trade pill, as the trades list hides it. A pool's
  // stream trade is checked here; a feed's trade (no pool) was picked past dust.
  const observed = source.trade && (source.poolKey === null || !isTradeUnderDollar({
    usd: source.tradeUsd, quote: source.trade.quoteAmount, decimals: source.decimals,
    quoteUsd: dustQuoteUsd(source.quoteType, currency),
  })) ? source.trade : null;
  const trade = latestTrade(history, observed);
  const cue = trade === observed && source.receivedAt !== null ? observed : null;
  const largeBuy = placement === "headline" && isLargeBuy(cue, source, currency);
  return <LastTradeSlot trade={trade} cue={cue} decimals={source.decimals} symbol={source.symbol}
    placement={placement} playSound={playSound} largeBuy={largeBuy} />;
}

function latestTrade(history: ReturnType<typeof useLatestActivityTrade>, observed: ChartTradeCue | null): LastTrade | null {
  if (!history || (observed && compareEventCursors(history.position, observed.cursor) <= 0)) return observed;
  return {
    timestampMs: history.timestampMs,
    side: history.kind === "curve_buy" || history.kind === "venue_buy" ? "buy" : "sell",
    quoteAmount: history.amounts.quote!,
  };
}

function isLargeBuy(cue: ChartTradeCue | null, source: Readonly<{ quoteType?: string | null; tradeUsd?: string | null; decimals: number | null }>, currency: ReturnType<typeof useCoinPriceCurrency>) {
  if (cue?.side !== "buy") return false;
  const quote = source.quoteType ? createQuoteOf(source.quoteType) : null;
  if (quote?.symbol === "TEST_SUI") return false;
  const recordedUsd = exactDecimal(source.tradeUsd);
  if (recordedUsd) return atLeastPow10(recordedUsd, 3);
  if (!quote || !currency?.quoteType || quote.quote_type !== createQuoteOf(currency.quoteType)?.quote_type) return false;
  const amount = exactAtoms(cue.quoteAmount, source.decimals);
  const rate = exactDecimal(currency.rate);
  return amount !== null && rate !== null && atLeastPow10(multiplyExact(amount, rate), 3);
}

function LastTradeSlot({ trade, cue, decimals, symbol, placement, playSound, largeBuy }: Readonly<{
  trade: LastTrade | null;
  cue: ChartTradeCue | null;
  decimals: number | null;
  symbol: string;
  placement: TradePlacement;
  playSound: boolean;
  largeBuy: boolean;
}>) {
  const { amountsHidden } = useShellPrefs();
  const headline = placement === "headline";
  // Reserve the same number of lines for every trade size in this quote currency.
  const widthSample = useMemo(() => {
    if (decimals == null) return "Sell";
    const digits = Math.max(formatAmountShort(MAX_QUOTE_ATOMS, decimals).length, formatAmountShort(BigInt(1), decimals).length);
    const side = headline ? "Large buy" : "Sell";
    return `${side} · ${"8".repeat(digits)} ${symbol}`;
  }, [decimals, headline, symbol]);
  const fill = useTradeFill(cue, trade?.side, headline);
  const highlight = largeBuy && !amountsHidden;
  const status = useTradeNotice(headline ? cue : null, playSound, highlight);
  return <div className={styles.slot} data-chart-last-trade={placement} data-idle={!trade || undefined}>
    <span className={styles.label} data-idle={!trade || undefined}>Last trade{trade && <> <TradeAge at={trade.timestampMs} /></>}</span>
    <span aria-hidden="true" className={styles.measure} data-width-sample={widthSample} />
    {trade && <LastTradeValue trade={trade} decimals={decimals} symbol={symbol} hidden={amountsHidden} highlight={highlight} fill={fill} />}
    {headline && <span className="sr-only" role="status" ref={status} />}
  </div>;
}

function LastTradeValue({ trade, decimals, symbol, hidden, highlight, fill }: Readonly<{
  trade: LastTrade; decimals: number | null; symbol: string; hidden: boolean; highlight: boolean;
  fill: RefObject<HTMLSpanElement | null>;
}>) {
  const side = trade.side === "sell" ? "Sell" : highlight ? "Large buy" : "Buy";
  const amount = decimals === null ? null : hidden ? HIDDEN_AMOUNT : formatAmountShort(trade.quoteAmount, decimals) + " " + symbol;
  return <span className={styles.value} data-trade-cue={trade.side}>
    <span aria-hidden="true" className={styles.fill} ref={fill} />
    <span className={styles.text}>{side}{amount === null ? null : " · " + amount}</span>
  </span>;
}

function useTradeNotice(cue: ChartTradeCue | null, playSound: boolean, largeBuy: boolean) {
  const status = useRef<HTMLSpanElement>(null);
  const seenCursor = useRef(cue?.cursor);
  const lastAnnouncement = useRef(-Infinity);
  const { play } = useFeelSound();

  useEffect(() => {
    if (!cue || (seenCursor.current && compareEventCursors(cue.cursor, seenCursor.current) <= 0)) return;
    seenCursor.current = cue.cursor;
    if (document.visibilityState === "hidden") return;
    const buy = cue.side === "buy";
    if (playSound) play({ kind: buy ? "curve-buy" : "curve-sell" });
    const now = performance.now();
    if (!status.current || now - lastAnnouncement.current < CUE_DURATION_MS) return;
    lastAnnouncement.current = now;
    status.current.textContent = buy ? (largeBuy ? "New large buy" : "New buy") : "New sell";
  }, [cue, play, playSound, largeBuy]);

  return status;
}

function useTradeFill(cue: ChartTradeCue | null, side: LastTrade["side"] | undefined, headline: boolean) {
  const fill = useRef<HTMLSpanElement>(null);
  const animation = useRef<Animation | null>(null);
  // A retained cursor can supply the text on mount without replaying its animation.
  const seenCursor = useRef(cue?.cursor);
  const lastArrival = useRef(-Infinity);
  const cursor = cue?.cursor;

  useLayoutEffect(() => {
    const layer = fill.current;
    if (!layer?.animate || prefersReducedMotion()) return;
    const current = animation.current;
    if (current && layer.dataset.fillSide !== side) {
      const opacity = Number(getComputedStyle(layer).opacity);
      current.cancel();
      animation.current = null;
      if (opacity > 0) layer.animate([{ opacity, easing: EASE_OUT }, { opacity: 0 }], { duration: T1 });
    }
    if (!cursor || !side || (seenCursor.current && compareEventCursors(cursor, seenCursor.current) <= 0)) return;
    seenCursor.current = cursor;
    if (document.visibilityState === "hidden") return;
    const now = performance.now();
    const quiet = now - lastArrival.current >= CUE_DURATION_MS;
    lastArrival.current = now;
    if (!quiet) return;
    layer.dataset.fillSide = side;
    animation.current = layer.animate([
      { opacity: 0, easing: EASE_OUT, ...(headline && { transform: "scale(.96)" }) },
      { opacity: 1, offset: T1 / CUE_DURATION_MS, ...(headline && { transform: "scale(1)" }) },
      { opacity: 1, offset: FADE_OUT_START_MS / CUE_DURATION_MS, easing: EASE_OUT },
      { opacity: 0 },
    ], { duration: CUE_DURATION_MS });
  }, [cursor, headline, side]);

  return fill;
}

function TradeAge({ at }: Readonly<{ at: number }>) {
  const now = useChartClock(1_000, true);
  const age = now === null ? null : bxAgo(at, now);
  return <time className={styles.age} dateTime={new Date(at).toISOString()} title={formatTime(at)}>
    <span>{age === "now" ? "just now" : age && `${age} ago`}</span>
  </time>;
}
