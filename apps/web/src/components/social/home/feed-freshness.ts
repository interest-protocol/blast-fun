import { spreadMs } from "#web/lib/query/polling.ts";

/**
 * When a live read asks whether there is anything new (T-012, FEATURE-MAP
 * §2.3). A source signals "look now"; the reader then reads its route again,
 * at most once per `NEW_POSTS_MIN_GAP_MS`, and only while the tab is visible.
 * Nothing is rendered from a signal.
 *
 * Two sources exist. The poll looks every 30 s while the tab is visible and
 * at once when the tab becomes visible again. The blast-infra `activity` hint
 * (T-035, R3-26, `activity-hints.ts`) looks within a second of a new row: on
 * each hint, and on every connect and reconnect, since the topic has no
 * resume. `anyFreshness` combines them, so the poll stays the fallback while
 * the socket is down or unconfigured.
 *
 * A hint's signal carries `FreshnessHint`: when it arrived and why, never the
 * message. A reader's gate (`hintedGap`) keeps a hinted signal that lands
 * inside its 5 s floor and reads once the floor has passed, where a poll
 * signal there is dropped as it always was; so with no hint source every
 * reader behaves exactly as before.
 */

/**
 * Why a live source said "look now": a new row was hinted (`hint`), the
 * socket (re)connected, or blast-infra asked for a resync. The last two mean
 * hints may have been missed. `atMs` is when the browser learned it, which
 * times hint → refresh completion; this does not prove painted freshness. It carries nothing of the message beyond what
 * selects the reads it affects: a lifecycle row's sale and phase, or the coin
 * whose identity (name, symbol, description, icon) changed.
 */
export type FreshnessHint = Readonly<{
  atMs: number;
  cause: "hint" | "connect" | "resync";
  presaleId?: string;
  lifecycle?: string;
  coinType?: string;
  /** A trade row's selectors, and its quote atoms, quote coin and dollars when the hint carried them (Home's buy cue only). */
  trade?: Readonly<{ presaleId?: string; coinType?: string; checkpoint: number; cursor: string; kind?: "trade_buy" | "trade_sell"; actor?: string; quoteAtoms?: string; quoteType?: string; usd?: string }>;
  catchUp?: true;
  /** A `connect` after an earlier live socket in this tab: hints may have been missed. */
  reconnect?: true;
}>;

/** "Look now"; a live source passes why, the poll passes nothing. */
export type FreshnessSignal = (hint?: FreshnessHint) => void;

/** A source of "look now" signals; `subscribe` returns its unsubscribe. */
export type FeedFreshnessSource = Readonly<{
  name: string;
  subscribe(signal: FreshnessSignal): () => void;
  /**
   * Every new hint, uncoalesced and unfiltered, for a cue (Home's buy cue): never a read, never data.
   * Only a live hint source has it; it does not open the socket on its own.
   */
  hints?(listener: (hint: FreshnessHint) => void): () => void;
}>;

/** The poll interval without a live hint. */
export const NEW_POSTS_POLL_MS = 30_000;
/** The least time between two reads, whatever the signals. */
export const NEW_POSTS_MIN_GAP_MS = 5_000;

/** Browser operations shared by each polling subscription. */
export type FreshnessEnvironment = Readonly<{
  visible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}>;

export function browserFreshnessEnvironment(): FreshnessEnvironment {
  return {
    visible: () => document.visibilityState === "visible",
    onVisibilityChange(listener) {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    setInterval: (run, ms) => window.setInterval(run, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
  };
}

/**
 * Polls every `intervalMs` while the tab is visible; stops while it is
 * hidden; signals at once when it becomes visible again.
 */
export function pollingFreshness(intervalMs = NEW_POSTS_POLL_MS): FeedFreshnessSource {
  return {
    name: "poll",
    subscribe(signal) {
      const env = browserFreshnessEnvironment();
      let handle: unknown = null;
      const start = () => {
        if (handle === null) handle = env.setInterval(() => signal(), spreadMs(intervalMs, Date.now()));
      };
      const stop = () => {
        if (handle !== null) env.clearInterval(handle);
        handle = null;
      };
      if (env.visible()) start();
      const off = env.onVisibilityChange(() => {
        if (env.visible()) {
          start();
          signal();
        } else {
          stop();
        }
      });
      return () => {
        off();
        stop();
      };
    },
  };
}

/** Every source's signals, as one source. */
export function anyFreshness(...sources: readonly FeedFreshnessSource[]): FeedFreshnessSource {
  const all = (subscribe: (source: FeedFreshnessSource) => (() => void) | undefined) => {
    const offs = sources.map(subscribe);
    return () => {
      for (const off of offs) off?.();
    };
  };
  return {
    name: sources.map((source) => source.name).join("+"),
    subscribe: (signal) => all((source) => source.subscribe(signal)),
    ...(sources.some((source) => source.hints) ? { hints: (listener: (hint: FreshnessHint) => void) => all((source) => source.hints?.(listener)) } : {}),
  };
}

/**
 * A leading-edge gate: `allow(now)` is true at most once per `gapMs`. Three
 * signals within two seconds read once; one six seconds later reads again.
 */
export function minimumGap(gapMs = NEW_POSTS_MIN_GAP_MS) {
  let last = Number.NEGATIVE_INFINITY;
  return {
    allow(nowMs: number): boolean {
      if (nowMs - last < gapMs) return false;
      last = nowMs;
      return true;
    },
    /** Forgets the last read, so the next signal reads (after the reader caught up). */
    reset(): void {
      last = Number.NEGATIVE_INFINITY;
    },
    /** How long until `allow` would pass; 0 when it would now. */
    wait(nowMs: number): number {
      return Math.max(0, last + gapMs - nowMs);
    },
  };
}

/** The clock and timers a reader's gate waits on; tests pass a fake. */
export type GapTimers = Readonly<{
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}>;

export function browserGapTimers(): GapTimers {
  return {
    now: () => Date.now(),
    setTimeout: (run, ms) => window.setTimeout(run, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
}

/**
 * A reader's floor (`minimumGap`) that does not lose a hint (R3-26).
 * `admit(hint)` is whether to read now, and marks the read when it is. A
 * signal inside the gap is dropped when it carries no hint (the poll, exactly
 * as before); a hinted one is kept, and `retry` runs once with it when the gap
 * has passed, so a row hinted a second after a read is read seconds later
 * rather than at the next poll. Any read drops the kept hint: the row was
 * committed before its hint left blast-infra, so that read holds it. One hint
 * is kept at most, the earliest, which the hint → paint time counts from.
 */
export function hintedGap(gapMs: number, timers: GapTimers, retry: (hint: FreshnessHint) => void) {
  const gap = minimumGap(gapMs);
  let kept: { hint: FreshnessHint; handle: unknown } | null = null;
  const drop = () => {
    if (kept) timers.clearTimeout(kept.handle);
    kept = null;
  };
  return {
    admit(hint?: FreshnessHint): boolean {
      const now = timers.now();
      if (gap.allow(now)) {
        drop();
        return true;
      }
      if (hint && !kept) {
        const handle = timers.setTimeout(() => {
          const due = kept?.hint;
          kept = null;
          if (due) retry(due);
        }, gap.wait(now));
        kept = { hint, handle };
      }
      return false;
    },
    /** Forgets the last read and any kept hint. */
    reset(): void {
      drop();
      gap.reset();
    },
    /** Drops a kept hint and its timer (the reader unsubscribed). */
    cancel: drop,
  };
}
