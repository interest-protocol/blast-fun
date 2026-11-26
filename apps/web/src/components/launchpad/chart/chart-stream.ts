import type { Section } from "@blast/core/modules/launchpad-contract/section.ts";
import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import type { MigrationMarker, PoolCandlePage } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { WORKLOAD_ROUTES } from "@blast/core/modules/read-routing/resources.ts";

import { tabMarketStream, type MarketStreamHub, type MarketStreamState, type MarketStreamSubscription } from "../market-stream-hub.ts";
import type { ChartPoolRead } from "./chart-client.ts";
import { applyChartFrame, sameChartMigration, type ChartFrame } from "./chart-live-model.ts";
import { chartPriceRemaining, publishChartPrice, type ChartPriceUpdate } from "./chart-live-price.ts";
import type { ChartRequest } from "./chart-model.ts";

export type ChartStreamStatus = "connecting" | "streaming" | "recovering" | "reconnecting" | "unavailable" | "paused";
type Pool = {
  fence: number | null;
  /** The checkpoint a history read must reach to start the stream: after it, every pool event arrives as a frame. */
  reach: number | null;
  cutoff: number | null;
  priceMissing: boolean;
  cancelPriceExpiry: (() => void) | null;
  /** The published price outlived its proof while the live screen follows the pool's live stream (see `expirePrice`). */
  priceHeld: boolean;
  /** A price is published for the pool now. */
  priced: boolean;
  page: PoolCandlePage | null;
  section: Section<PoolCandlePage> | null;
  loading: boolean;
  buffered: { frame: ChartFrame; chars: number }[];
  retryAttempts: number;
  cancelRetry: (() => void) | null;
  inflight: Promise<void> | null;
  /** The checkpoint of the last history read while no stream frame or reconnect has changed its page since. */
  untouched: number | null;
  /** Bumped when the pool loses its fence: reads started before it are void. */
  generation: number;
  /** The pool's state on the tab's stream; null before the hub names one. */
  state: MarketStreamState | null;
};
type Options = Readonly<{
  pools: readonly string[];
  /** The coin the pools trade, so coin screens can follow this stream (see `MarketStreamHub.observe`). */
  coin?: string;
  expected: ExpectedDeployment | null;
  migration: () => MigrationMarker | null;
  request: () => ChartRequest;
  /** `recoveryCheckpoint`: the checkpoint a read must reach to start the stream, or null when none is due. */
  load: (poolKey: string, recoveryCheckpoint: number | null) => Promise<ChartPoolRead>;
  pollMs?: () => number | false;
  /** False: no history poll while the stream is live on the chart's pools; the stream brings every change. */
  livePolls?: boolean;
  retryReadErrors?: boolean;
  onSection: (poolKey: string, section: Section<PoolCandlePage>, migration: MigrationMarker | null) => void;
  onStatus: (status: ChartStreamStatus) => void;
  hub?: MarketStreamHub | null;
  visible?: () => boolean;
  schedule?: (run: () => void, ms: number) => () => void;
  publish?: (run: () => void) => () => void;
  random?: () => number;
  now?: () => number;
}>;

/** Frames one pool may hold while its history read runs; past either bound the pool is fenced again. */
const MAX_BUFFER_FRAMES = 128;
const MAX_BUFFER_CHARS = 65_536;

/** The chart's word for the hub's summary state. */
function chartStatus(state: Exclude<MarketStreamState, "live">): ChartStreamStatus {
  if (state === "stale") return "recovering";
  if (state === "over_budget") return "unavailable";
  return state;
}

function latestClose(page: PoolCandlePage) {
  if (page.source === "curve" && page.migration) return undefined;
  return page.candles.at(-1)?.close;
}

/**
 * One chart's history and live candles. Frames come from the tab's market stream hub; each pool's
 * REST history is fenced independently against the hub's subscription fence.
 */
export class ChartStream {
  private readonly options: Options;
  private readonly pools = new Map<string, Pool>();
  private subscription: MarketStreamSubscription | null = null;
  /** The last state the hub reported. */
  private hubState: MarketStreamState | null = null;
  private stopped = false;
  private generation = 0;
  private cancelPoll: (() => void) | null = null;
  private cancelPublish: (() => void) | null = null;
  private readonly pending = new Set<string>();
  private readonly pendingPrices = new Map<string, ChartPriceUpdate | null>();

