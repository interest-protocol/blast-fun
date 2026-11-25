"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChartBackfillRequired, type ChartFrame } from "#web/components/launchpad/chart/chart-live-model.ts";
import { tabMarketStream, type MarketStreamHub, type MarketStreamState } from "#web/components/launchpad/market-stream-hub.ts";
import { useQuoteUsd } from "#web/components/social/prices/use-quote-usd.ts";
import { useWorkspaceLiveClock } from "../live-clock";
import { applyMarketFrame, estimateUsdPrice, tradeQuote, type MarketCoinHistory, type TradeQuote } from "./coin-market-history";

/** The chart reads that stream: the market service's candles of a coin or of a sale's pool. */
export type StreamedChart = MarketCoinHistory;

/** The newest trade the stream carried for the coin's pool, with what prices it in USD. */
type StreamedTrade = Readonly<{ checkpoint: number; timestampMs: number; price: string; quote: TradeQuote | null }>;
/**
 * `frames` move the candles. `floor` is the newest checkpoint a read had shown when they were pruned:
 * a read older than it misses trades.
 */
type Stream = Readonly<{ poolKey: string; state: MarketStreamState | null; fence: number | null; floor: number; frames: readonly ChartFrame[]; trade: StreamedTrade | null }>;

/** The header's price from the stream: newer than the coin read once `observedAt` passes its observation. */
export type StreamedPrice = Readonly<{ usd: string; observedAt: number; checkpoint: number; paused: boolean }>;

/** Frames held past the shown history before the stream is restarted; a read every 30 s keeps far fewer. */
const MAX_FRAMES = 512;
/** First wait before reading history again when it does not reach the stream; doubles to 30 s. */
const BEHIND_MS = 1_000;

/**
 * The focused coin's candles and header price from the tab's market stream hub (the coin page's
 * `ChartStream` rules): frames after the stream's fence go on
 * top of the last history read that reaches it; a frame that needs history, or a read behind the
 * fence, asks `refresh` for another read. `live` is true while the hub is live for the coin's pool:
 * its polls may then slow to 30 s.
 */
export function useMarketStream(
  coinType: string,
  history: StreamedChart | null,
  enabled: boolean,
  refresh: () => void,
  hub?: MarketStreamHub | null,
) {
  const target = useChartStreamTarget(coinType, history, enabled);
  const [stream, setStream] = useState<Stream | null>(null);
  // Listeners read the newest history without resubscribing on each read. An empty read keeps the last
  // one: a venue pool's candle frames are checked against its migration, and null would fail them.
  const latest = useRef(history);
  useEffect(() => {
    if (history) latest.current = history;
  }, [history]);

  useEffect(() => {
    if (!target) return;
    const source = hub === undefined ? tabMarketStream() : hub;
    if (!source) return;
    let frames: ChartFrame[] = [];
    // The newest checkpoint a read has shown; a later read that answers older does not bring pruned frames back.
    let shown = 0;
    const update = (change: (stream: Stream) => Partial<Stream>) =>
      setStream((previous) => {
        const current = previous?.poolKey === target ? previous : { poolKey: target, state: null, fence: null, floor: 0, frames: [], trade: null };
        return { ...current, ...change(current) };
      });
    const subscription = source.subscribe({
      pools: [target],
      // The hub serves one `expected` per tab; Blast mode's Trades list subscribes with null, so this does too.
      expected: null,
      // Screens that only watch this coin (its Trades list) follow the stream from its first frame.
      coin: coinType,
      migration: () => latest.current?.page.migration ?? null,
      listener: {
        // Out of live, the candles keep the frames they had (the header shows "Updates paused");
        // the next fence replaces them.
        state: (state) => update(() => ({ state })),
        fence: (_, checkpoint) => {
          frames = [];
          update(() => ({ fence: checkpoint, frames }));
        },
        frame: (frame) => {
          shown = Math.max(shown, latest.current?.provenance.checkpoint ?? 0);
          frames = [...frames.filter((item) => item.checkpoint > shown), frame];
          if (frames.length > MAX_FRAMES) {
            frames = [];
            subscription.restart();
            return;
          }
          update(() => ({ frames, floor: shown }));
        },
        trade: ({ trade, checkpoint, summary }) => {
          if (trade.kind === "opening_round_fill") return;
          const { price } = trade;
          if (price === null) return;
          const quote = tradeQuote(summary);
          update(() => ({ trade: { checkpoint, timestampMs: trade.timestampMs, price, quote } }));
        },
      },
    });
    return () => {
      subscription.stop();
      setStream(null);
    };
  }, [target, coinType, hub]);

  const current = stream?.poolKey === target ? stream : null;
  const live = current?.state === "live";
  const view = useMemo(() => streamedHistory(history, current), [history, current]);

  // History that does not reach the stream is read again, sooner at first, as the coin page does.
  const clock = useWorkspaceLiveClock();
  const attempts = useRef(0);
  const behind = view.behind;
  useEffect(() => {
    if (!behind) {
      attempts.current = 0;
      return;
    }
    // Each read that is still behind waits twice as long; frames arriving meanwhile do not reset it.
    const timer = clock.after(refresh, Math.min(30_000, BEHIND_MS * 2 ** attempts.current++));
    return () => clock.clear(timer);
  }, [behind, history, refresh, clock]);

  const price = useStreamedPrice(current?.trade ?? null, live);
  return { live, history: view.history, price };
}

