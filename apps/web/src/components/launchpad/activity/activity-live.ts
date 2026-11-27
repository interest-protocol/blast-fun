// The Activity list's live rows: a trade frame from the tab's market stream
// becomes a provisional row until the next REST read answers for it.

import type { ActivityKind, ActivityRow, ActivitySource } from "@blast/core/modules/launchpad-contract/activity.ts";
import { MIGRATOR_POOL_KEY, type MigratorVenue } from "@blast/core/modules/launchpad-contract/venues.ts";
import type { PoolTrade } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";

import type { MarketStreamHub, MarketStreamState, MarketTrade } from "../market-stream-hub.ts";

/** Frame-triggered reads of one list: at most one per 5 s (the freshness floor), spread by up to 1 s. */
export const FRAME_READ_FLOOR_MS = 5_000;
export const FRAME_READ_SPREAD_MS = 1_000;
/** A read that keeps missing its checkpoint backs off to the live poll's pace. */
export const FRAME_READ_MAX_MS = 30_000;

const CURVE_KINDS: Readonly<Record<string, readonly [ActivityKind, ActivitySource, "buy" | "sell"]>> = {
  buy: ["curve_buy", "user", "buy"],
  pre_share_buy: ["curve_buy", "creator_pre_share", "buy"],
  sell: ["curve_sell", "user", "sell"],
};

/**
 * The classified row a trade frame stands for, or null when the frame cannot
 * say all of it. blast-infra builds a curve trade's row from the same trade
 * tape entry (`src/activity/mod.rs`: position = the trade's cursor, actor = its
 * `trader`, amounts = its `quote_amount` and `meme_amount`) and a venue swap's
 * row from the swap itself (`src/activity/store.rs`, source = the venue pool).
 * The opening round's pot buy and fills, a trade with no trader and any other
 * pool's trade are left to the REST read.
 */
export function provisionalActivityRow(launchId: string, frame: MarketTrade): ActivityRow | null {
  const { trade, poolKey } = frame;
  if (trade.trader === null || trade.cursor.split(":")[0] !== String(frame.checkpoint)) return null;
  if (poolKey === `blast_curve:${launchId}`) {
    const rule = CURVE_KINDS[trade.kind];
    if (!rule || rule[2] !== trade.side) return null;
    return tradeActivityRow(trade, rule[0], rule[1]);
  }
  if (!MIGRATOR_POOL_KEY.test(poolKey) || trade.kind !== "swap") return null;
  return venueTradeRow(trade, poolKey as VenuePoolKey);
}

export type VenuePoolKey = `${MigratorVenue}:0x${string}`;

export function venueTradeRow(trade: PoolTrade, pool: VenuePoolKey): ActivityRow {
  return tradeActivityRow(trade, trade.side === "buy" ? "venue_buy" : "venue_sell", pool);
}

function tradeActivityRow(trade: PoolTrade, kind: ActivityKind, source: ActivitySource): ActivityRow {
  return {
    position: trade.cursor,
    checkpoint: Number(trade.cursor.split(":")[0]),
    timestampMs: trade.timestampMs,
    digest: trade.digest,
    kind,
    source,
    actor: trade.trader,
    ...(trade.whale ? { labels: ["whale"] as const } : {}),
    ...(trade.volumeUsd === null ? {} : { volumeUsd: trade.volumeUsd }),
    lifecycle: null,
    amounts: { quote: trade.quoteAmount, meme: trade.memeAmount },
  };
}

/** What the live controller needs of the Activity feed. */
export type LiveActivityFeed = Readonly<{
  /** Adds a provisional row, shown until a first-page read answers for its checkpoint. */
  addLive: (row: ActivityRow) => boolean;
  /** The checkpoint the list's last first-page answer reflects; null before one. */
  readThrough: () => number | null;
  refresh: (manual: boolean, at?: number | null) => Promise<boolean>;
}>;

export type LiveTradesOptions = Readonly<{
  hub: Pick<MarketStreamHub, "subscribe">;
  launchId: string;
  pools: readonly string[];
  expected: ExpectedDeployment | null;
  feed: LiveActivityFeed;
  /** The compact live tape can evict old rows until the reader opens its detailed history. */
  recentOnly?: boolean;
  /** A row the shown list leaves out (dust under its filter): it takes no row and asks no read until `showHidden`. */
  hides?: (row: ActivityRow) => boolean;
  onState: (state: MarketStreamState) => void;
  schedule: (run: () => void, ms: number) => () => void;
  now: () => number;
  random: () => number;
}>;

