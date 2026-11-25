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
  cutoff: number | null;
  priceMissing: boolean;
  cancelPriceExpiry: (() => void) | null;
  page: PoolCandlePage | null;
  section: Section<PoolCandlePage> | null;
  loading: boolean;
  buffered: { frame: ChartFrame; chars: number }[];
  retryAttempts: number;
  cancelRetry: (() => void) | null;
  inflight: Promise<void> | null;
  /** The checkpoint of the last history read while no stream frame or reconnect has changed its page since. */
  untouched: number | null;
};
type Options = Readonly<{
  pools: readonly string[];
  /** The coin the pools trade, so coin screens can follow this stream (see `MarketStreamHub.observe`). */
  coin?: string;
  expected: ExpectedDeployment | null;
  migration: () => MigrationMarker | null;
  request: () => ChartRequest;
  load: (poolKey: string, recoveryCheckpoint: number | null) => Promise<ChartPoolRead>;
  pollMs?: () => number | false;
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

const MAX_BUFFER_CHARS = 65_536;

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
    for (const pool of options.pools) this.pools.set(pool, { fence: null, cutoff: null, priceMissing: false, cancelPriceExpiry: null, page: null, section: null, loading: false, buffered: [], retryAttempts: 0, cancelRetry: null, inflight: null, untouched: null });
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
    // Without a stream (no EventSource) the chart stays on its HTTP polls.
    if (hub) {
      this.subscription = hub.subscribe({
        pools: this.options.pools,
        expected: this.options.expected,
        migration: this.options.migration,
        ...(this.options.coin ? { coin: this.options.coin } : {}),
        listener: {
          state: (state) => this.state(state),
          fence: (key, checkpoint, priceMissing) => this.fence(key, checkpoint, priceMissing === true),
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
      if (this.visible()) {
        // A curve the coin has migrated off trades no more: once its history is read, only the venue is polled.
        const curve = this.options.migration()?.curvePoolKey;
        void Promise.all([...this.pools].filter(([key, pool]) => key !== curve || pool.page === null).map(([key]) => this.load(key)))
          .then(() => this.poll());
      } else this.poll();
    }, Math.max(1_000, delay));
  }

  private state(state: MarketStreamState): void {
    // A tab shown again reads history at once, as a fresh chart would, rather than wait for a fence or poll.
    const resumed = this.hubState === "paused" && state === "connecting";
    this.hubState = state;
    if (this.stopped || state === "live") return;
    // A fence ends with its connection; "connecting" after a pool change replaces one still held.
    if (state !== "connecting" || [...this.pools.values()].some((pool) => pool.fence !== null)) this.unfence();
    this.options.onStatus(state);
    if (resumed) void this.refresh();
  }

  private fence(key: string, checkpoint: number, priceMissing: boolean): void {
    const pool = this.pools.get(key);
    if (this.stopped || !pool) return;
    try {
      pool.fence = checkpoint;
      pool.priceMissing = priceMissing;
      pool.cutoff = null;
      pool.buffered = [];
      this.options.onStatus("recovering");
      // A history read that already reaches this fence is the stream's start: no second read
      // (the chart opened, or its interval changed, and the read beat the stream's fence).
      const read = pool.loading ? null : pool.untouched;
      if (read !== null && read >= pool.fence && pool.page && pool.section) this.acceptRead(key, pool.page, pool.section, read);
      // An already-running pre-fence read is validated against this fence when it settles.
      else {
        this.invalidatePrice(key);
        void this.load(key);
      }
    } catch {
      this.subscription?.restart();
    }
  }

  private frame(frame: ChartFrame, chars: number): void {
    const pool = this.pools.get(frame.poolKey);
    if (this.stopped || !pool) return;
    if (pool.fence === null) return this.subscription?.restart();
    if (frame.type === "trade" && frame.trade.kind !== "opening_round_fill") {
      pool.priceMissing = frame.trade.price === null;
      if (pool.priceMissing) this.invalidatePrice(frame.poolKey);
    }
    if (pool.cutoff === null) this.buffer(pool, frame, chars);
    else this.apply(frame.poolKey, frame, chars);
  }

  /** A lost fence voids in-flight reads and leaves only historical candles on screen. */
  private unfence(): void {
    this.generation++;
    this.pending.clear();
    this.pendingPrices.clear();
    this.cancelPublish?.();
    this.cancelPublish = null;
    for (const [key, pool] of this.pools) {
      pool.fence = null;
      pool.cutoff = null;
      pool.untouched = null;
      pool.loading = false;
      pool.inflight = null;
      pool.buffered = [];
      pool.cancelRetry?.();
      pool.cancelRetry = null;
      this.invalidatePrice(key);
      if (pool.section?.state === "available") {
        pool.section = { ...pool.section, state: "stale", reason: "stream-reconnecting" };
        this.options.onSection(key, pool.section, pool.page?.migration ?? null);
      }
    }
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
    const required = Math.max(pool.fence ?? 0, pool.section?.provenance?.checkpoint ?? 0);
    try {
      const answer = await this.options.load(key, pool.cutoff === null ? pool.fence : null);
      if (this.stopped || generation !== this.generation) return;
      this.adoptRead(key, answer, Math.max(required, pool.fence ?? 0));
    } catch {
      if (this.stopped || generation !== this.generation) return;
      pool.cutoff = null;
      this.options.onSection(key, { state: "unavailable", reason: "stream-history-unavailable" }, null);
      this.options.onStatus("unavailable");
      this.invalidatePrice(key);
      if (this.options.retryReadErrors !== false) this.retry(key);
    } finally {
      if (generation === this.generation) pool.loading = false;
    }
  }

  private adoptRead(key: string, answer: ChartPoolRead, required: number): void {
    const pool = this.pools.get(key)!;
    const checkpoint = answer.section.provenance?.checkpoint ?? null;
    if (answer.page && checkpoint !== null && checkpoint >= required) {
      // A healthy stream advances while HTTP is in flight. Its prior snapshot cannot undo a trade.
      if (checkpoint >= (pool.section?.provenance?.checkpoint ?? 0)) {
        this.acceptRead(key, answer.page, answer.section, checkpoint);
      }
      return;
    }
    pool.cutoff = null;
    const section = answer.page
      ? { state: "unavailable", reason: "stream-history-behind", provenance: answer.section.provenance } as const
      : answer.section;
    this.options.onSection(key, section, answer.page?.migration ?? null);
    this.options.onStatus("recovering");
    this.invalidatePrice(key);
    this.retry(key);
  }

  private acceptRead(key: string, page: PoolCandlePage, section: Section<PoolCandlePage>, checkpoint: number): void {
    const migration = this.options.migration();
    if (migration && !sameChartMigration(migration, page.migration)) throw new Error("History does not name the committed migration");
    const pool = this.pools.get(key)!;
    this.pending.delete(key);
    this.pendingPrices.delete(key);
    pool.page = page;
    pool.section = section;
    pool.cutoff = checkpoint;
    pool.retryAttempts = 0;
    pool.untouched = checkpoint;
    const close = latestClose(page);
    this.pending.add(key);
    this.pendingPrices.set(key, pool.fence !== null && section.state === "available" && close !== undefined
      ? { price: close, poolKey: key, cursor: null, provenance: section.provenance }
      : null);
    const buffered = pool.buffered;
    pool.buffered = [];
    for (const item of buffered) this.apply(key, item.frame, item.chars, false);
    this.publishPool(key);
    if ([...this.pools.values()].every((item) => item.fence !== null && item.cutoff !== null)) this.options.onStatus("streaming");
  }

  private invalidatePrice(key: string): void {
    this.pending.delete(key);
    this.pendingPrices.delete(key);
    const pool = this.pools.get(key)!;
    pool.cancelPriceExpiry?.();
    pool.cancelPriceExpiry = null;
    publishChartPrice(key, null);
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
    if (!price || pool.priceMissing || remaining <= 0) {
      publishChartPrice(key, null);
      return;
    }
    pool.cancelPriceExpiry = this.schedule(() => this.invalidatePrice(key), remaining);
    publishChartPrice(key, price);
  }

  private priceRemaining(provenance: ChartPriceUpdate["provenance"]): number {
    return chartPriceRemaining(provenance, WORKLOAD_ROUTES.market.maxLagMs, (this.options.now ?? Date.now)());
  }

  private buffer(pool: Pool, frame: ChartFrame, chars: number): void {
    pool.buffered.push({ frame, chars });
    const buffered = [...this.pools.values()].flatMap((item) => item.buffered);
    if (buffered.length > 128 || buffered.reduce((sum, item) => sum + item.chars, 0) > MAX_BUFFER_CHARS) this.subscription?.restart();
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
      pool.cutoff = null;
      pool.fence = Math.max(pool.fence ?? 0, frame.checkpoint);
      this.invalidatePrice(key);
      if (pool.section.state === "available" || pool.section.state === "stale") {
        pool.section = { ...pool.section, state: "stale", reason: "stream-recovery" };
        this.options.onSection(key, pool.section, pool.page?.migration ?? null);
      }
      this.options.onStatus("recovering");
      this.retry(key);
    }
  }
}