  constructor(options: Options) {
    this.options = options;
    for (const pool of options.pools) this.pools.set(pool, { fence: null, reach: null, cutoff: null, priceMissing: false, cancelPriceExpiry: null, priceHeld: false, priced: false, page: null, section: null, loading: false, buffered: [], retryAttempts: 0, cancelRetry: null, inflight: null, untouched: null, generation: 0, state: null });
  }

  start(initial?: readonly (readonly [string, ChartPoolRead])[]): void {
    for (const [key, answer] of initial ?? []) {
      const checkpoint = answer.section.provenance?.checkpoint ?? null;
      const migration = this.options.migration();
      if (!this.pools.has(key) || answer.page?.poolKey !== key || checkpoint === null ||
          (migration && !sameChartMigration(migration, answer.page.migration))) continue;
      this.acceptRead(key, answer.page, answer.section, checkpoint);
    }
    const hub = this.options.hub === undefined ? tabMarketStream() : this.options.hub;
    // Without a socket (no WebSocket) the chart stays on its HTTP polls.
    if (hub) {
      this.subscription = hub.subscribe({
        pools: this.options.pools,
        expected: this.options.expected,
        migration: this.options.migration,
        ...(this.options.coin ? { coin: this.options.coin } : {}),
        listener: {
          state: (state) => this.state(state),
          pool: (key, state) => this.poolState(key, state),
          fence: (key, checkpoint, { lastEvent, priceMissing }) => this.fence(key, checkpoint, lastEvent, priceMissing === true),
          frame: (frame, chars) => this.frame(frame, chars),
        },
      });
    } else this.options.onStatus("unavailable");
    // HTTP remains the fallback and periodically observes indexer lag/corrections during quiet markets.
    const reads = this.visible() ? [...this.pools].filter(([, pool]) => pool.page === null).map(([key]) => this.load(key)) : [];
    if (!this.options.pollMs || !reads.length) this.poll();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.subscription?.stop();
    this.subscription = null;
    this.cancelPoll?.();
    this.cancelPublish?.();
    this.pendingPrices.clear();
    for (const [key, pool] of this.pools) {
      pool.cancelRetry?.();
      this.invalidatePrice(key);
    }
    this.options.onStatus("paused");
  }

  async refresh(): Promise<void> {
    await Promise.all([...this.pools.keys()].map((key) => this.load(key)));
  }

  private schedule(run: () => void, ms: number): () => void {
    if (this.options.schedule) return this.options.schedule(run, ms);
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  }

  private visible(): boolean {
    if (this.options.visible) return this.options.visible();
    return typeof document === "undefined" || document.visibilityState === "visible";
  }

  private poll(): void {
    if (this.stopped) return;
    this.cancelPoll?.();
    this.cancelPoll = null;
    const delay = this.options.pollMs?.() ?? 15_000;
    if (delay === false) return;
    this.cancelPoll = this.schedule(() => {
      this.cancelPoll = null;
      if (this.stopped) return;
      const remaining = this.options.pollMs?.();
      if (remaining === false) return;
      if (remaining && remaining > 0) return this.poll();
      // A hidden tab reads nothing; its stream's next fence brings the chart up to date.
      if (!this.visible()) return this.poll();
      // A live stream needs no read when the screen asked for none (`livePolls`), however quiet the
      // pool: its price holds while it stays live (`expirePrice`). Stale history (a frame that came
      // too late), or a close with no price shown (dropped while the stream was stale, or an old
      // read replayed at a fence), is read again rather than leave "—" until the next trade.
      // Each pool on its own: a pool that is not live is read while the other streams.
      // A curve the coin has migrated off trades no more: once its history is read, only the venue is polled.
      const curve = this.options.migration()?.curvePoolKey;
      const due = [...this.pools].filter(([key, pool]) => (key !== curve || pool.page === null)
        && (this.options.livePolls !== false || pool.state !== "live" || pool.section?.state === "stale" || this.priceWanted(pool)));
      if (!due.length) return this.poll();
      void Promise.all(due.map(([key]) => this.load(key))).then(() => this.poll());
    }, Math.max(1_000, delay));
  }

  /** The chart's summary: each pool's own fence follows `poolState`. */
  private state(state: MarketStreamState): void {
    // A tab shown again reads history at once, as a fresh chart would, rather than wait for a fence or poll.
    const resumed = this.hubState === "paused" && state === "connecting";
    this.hubState = state;
    if (this.stopped) return;
    // Back to `live` (the relay's upstream is fresh again) with every pool still following its fence:
    // no new fence or read comes, so the chart streams again here.
    if (state === "live") {
      if (this.caughtUp()) this.options.onStatus("streaming");
      return;
    }
    this.options.onStatus(chartStatus(state));
    if (resumed) void this.refresh();
  }

