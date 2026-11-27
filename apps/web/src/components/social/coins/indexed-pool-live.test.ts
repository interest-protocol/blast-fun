import assert from "node:assert/strict";
import test from "node:test";

import type { ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import type { VenuePoolKey } from "#web/components/launchpad/activity/activity-live.ts";
import { MarketStreamHub, type MarketEventSource, type MarketStreamState } from "#web/components/launchpad/market-stream-hub.ts";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { followPoolTrades, newestRead, poolRefetchInterval, poolTradesKey, type PoolTradesRead } from "./indexed-pool-live.ts";

const FIRST = `cetus:0x${"22".repeat(32)}` as VenuePoolKey;
const SECOND = `cetus:0x${"33".repeat(32)}` as VenuePoolKey;
const DEPLOYMENT = "ab".repeat(32);
const NOW = 1_790_000_000_000;
const provenance = (checkpoint: number) => ({ network: "mainnet", deployment_fingerprint: DEPLOYMENT, checkpoint, timestamp_ms: NOW + checkpoint, observed_ms: NOW + checkpoint, lag_ms: 0 });
const swap = (pool: string, checkpoint: number) => ({
  type: "trade", cursor: `${checkpoint}:1:0:2`, checkpoint, timestamp_ms: NOW + checkpoint, provenance: provenance(checkpoint), summary: null,
  trade: { cursor: `${checkpoint}:1:0:2`, timestamp_ms: NOW + checkpoint, digest: "FvFRVLsgYqA3DyDLNaiqFP77Z5UuVrFfYyRzpLEHEwZh", pool_key: pool, venue: "cetus", trader: `0x${"9".repeat(64)}`, side: "buy", kind: "swap", quote_amount: "5", meme_amount: "3", price: "2", volume_usd: null, venue_swap: { amount_in: "5", amount_out: "3", ref_amount: "0", before_sqrt_price: "1", after_sqrt_price: "2", a_to_b: true } },
});

class Source implements MarketEventSource {
  readonly listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  addEventListener(type: string, listener: (event: { data?: string }) => void): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  close(): void {}
  /** The server's answer to a `set`: it holds what was asked. */
  send(text: string): boolean {
    const { seq, pools, price_coins, presale } = JSON.parse(text) as { seq: number; pools: string[]; price_coins: string[]; presale: string | null };
    queueMicrotask(() => this.emit("set", { seq, ok: true, held: { pools, price_coins, presale } }));
    return true;
  }
  emit(type: string, value: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(value) }); }
  fence(pool: string, checkpoint: number): void { this.emit("status", { state: "live", pool_key: pool, checkpoint, cursor: `${checkpoint}:0:0:0`, provenance: provenance(checkpoint) }); }
}

function setup(answers: (pool: VenuePoolKey, at: number | null) => number | null) {
  let now = 0;
  const timers: { run: () => void; at: number }[] = [];
  const schedule = (run: () => void, ms: number) => { const timer = { run, at: now + ms }; timers.push(timer); return () => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); }; };
  const sources: Source[] = [];
  const hub = new MarketStreamHub({ createSource: () => { const source = new Source(); sources.push(source); return source; }, schedule, defer: queueMicrotask, random: () => 0, visible: () => true, onVisibilityChange: () => () => {} });
  const client = createTestQueryClient();
  const reads: [VenuePoolKey, number | null][] = [];
  const rows: ActivityRow[] = [];
  const states = new Map<VenuePoolKey, MarketStreamState>();
  const stop = followPoolTrades({
    hub, client, poolKeys: [FIRST, SECOND],
    read: async (pool, _signal, at): Promise<PoolTradesRead> => {
      reads.push([pool, at]);
      return { stale: false, rows: [], checkpoint: answers(pool, at) };
    },
    onRow: (row) => rows.push(row),
    onState: (pool, state) => states.set(pool, state),
    schedule, now: () => now, random: () => 0,
  });
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = due.at;
      due.run();
      await settle();
    }
    now = end;
    await settle();
  };
  const live = () => new Set([...states].filter(([, state]) => state === "live").map(([pool]) => pool));
  return { client, reads, rows, states, stop, settle, advance, live, source: () => sources.at(-1)! };
}

test("a cached read behind the fence is read again until it reaches the fence checkpoint", async () => {
  let behind = true;
  const s = setup((pool, at) => pool === FIRST && behind ? (behind = false, 8) : at);
  await s.settle();
  s.source().emit("hint", { type: "hello", set: true, provenance: provenance(1) });
  await s.settle();
  s.source().fence(FIRST, 12);
  await s.advance(5_000); // the frame-read floor
  assert.deepEqual(s.reads, [[FIRST, 12]]);
  assert.equal(s.client.getQueryData<PoolTradesRead>(poolTradesKey(FIRST))?.checkpoint, 8, "the behind answer shows meanwhile");
  await s.advance(20_000);
  assert.deepEqual(s.reads, [[FIRST, 12], [FIRST, 12]]);
  assert.equal(s.client.getQueryData<PoolTradesRead>(poolTradesKey(FIRST))?.checkpoint, 12);
  await s.advance(60_000);
  assert.equal(s.reads.length, 2, "a read that reached the fence asks no more");
  s.stop();
});

test("an older poll never replaces a read pinned to a later fence", async () => {
  const s = setup((_pool, at) => at);
  await s.settle();
  s.source().emit("hint", { type: "hello", set: true, provenance: provenance(1) });
  await s.settle();
  s.source().fence(FIRST, 12);
  await s.advance(5_000);
  assert.equal(newestRead(s.client, FIRST, { stale: false, rows: [], checkpoint: 9 }).checkpoint, 12);
  s.stop();
});

test("a live pool has no poll while the other, not live, keeps its own; trades from both pools reach the list", async () => {
  const s = setup((_pool, at) => at);
  await s.settle();
  s.source().emit("hint", { type: "hello", set: true, provenance: provenance(1) });
  await s.settle();
  s.source().fence(FIRST, 12);
  s.source().emit("status", { state: "unavailable", pool_key: SECOND });
  await s.advance(0);
  const poll = () => 15_000;
  const query = { state: { status: "success" } };
  assert.equal(poolRefetchInterval(s.live(), FIRST, poll)(query), false);
  assert.equal(poolRefetchInterval(s.live(), SECOND, poll)(query), 15_000);
  s.source().fence(SECOND, 12);
  await s.advance(0);
  assert.equal(poolRefetchInterval(s.live(), SECOND, poll)(query), false);
  assert.equal(poolRefetchInterval(s.live(), SECOND, poll)({ state: { status: "error" } }), 15_000, "a failed read keeps polling");
  s.source().emit("market", swap(FIRST, 13));
  s.source().emit("market", swap(SECOND, 14));
  assert.deepEqual(s.rows.map((row) => row.position), ["13:1:0:2", "14:1:0:2"]);
  s.stop();
});
