import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useFeelSound } from "#web/components/blast-feel/FeelProvider.tsx";
import { MIGRATOR_POOL_KEY } from "@blast/core/modules/launchpad-contract/venues.ts";
import { compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { launchProgressBps, parseLaunchSummary } from "@blast/core/modules/launchpad-contract/discovery.ts";
import { tabMarketStream, type MarketTrade } from "#web/components/launchpad/market-stream-hub.ts";

/** Venue figures come from the swap itself. Curve figures come from its post-trade launch summary. */
function readTrade(frame: MarketTrade, poolKey: string) {
  if (frame.poolKey !== poolKey) return null;
  if (MIGRATOR_POOL_KEY.test(poolKey)) {
    const { trade, checkpoint } = frame;
    if (trade.kind !== "swap" || trade.trader === null || trade.cursor.split(":")[0] !== String(checkpoint)) return null;
    return { trade, checkpoint, side: trade.side, economics: null, progress: null };
  }
  try {
    const launch = parseLaunchSummary(frame.summary);
    if (launch.poolKey !== poolKey || launch.lifecycle === "migrated") return null;
    const { kind, side } = frame.trade;
    const isUserTrade = kind === side || (kind === "pre_share_buy" && side === "buy");
    return {
      trade: frame.trade,
      side: isUserTrade ? side : null,
      checkpoint: frame.checkpoint,
      economics: launch.economics,
      progress: Number(launchProgressBps(launch)) / 100,
    };
  } catch {
    // Keep the last usable figures until the next trade or the page's regular read.
    return null;
  }
}

type CoinTrade = (NonNullable<ReturnType<typeof readTrade>> & { showCue: boolean; receivedAt: number; lastTrade: MarketTrade["trade"] | null }) | null;

/** The caller keys the card by curve and deployment. Observing the tab's stream opens no connection. */
export function useCoinTrade(coin: string | null, poolKey: string | null, checkpoint: number | null) {
  const { play } = useFeelSound();
  const [latest, setLatest] = useState<CoinTrade>(null);
  const live = useRef(false);
  const receive = useEffectEvent((frame: MarketTrade, activePool: string) => {
    if (checkpoint !== null && frame.checkpoint < checkpoint) return;
    // A venue snapshot already includes every swap at its checkpoint.
    if (frame.checkpoint === checkpoint && MIGRATOR_POOL_KEY.test(activePool)) return;
    const tick = readTrade(frame, activePool);
    if (tick) {
      const receivedAt = performance.now();
      const showCue = live.current;
      setLatest((prior) => {
        if (prior && compareEventCursors(prior.trade.cursor, tick.trade.cursor) >= 0) return prior;
        return {
          ...tick,
          showCue,
          receivedAt,
          lastTrade: tick.side ? tick.trade : prior?.lastTrade ?? null,
        };
      });
    }
  });
  useEffect(() => {
    const hub = tabMarketStream();
    if (!hub || !coin || !poolKey) return;
    const stop = hub.observe(coin, {
      // The card's own pool: a cue shows once its trades stream, whatever the coin's other pool does.
      live(connected, pools) {
        live.current = pools ? pools.get(poolKey) === "live" : connected;
        if (!live.current) setLatest((prior) => prior?.showCue ? { ...prior, showCue: false } : prior);
      },
      trade: (frame) => receive(frame, poolKey),
    });
    return () => stop();
  }, [coin, poolKey]);
  useEffect(() => {
    if (!latest?.showCue || !latest.side || document.visibilityState === "hidden") return;
    const kind = latest.side === "buy" ? "curve-buy" : "curve-sell";
    // Let the same trade's row and chart finish committing before sounding it.
    const frame = requestAnimationFrame(() => play({ kind }));
    const cancel = () => cancelAnimationFrame(frame);
    document.addEventListener("visibilitychange", cancel, { once: true });
    return () => {
      cancel();
      document.removeEventListener("visibilitychange", cancel);
    };
  }, [latest, play]);
  // A complete read at the same checkpoint includes even the last trade in that checkpoint.
  const tick = poolKey && latest && (checkpoint === null || latest.checkpoint > checkpoint) ? latest : null;
  const liveTrade = latest?.showCue && latest.side && (checkpoint === null || latest.checkpoint >= checkpoint);
  return { tick, lastTrade: latest?.lastTrade ?? null, receivedAt: liveTrade ? latest.receivedAt : null };
}