  private poolState(key: string, state: MarketStreamState): void {
    const pool = this.pools.get(key);
    if (this.stopped || !pool) return;
    pool.state = state;
    // A price held only by the live stream ends with it; the reads that now run bring a proven one.
    if (state !== "live" && pool.priceHeld) this.invalidatePrice(key);
    // `live` brings a fence; `stale` keeps it (frames may pause, polls run meanwhile).
    if (state === "live" || state === "stale" || pool.fence === null) return;
    // The socket went away: the fence ends with it, and what follows it is no longer current.
    if (state === "connecting" || state === "reconnecting" || state === "paused") this.unfence(key);
    // The relay re-fences the pool, does not know it, or serves other pools: the polls carry it,
    // and the history and price on screen stay.
    else this.dropFence(pool);
  }

  private fence(key: string, checkpoint: number, reach: number, priceMissing: boolean): void {
    const pool = this.pools.get(key);
    if (this.stopped || !pool) return;
    try {
      pool.fence = checkpoint;
      pool.reach = reach;
      pool.priceMissing = priceMissing;
      pool.cutoff = null;
      pool.buffered = [];
      this.options.onStatus("recovering");
      // A history read that already holds the pool's last event before this fence is the stream's
      // start: no second read (the chart opened, or its interval changed, and the read beat the
      // fence, or the pool did not trade between the read and the fence).
      const read = pool.loading ? null : pool.untouched;
      if (read !== null && read >= reach && pool.page && pool.section) this.acceptRead(key, pool.page, pool.section, read);
      // An already-running pre-fence read is validated against this fence when it settles. Until a
      // read reaches the fence, the shown price is the best one known, unless the stream says the
      // latest trade has none.
      // A fence while the pool's reads are backing off waits its turn: repeated fences cost few reads.
      else {
        if (priceMissing) this.invalidatePrice(key);
        if (pool.retryAttempts > 0) this.retry(key);
        else void this.load(key);
      }
    } catch {
      this.refence(key, checkpoint);
    }
  }

  private frame(frame: ChartFrame, chars: number): void {
    const pool = this.pools.get(frame.poolKey);
    if (this.stopped || !pool) return;
    // A frame after the pool lost its fence: the next fence and its read cover it.
    if (pool.fence === null) return;
    if (frame.type === "trade" && frame.trade.kind !== "opening_round_fill") {
      pool.priceMissing = frame.trade.price === null;
      if (pool.priceMissing) this.invalidatePrice(frame.poolKey);
    }
    if (pool.cutoff === null) this.buffer(pool, frame, chars);
    else this.apply(frame.poolKey, frame, chars);
  }

  /** Frames stop for the pool; reads and what they showed stay. */
  private dropFence(pool: Pool): void {
    pool.fence = null;
    pool.reach = null;
    pool.cutoff = null;
    pool.buffered = [];
  }

  /** A fence lost with its socket voids the pool's in-flight reads and leaves only historical candles on screen. */
  private unfence(key: string): void {
    const pool = this.pools.get(key)!;
    pool.generation++;
    this.dropFence(pool);
    pool.untouched = null;
    pool.loading = false;
    pool.inflight = null;
    pool.cancelRetry?.();
    pool.cancelRetry = null;
    // The next fence reads at once, whatever reads failed before it was lost.
    pool.retryAttempts = 0;
    this.invalidatePrice(key);
    if (pool.section?.state === "available") {
      pool.section = { ...pool.section, state: "stale", reason: "stream-reconnecting" };
      this.options.onSection(key, pool.section, pool.page?.migration ?? null);
    }
  }

  /**
   * A frame the pool's history cannot take, or more frames than it may hold while its read runs: the
   * pool is fenced again here, at the newest checkpoint it saw, and reads history through it. The
   * stream and the chart's other pool go on.
   */
  private refence(key: string, checkpoint: number): void {
    const pool = this.pools.get(key)!;
    pool.cutoff = null;
    pool.buffered = [];
    pool.untouched = null;
    pool.fence = Math.max(pool.fence ?? 0, checkpoint);
    pool.reach = Math.max(pool.reach ?? 0, checkpoint);
    this.invalidatePrice(key);
    if (pool.section?.state === "available" || pool.section?.state === "stale") {
      pool.section = { ...pool.section, state: "stale", reason: "stream-recovery" };
      this.options.onSection(key, pool.section, pool.page?.migration ?? null);
    }
    this.options.onStatus("recovering");
    this.retry(key);
  }

