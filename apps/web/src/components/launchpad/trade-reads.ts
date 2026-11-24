import { useEffect, useEffectEvent } from "react";

import { tabMarketStream, type CoinTradeListener, type MarketTrade } from "./market-stream-hub.ts";

/** A trade read waits this long after the first trade it answers, so a burst of trades costs one read. */
export const TRADE_READ_FLOOR_MS = 5_000;
/** Up to this much more, so tabs that saw the same trade spread their reads over the edge cache. */
export const TRADE_READ_SPREAD_MS = 1_000;
/** The fallback poll waits up to this share longer, so tabs that loaded together drift apart (`spreadMs`). */
const FALLBACK_SPREAD = 0.2;

export type TradeReadsOptions = Readonly<{
  /** Reads start at least this far apart, however many trades arrive. */
  minGapMs: number;
  /** The fallback poll while the stream is live on this coin (quiet market) or not; null polls never. */
  fallbackMs: (live: boolean) => number | null;
  /** Read once at start (when visible); false when the owner reads on its own at start. */
  initial: boolean;
  /** Which trades call for a read; every trade when omitted. */
  accept?: (trade: MarketTrade) => boolean;
  /** One read, pinned to `at` (the newest trade's checkpoint) or the latest when null. */
  read: (at: number | null) => void;
}>;

export type TradeReadsDependencies = Readonly<{
  /** Follows a coin's trades on the tab's stream (`MarketStreamHub.observe`); null without a stream. */
  observe: ((listener: CoinTradeListener) => () => void) | null;
  now: () => number;
  schedule: (run: () => void, ms: number) => () => void;
  random: () => number;
  visible: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
}>;

/**
 * Re-reads one coin's figures when its trades arrive instead of on a timer: one read per burst, pinned
 * to the newest trade's checkpoint, no closer than `minGapMs` to the last. A slower poll covers what
 * the stream cannot show (another pool, a lagging indexer, no stream at all). Nothing is read while
 * the tab is hidden; a trade seen then is read when it shows again.
 */
export class TradeReads {
  private readonly options: TradeReadsOptions;
  private readonly deps: TradeReadsDependencies;
  private live = false;
  private lastRead = Number.NEGATIVE_INFINITY;
  private pendingAt: number | null = null;
  private cancelTrade: (() => void) | null = null;
  private cancelFallback: (() => void) | null = null;
  private stopObserving: (() => void) | null = null;
  private stopVisibility: (() => void) | null = null;
  private stopped = false;

  constructor(options: TradeReadsOptions, deps: TradeReadsDependencies) {
    this.options = options;
    this.deps = deps;
  }

  start(): void {
    this.stopVisibility = this.deps.onVisibilityChange(() => this.visibility());
    this.stopObserving = this.deps.observe?.({ live: (live) => this.liveChanged(live), trade: (trade) => this.trade(trade) }) ?? null;
    if (this.options.initial && this.deps.visible()) return this.readNow();
    // Without an initial read the owner has just read: the pace starts now.
    if (!this.options.initial) this.lastRead = this.deps.now();
    this.armFallback();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTrade?.();
    this.cancelFallback?.();
    this.stopObserving?.();
    this.stopVisibility?.();
    this.cancelTrade = this.cancelFallback = this.stopObserving = this.stopVisibility = null;
  }

  private trade(trade: MarketTrade): void {
    if (this.stopped || (this.options.accept && !this.options.accept(trade))) return;
    this.pendingAt = Math.max(this.pendingAt ?? 0, trade.checkpoint);
    if (!this.cancelTrade && this.deps.visible()) this.armTrade();
  }

  private armTrade(): void {
    const wait = Math.max(TRADE_READ_FLOOR_MS, this.lastRead + this.options.minGapMs - this.deps.now());
    this.cancelTrade = this.deps.schedule(() => {
      this.cancelTrade = null;
      if (this.deps.visible()) this.readNow();
    }, Math.round(wait + this.deps.random() * TRADE_READ_SPREAD_MS));
  }

  /** Reads now, pinned to the newest pending trade if there is one, and restarts the fallback poll. */
  private readNow(): void {
    const at = this.pendingAt;
    this.pendingAt = null;
    this.cancelTrade?.();
    this.cancelTrade = null;
    this.lastRead = this.deps.now();
    this.options.read(at);
    if (!this.stopped) this.armFallback();
  }

  private armFallback(): void {
    this.cancelFallback?.();
    this.cancelFallback = null;
    const every = this.options.fallbackMs(this.live);
    if (every === null || !this.deps.visible()) return;
    const due = Math.max(0, Math.min(every, this.lastRead + every - this.deps.now()));
    const wait = Math.round(due + every * FALLBACK_SPREAD * this.deps.random());
    this.cancelFallback = this.deps.schedule(() => {
      this.cancelFallback = null;
      if (this.deps.visible()) this.readNow();
    }, wait);
  }

  private liveChanged(live: boolean): void {
    if (this.stopped || live === this.live) return;
    this.live = live;
    this.armFallback();
  }

  private visibility(): void {
    if (this.stopped) return;
    if (!this.deps.visible()) {
      this.cancelTrade?.();
      this.cancelFallback?.();
      this.cancelTrade = this.cancelFallback = null;
      return;
    }
    const every = this.options.fallbackMs(this.live);
    const due = this.pendingAt !== null ? this.options.minGapMs : every;
    // Back after a long hide (or with trades it missed): read now; after a quick flip, keep the pace.
    if (due !== null && this.deps.now() - this.lastRead >= due) return this.readNow();
    if (this.pendingAt !== null) this.armTrade();
    this.armFallback();
  }
}

function browserDependencies(coinType: string): TradeReadsDependencies {
  const hub = tabMarketStream();
  return {
    observe: hub ? (listener) => hub.observe(coinType, listener) : null,
    now: Date.now,
    schedule: (run, ms) => {
      const timer = window.setTimeout(run, ms);
      return () => window.clearTimeout(timer);
    },
    random: Math.random,
    visible: () => document.visibilityState === "visible",
    onVisibilityChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

/**
 * `TradeReads` for one coin while mounted; it restarts when the coin changes. The browser never talks
 * to blast-infra: `read` goes through this app's routes, pinned with `atCheckpoint`.
 */
export function useTradeReads(options: Readonly<{
  /** Null reads nothing. */
  coinType: string | null;
  minGapMs: number;
  /** Fallback poll for a live (quiet) stream and for no stream; null polls never. */
  fallbackMs: Readonly<{ live: number | null; idle: number | null }>;
  initial: boolean;
  accept?: (trade: MarketTrade) => boolean;
  read: (at: number | null) => void;
}>): void {
  const { coinType, minGapMs, initial } = options;
  const { live: liveMs, idle: idleMs } = options.fallbackMs;
  const read = useEffectEvent((at: number | null) => options.read(at));
  const accept = useEffectEvent((trade: MarketTrade) => options.accept?.(trade) ?? true);
  useEffect(() => {
    if (coinType === null) return;
    const reads = new TradeReads(
      { minGapMs, initial, fallbackMs: (live) => (live ? liveMs : idleMs), accept: (trade) => accept(trade), read: (at) => read(at) },
      browserDependencies(coinType),
    );
    reads.start();
    return () => reads.stop();
  }, [coinType, minGapMs, initial, liveMs, idleMs]);
}