/**
 * Feeds the list from the market stream. Each mapped trade is a provisional
 * row at once. A frame it cannot map, and each fence (a stream start or
 * reconnect, after which earlier trades never arrive as frames), asks for one
 * first-page read pinned to that checkpoint, coalesced to the newest and held
 * to the frame-read floor; a fence the list has already read through asks
 * nothing. A read that fails or answers behind its checkpoint is asked again,
 * the floor doubling each time up to `FRAME_READ_MAX_MS`. Before the list's
 * first answer a read waits a whole floor: the first poll usually answers it.
 */
export function followLiveTrades(options: LiveTradesOptions): (() => void) & Readonly<{
  showHidden: () => void;
  showHistory: (open: boolean) => void;
}> {
  const { feed } = options;
  let wanted: number | null = null;
  let hidden: number | null = null;
  let truncated: number | null = null;
  let newest: number | null = null;
  let keepHistory = !options.recentOnly;
  let lastRead = Number.NEGATIVE_INFINITY;
  let misses = 0;
  let cancel: (() => void) | null = null;
  let stopped = false;
  const reached = (checkpoint: number) => (feed.readThrough() ?? -1) >= checkpoint;
  const caughtUp = () => {
    misses = 0;
  };

  const read = () => {
    cancel = null;
    const at = wanted;
    wanted = null;
    if (stopped || at === null) return;
    if (reached(at)) return caughtUp();
    lastRead = options.now();
    const settled = (ok: boolean) => {
      if (stopped) return;
      // A read that names no checkpoint cannot be compared with the fence: it is taken as it is.
      if (reached(at) || (ok && feed.readThrough() === null)) return caughtUp();
      misses += 1;
      want(at);
    };
    void feed.refresh(false, at).then(settled, () => settled(false));
  };
  const want = (checkpoint: number) => {
    if (reached(checkpoint)) return;
    wanted = Math.max(wanted ?? checkpoint, checkpoint);
    if (cancel) return;
    const now = options.now();
    const floor = Math.min(FRAME_READ_FLOOR_MS * 2 ** misses, FRAME_READ_MAX_MS);
    const since = feed.readThrough() === null ? now : lastRead;
    const delay = Math.max(0, since + floor - now) + Math.round(options.random() * FRAME_READ_SPREAD_MS);
    cancel = options.schedule(read, delay);
  };

  const subscription = options.hub.subscribe({
    pools: options.pools,
    expected: options.expected,
    listener: {
      state: (state) => options.onState(state),
      fence: (_pool, checkpoint, detail) => {
        if (keepHistory || !detail?.tapeResumed) {
          want(checkpoint);
        } else {
          truncated = Math.max(truncated ?? checkpoint, checkpoint);
        }
      },
      trade: (frame) => {
        newest = Math.max(newest ?? frame.checkpoint, frame.checkpoint);
        const row = provisionalActivityRow(options.launchId, frame);
        if (row && options.hides?.(row)) {
          hidden = Math.max(hidden ?? row.checkpoint, row.checkpoint);
          return;
        }
        if (!row) {
          want(frame.checkpoint);
        } else if (feed.addLive(row)) {
          if (keepHistory) want(frame.checkpoint);
          else truncated = Math.max(truncated ?? frame.checkpoint, frame.checkpoint);
        }
      },
    },
  });
  const stop = () => {
    stopped = true;
    cancel?.();
    subscription.stop();
  };
  /** The list shows what it hid again: one read through the newest hidden trade, as a frame read. */
  const showHidden = () => {
    const at = hidden;
    hidden = null;
    if (at !== null) want(at);
  };
  const showHistory = (open: boolean) => {
    if (!options.recentOnly) return;
    keepHistory = open;
    const at = truncated ?? (feed.readThrough() === null ? newest : null);
    if (open && at !== null) {
      want(at);
      truncated = null;
    }
  };
  return Object.assign(stop, { showHidden, showHistory });
}