  private load(key: string): Promise<void> {
    const pool = this.pools.get(key)!;
    if (this.stopped) return Promise.resolve();
    if (pool.inflight) return pool.inflight;
    const work = this.read(key);
    pool.inflight = work;
    void work.finally(() => {
      if (pool.inflight !== work) return;
      pool.inflight = null;
      if (this.options.pollMs) this.poll();
    });
    return work;
  }

  private async read(key: string): Promise<void> {
    const pool = this.pools.get(key)!;
    if (pool.loading || this.stopped) return;
    pool.loading = true;
    pool.cancelRetry?.();
    pool.cancelRetry = null;
    const generation = this.generation;
    const poolGeneration = pool.generation;
    const current = () => !this.stopped && generation === this.generation && poolGeneration === pool.generation;
    const required = Math.max(pool.reach ?? 0, pool.section?.provenance?.checkpoint ?? 0);
    try {
      const answer = await this.options.load(key, pool.cutoff === null ? pool.reach : null);
      if (!current()) return;
      this.adoptRead(key, answer, Math.max(required, pool.reach ?? 0));
    } catch {
      if (!current()) return;
      // Shown history follows the stream, which keeps it current: a failed read changes nothing, and
      // the next tick reads again.
      if (pool.cutoff !== null) return;
      this.options.onSection(key, { state: "unavailable", reason: "stream-history-unavailable" }, null);
      this.options.onStatus("unavailable");
      this.invalidatePrice(key);
      if (this.options.retryReadErrors !== false) this.retry(key);
    } finally {
      if (generation === this.generation && poolGeneration === pool.generation) pool.loading = false;
    }
  }

  private adoptRead(key: string, answer: ChartPoolRead, required: number): void {
    const pool = this.pools.get(key)!;
    const checkpoint = answer.section.provenance?.checkpoint ?? null;
    // A healthy stream advances while HTTP is in flight. Its prior snapshot cannot undo a trade.
    const newer = checkpoint !== null && checkpoint >= (pool.section?.provenance?.checkpoint ?? 0);
    if (answer.page && checkpoint !== null && checkpoint >= required) {
      if (newer) this.acceptRead(key, answer.page, answer.section, checkpoint);
      return;
    }
    // Shown history already reaches the fence and follows the stream: an older or failed read changes nothing.
    if (pool.cutoff !== null) return;
    if (answer.page && newer) {
      // History behind the stream's fence is still the best known: show it and its close while
      // frames wait for a read that reaches the fence.
      this.acceptRead(key, answer.page, answer.section, checkpoint, false);
      // The read itself already waited once for the fence (`atCheckpoint`); wait longer before the next.
      pool.retryAttempts = Math.max(pool.retryAttempts, 2);
    } else if (!answer.page) {
      this.options.onSection(key, answer.section, null);
      this.invalidatePrice(key);
    }
    this.options.onStatus("recovering");
    this.retry(key);
  }

  /**
   * Show a history read and its close. `follow`: the read reaches the stream's fence, so buffered
   * and later frames apply on top of it.
   */
  private acceptRead(key: string, page: PoolCandlePage, section: Section<PoolCandlePage>, checkpoint: number, follow = true): void {
    const migration = this.options.migration();
    if (migration && !sameChartMigration(migration, page.migration)) throw new Error("History does not name the committed migration");
    const pool = this.pools.get(key)!;
    this.pending.delete(key);
    this.pendingPrices.delete(key);
    pool.page = page;
    pool.section = section;
    pool.untouched = checkpoint;
    const close = latestClose(page);
    this.pending.add(key);
    this.pendingPrices.set(key, section.state === "available" && close !== undefined
      ? { price: close, poolKey: key, cursor: null, provenance: section.provenance }
      : null);
    if (follow) {
      pool.cutoff = checkpoint;
      pool.retryAttempts = 0;
      const buffered = pool.buffered;
      pool.buffered = [];
      for (const item of buffered) this.apply(key, item.frame, item.chars, false);
    }
    this.publishPool(key);
    if (follow && this.caughtUp()) this.options.onStatus("streaming");
  }

  /** Every pool follows its fence on top of history that reaches it. */
  private caughtUp(): boolean {
    return [...this.pools.values()].every((item) => item.fence !== null && item.cutoff !== null);
  }

