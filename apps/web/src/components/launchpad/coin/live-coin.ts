import { useEffect, useState } from "react";

import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";

import { tabMarketStream, type MarketStreamListener, type MarketStreamState } from "../market-stream-hub.ts";

/** A screen that has not been live this long says it is reconnecting. */
export const LIVE_STALE_MS = 10_000;

/** A coin's header numbers from its latest `coin_stats` frame; each is null when the frame leaves it out. */
export type LiveCoinStats = Readonly<{
  poolKey: string;
  checkpoint: number;
  lifecycle: string | null;
  holders: number | null;
  fdvUsd: string | null;
  volumeUsd: string | null;
  /** The market cap's move over 24 hours, in basis points. */
  changeBps: number | null;
}>;

const DECIMAL = /^-?\d+(\.\d+)?$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function decimal(value: unknown): string | null {
  return typeof value === "string" && value.length <= 80 && DECIMAL.test(value) ? value : null;
}

/** A whole number the frame sends as text, such as `"-2124"`. */
function signed(value: unknown): number | null {
  return typeof value === "string" && /^-?\d{1,12}$/.test(value) ? Number(value) : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The figures of a `coin_stats` frame (protocol.md section 4); null when it is not one. */
export function liveCoinStats(value: unknown): LiveCoinStats | null {
  const frame = record(value);
  const checkpoint = count(frame?.checkpoint);
  if (!frame || frame.type !== "coin_stats" || typeof frame.pool_key !== "string" || checkpoint === null) return null;
  return {
    poolKey: frame.pool_key,
    checkpoint,
    lifecycle: typeof frame.lifecycle === "string" ? frame.lifecycle : null,
    holders: count(frame.holders),
    fdvUsd: decimal(record(frame.market)?.fdv_usd),
    volumeUsd: decimal(record(frame.window_24h)?.volume_usd),
    changeBps: signed(record(frame.market)?.change_24h_bps),
  };
}

/** `next` unless `current` is newer: stats are state, the newest checkpoint wins. */
export function newerStats(current: LiveCoinStats | null, next: LiveCoinStats): LiveCoinStats {
  return current && current.checkpoint > next.checkpoint ? current : next;
}

/** Stats newer than a server read answered at `checkpoint`; null keeps the read. */
export function statsAfterRead(stats: LiveCoinStats | null, checkpoint: number | null): LiveCoinStats | null {
  return stats && (checkpoint === null || stats.checkpoint > checkpoint) ? stats : null;
}

/**
 * Whether a screen should say it is reconnecting: the stream has not been live for `LIVE_STALE_MS`.
 * A hidden tab (`paused`) or a market the stream does not serve (`unavailable`) is not reconnecting.
 */
export function reconnecting(state: MarketStreamState | null, since: number, now: number): boolean {
  return (state === "connecting" || state === "reconnecting") && now - since >= LIVE_STALE_MS;
}

export type LiveCoin = Readonly<{
  stats: LiveCoinStats | null;
  /** The stream is live on the chart's pool: its lists need no timer. */
  live: boolean;
  reconnecting: boolean;
}>;

const IDLE: LiveCoin = { stats: null, live: false, reconnecting: false };

/**
 * One coin's live header: joins the tab's market stream for `pools` (the screen's own pools, so the
 * stream does not widen) and keeps the latest `coin_stats` and the state of `pool` (the chart's pool,
 * first of `pools` by default). `stats` arrives once the hub relays `coin_stats` frames; until then
 * the screen keeps its read.
 */
export function useLiveCoin(request: Readonly<{
  coin: string | null;
  pools: readonly string[];
  pool?: string;
  expected: ExpectedDeployment | null;
  enabled: boolean;
}>): LiveCoin {
  const { coin, expected, enabled } = request;
  const poolList = request.pools.join(",");
  const watched = request.pool ?? request.pools[0];
  const [shown, setShown] = useState<Readonly<{ key: string; value: LiveCoin }> | null>(null);
  const key = `${coin}:${poolList}:${watched}:${expected?.network}:${expected?.deployment}`;
  useEffect(() => {
    const hub = enabled && coin && poolList ? tabMarketStream() : null;
    if (!hub || !coin) return;
    let state: MarketStreamState | null = null;
    let since = Date.now();
    let stats: LiveCoinStats | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const publish = () => setShown({ key, value: { stats, live: state === "live", reconnecting: reconnecting(state, since, Date.now()) } });
    // Typed apart so the `stats` listener compiles before and after the hub names it.
    const listener: MarketStreamListener & { stats?: (frame: unknown) => void } = {
      state: () => {},
      // One pool's state: the other pool may recover or wait for a slot without the header saying so.
      pool: (poolKey, next) => {
        if (poolKey !== watched || next === state) return;
        // The stale clock starts when the stream begins (re)connecting, from live, paused or unavailable alike.
        if (state !== "connecting" && state !== "reconnecting") since = Date.now();
        state = next;
        if (timer) clearTimeout(timer);
        timer = next === "connecting" || next === "reconnecting" ? setTimeout(publish, Math.max(0, since + LIVE_STALE_MS - Date.now())) : null;
        publish();
      },
      stats: (frame) => {
        const next = liveCoinStats(frame);
        if (!next) return;
        stats = newerStats(stats, next);
        publish();
      },
    };
    const subscription = hub.subscribe({ pools: poolList.split(","), expected, coin, listener });
    return () => {
      if (timer) clearTimeout(timer);
      subscription.stop();
    };
    // `expected` is keyed by its network and deployment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return enabled && shown?.key === key ? shown.value : IDLE;
}