function useChartStreamTarget(coinType: string, history: StreamedChart | null, enabled: boolean) {
  // The coin's pool outlives each read: a window change or a failed poll empties the read, not the stream.
  const [known, setKnown] = useState<Readonly<{ coinType: string; poolKey: string }> | null>(null);
  const pool = history?.poolKey ?? null;
  if (history && pool && history.coin_type === coinType && (known?.coinType !== coinType || known.poolKey !== pool)) {
    setKnown({ coinType, poolKey: pool });
  }
  return enabled && known?.coinType === coinType ? known.poolKey : null;
}

function useStreamedPrice(trade: StreamedTrade | null, live: boolean): StreamedPrice | null {
  const quoteUsd = useQuoteUsd(trade && !trade.quote?.quoteUsd ? (trade.quote?.quote ?? null) : null);
  return useMemo((): StreamedPrice | null => {
    if (!trade?.quote) return null;
    const { memeDecimals, quoteDecimals } = trade.quote;
    const usd = trade.quote.quoteUsd ?? quoteUsd;
    // The pool's price after the trade is the catalog's mark; the fill's own price stands in without it.
    const estimate = usd === null ? null : estimateUsdPrice(trade.quote.price ?? trade.price, memeDecimals, quoteDecimals, usd);
    return estimate === null ? null : { usd: estimate, observedAt: trade.timestampMs, checkpoint: trade.checkpoint, paused: !live };
  }, [trade, quoteUsd, live]);
}

/** The history with the stream's frames on top; `behind` when only a newer read can continue it. */
export function streamedHistory(
  history: StreamedChart | null,
  stream: Pick<Stream, "fence" | "floor" | "frames"> | null,
): Readonly<{ history: StreamedChart | null; behind: boolean }> {
  const poolKey = history?.poolKey;
  if (!history || !poolKey || !stream || stream.fence === null) return { history, behind: false };
  const shown = history.provenance.checkpoint;
  // Older than the fence, or than a read whose trades were pruned: only a newer read continues it.
  if (shown === null || shown < stream.fence || shown < stream.floor) return { history, behind: true };
  return streamedFrames({ ...history, poolKey }, stream.frames, shown);
}

/** Market candles with the frames past `shown` on top; `behind` at the first frame only history can continue. */
function streamedFrames(
  history: MarketCoinHistory & Readonly<{ poolKey: string }>,
  frames: readonly ChartFrame[],
  shown: number,
): Readonly<{ history: MarketCoinHistory; behind: boolean }> {
  let next: MarketCoinHistory = history;
  for (const frame of frames) {
    if (frame.checkpoint <= shown) continue;
    try {
      next = applyMarketFrame({ ...next, poolKey: history.poolKey }, frame);
    } catch (error) {
      // A gap, a lifecycle change or a migration: the candles wait for history past this frame.
      if (error instanceof ChartBackfillRequired) return { history: next, behind: true };
      throw error;
    }
  }
  return { history: next, behind: false };
}