  private invalidatePrice(key: string): void {
    this.pending.delete(key);
    this.pendingPrices.delete(key);
    const pool = this.pools.get(key)!;
    pool.cancelPriceExpiry?.();
    pool.cancelPriceExpiry = null;
    pool.priceHeld = false;
    pool.priced = false;
    publishChartPrice(key, null);
  }

  /** The pool's history has a close the stream would price, yet no price is shown. */
  private priceWanted(pool: Pool): boolean {
    return !pool.priced && !pool.priceMissing && pool.page !== null && latestClose(pool.page) !== undefined;
  }

  /**
   * The price's proof ran out. On the live screen a pool that is live and followed by its history
   * keeps it: the stream brings every trade, and the relay calls the stream `stale` once the
   * indexer stops moving, so a quiet pool's last price is still its price. Otherwise it ends.
   */
  private expirePrice(key: string): void {
    const pool = this.pools.get(key)!;
    pool.cancelPriceExpiry = null;
    if (this.options.livePolls === false && pool.state === "live" && pool.cutoff !== null) pool.priceHeld = true;
    else this.invalidatePrice(key);
  }

  private retry(key: string): void {
    const pool = this.pools.get(key)!;
    pool.cancelRetry?.();
    const delay = Math.round(Math.min(30_000, 500 * 2 ** Math.min(pool.retryAttempts++, 6)) * (1 + (this.options.random ?? Math.random)() / 2));
    pool.cancelRetry = this.schedule(() => {
      pool.cancelRetry = null;
      if (!this.stopped) void this.load(key);
    }, delay);
  }

  /** Show a lone trade immediately. Fold any more trades before the next paint into one update. */
  private queuePublish(): void {
    if (this.cancelPublish) return;
    const nextPaint = () => {
      this.cancelPublish = null;
      if (!this.stopped && this.pending.size) this.queuePublish();
    };
    this.cancelPublish = this.options.publish ? this.options.publish(nextPaint) : (() => {
      const id = requestAnimationFrame(nextPaint);
      return () => cancelAnimationFrame(id);
    })();
    for (const key of this.pending) this.publishPool(key);
  }

  private publishPool(key: string): void {
    if (!this.pending.delete(key)) return;
    const pool = this.pools.get(key)!;
    const price = this.pendingPrices.get(key) ?? null;
    this.pendingPrices.delete(key);
    if (pool.section) this.options.onSection(key, pool.section, pool.page?.migration ?? null);
    const remaining = price ? this.priceRemaining(price.provenance) : 0;
    pool.cancelPriceExpiry?.();
    pool.cancelPriceExpiry = null;
    pool.priceHeld = false;
    pool.priced = false;
    if (!price || pool.priceMissing || remaining <= 0) {
      publishChartPrice(key, null);
      return;
    }
    pool.priced = true;
    pool.cancelPriceExpiry = this.schedule(() => this.expirePrice(key), remaining);
    publishChartPrice(key, price);
  }

  private priceRemaining(provenance: ChartPriceUpdate["provenance"]): number {
    return chartPriceRemaining(provenance, WORKLOAD_ROUTES.market.maxLagMs, this.now());
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private buffer(pool: Pool, frame: ChartFrame, chars: number): void {
    pool.buffered.push({ frame, chars });
    if (pool.buffered.length > MAX_BUFFER_FRAMES || pool.buffered.reduce((sum, item) => sum + item.chars, 0) > MAX_BUFFER_CHARS) this.refence(frame.poolKey, frame.checkpoint);
  }

  private apply(key: string, frame: ChartFrame, chars: number, publish = true): void {
    const pool = this.pools.get(key)!;
    if (pool.cutoff === null) { this.buffer(pool, frame, chars); return; }
    // The hub delivers each frame once, in cursor order; this history already holds its checkpoint.
    if (frame.checkpoint <= pool.cutoff || !pool.page || !pool.section) return;
    pool.untouched = null;
    try {
      pool.page = applyChartFrame(pool.page, frame, this.options.request());
      pool.section = this.priceRemaining(frame.provenance) <= 0
        ? { state: "stale", data: pool.page, provenance: frame.provenance, reason: "indexer-lag" }
        : { state: "available", data: pool.page, provenance: frame.provenance };
      const close = latestClose(pool.page);
      if (pool.section.state === "stale") this.invalidatePrice(key);
      this.pendingPrices.set(key, pool.section.state === "available" && close !== undefined ? { poolKey: key, price: close, cursor: frame.cursor, provenance: frame.provenance } : null);
      this.pending.add(key);
      if (publish) this.queuePublish();
    } catch {
      this.refence(key, frame.checkpoint);
    }
  }
}
