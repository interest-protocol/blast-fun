import { useEffect, useState } from "react";

import { parseCount } from "@blast/core/modules/launchpad-contract/decimal.ts";
import { parseWindow, type TradeWindow } from "@blast/core/modules/launchpad-contract/coin.ts";

import { tabMarketStream, type MarketTrade } from "./market-stream-hub.ts";

/**
 * The figures a trade frame's pool summary carries, as of that trade. `holders` is the coin's count as
 * of the transaction before the trade (blast-infra sends the trade's own balances in a later message
 * this stream does not relay), so it is never older than a read at an earlier checkpoint. `day` is the
 * pool's 24 h window: the coin's only while the coin trades on that one pool.
 */
export type TradeFigures = Readonly<{
  poolKey: string;
  checkpoint: number;
  holders: number | null;
  day: TradeWindow | null;
}>;

function field<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** The figures of a frame's summary; the frame arrives unvalidated, so each figure is null when malformed. */
export function tradeFigures(trade: MarketTrade): TradeFigures {
  const summary = trade.summary !== null && typeof trade.summary === "object" ? (trade.summary as Record<string, unknown>) : {};
  const windows = summary.windows !== null && typeof summary.windows === "object" ? (summary.windows as Record<string, unknown>) : {};
  return {
    poolKey: trade.poolKey,
    checkpoint: trade.checkpoint,
    holders: field(() => parseCount(summary.holders, "summary.holders")),
    day: field(() => parseWindow(windows["24h"], "summary.windows.24h")),
  };
}

/**
 * `latest` when it is newer than a read answered at `checkpoint`, else null: a streamed figure never
 * shows behind the read it replaces. A null checkpoint (no read yet) takes `latest`.
 */
export function newerThanRead(latest: TradeFigures | null, checkpoint: number | null): TradeFigures | null {
  return latest && (checkpoint === null || latest.checkpoint > checkpoint) ? latest : null;
}

/** The figures' 24 h window as the coin's: only while the coin trades on that one pool, else null. */
export function coinDay(figures: TradeFigures | null, pools: readonly string[]): TradeWindow | null {
  return figures && pools.length === 1 && pools[0] === figures.poolKey ? figures.day : null;
}

/**
 * The newest trade figures for `coinType` the tab's market stream carries; null before the first. It
 * never opens a stream: it follows the chart's. Callers show them only when newer than their own read
 * (`newerThanRead`).
 */
export function useTradeFigures(coinType: string | null): TradeFigures | null {
  const [shown, setShown] = useState<Readonly<{ coinType: string; figures: TradeFigures }> | null>(null);
  useEffect(() => {
    const hub = coinType ? tabMarketStream() : null;
    if (!hub || !coinType) return;
    return hub.observe(coinType, {
      live: () => {},
      trade: (trade) => {
        const figures = tradeFigures(trade);
        setShown((current) => (current?.coinType === coinType && current.figures.checkpoint > figures.checkpoint ? current : { coinType, figures }));
      },
    });
  }, [coinType]);
  // Another coin's figures never show, even for the render before its effect runs.
  return shown && shown.coinType === coinType ? shown.figures : null;
}
