"use client";

import { createContext, useContext, useState } from "react";
import { compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import type { CandleTrade } from "#web/components/charts/candle-trade.ts";
import { useLatestActivityTrade } from "../activity/wallet-trades.tsx";
import type { MarketTrade } from "../market-stream-hub.ts";

export type ChartTrade = Pick<MarketTrade["trade"], "cursor" | "timestampMs" | "side" | "quoteAmount" | "memeAmount" | "price">;

export type ChartTradeCue = Pick<ChartTrade, "cursor" | "timestampMs" | "side" | "quoteAmount">;

export type TradePlacement = "chart" | "headline";

type ChartTradeSource = Readonly<{
  /** Null for trades known through catch-up or a retained market read. */
  receivedAt: number | null;
  decimals: number | null;
  symbol: string;
  quoteType?: string | null;
  tradeUsd?: string | null;
  placement?: TradePlacement;
}> & (
  | Readonly<{ poolKey: string; trade: ChartTrade | null }>
  | Readonly<{ poolKey: null; trade: ChartTradeCue | null }>
);

export const ChartTradeContext = createContext<ChartTradeSource | null>(null);
export const PoolCandleTradeContext = createContext<CandleTrade | null>(null);

/** Only an arrival while this chart is open can be projected. A retained trade stays historical. */
export function useCandleTrade(): CandleTrade | null {
  const source = useContext(ChartTradeContext);
  const poolTrade = useContext(PoolCandleTradeContext);
  const history = useLatestActivityTrade();
  const cursor = poolTrade?.trade.cursor ?? source?.trade?.cursor;
  const [retained] = useState(cursor);
  if (cursor === retained) return null;
  if (poolTrade) return poolTrade;
  if (!source?.trade || source.poolKey === null || source.receivedAt === null) return null;
  if (history && compareEventCursors(history.position, source.trade.cursor) > 0) return null;
  return { trade: source.trade, poolKey: source.poolKey, receivedAt: source.receivedAt };
}
