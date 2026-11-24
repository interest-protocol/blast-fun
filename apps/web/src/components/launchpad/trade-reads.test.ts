import assert from "node:assert/strict";
import test from "node:test";

import type { CoinTradeListener, MarketTrade } from "./market-stream-hub.ts";
import { TRADE_READ_FLOOR_MS, TradeReads, type TradeReadsOptions } from "./trade-reads.ts";

const POOL = `blast_curve:0x${"11".repeat(32)}`;

function marketTrade(checkpoint: number, trader: string | null = null): MarketTrade {
  return { poolKey: POOL, checkpoint, summary: null, trade: { trader } as MarketTrade["trade"] };
}

/** A fake clock: timers run in time order as `advance` passes them. */
function setup(options: Partial<TradeReadsOptions> = {}, random = 0) {
  let now = 0;
  let visible = true;
  let onVisibility: (() => void) | null = null;
  let listener: CoinTradeListener | null = null;
  const timers: { at: number; run: () => void }[] = [];
  const reads: { ms: number; at: number | null }[] = [];
  const reads$ = new TradeReads(
    { minGapMs: 15_000, fallbackMs: (live) => (live ? 30_000 : 15_000), initial: true, read: (at) => reads.push({ ms: now, at }), ...options },
    {
      observe: (value) => { listener = value; return () => { listener = null; }; },
      now: () => now,
      schedule: (run, ms) => { const timer = { at: now + ms, run }; timers.push(timer); return () => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); }; },
      random: () => random,
      visible: () => visible,
      onVisibilityChange: (value) => { onVisibility = value; return () => { onVisibility = null; }; },
    },
  );
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = timers.filter((timer) => timer.at <= until).sort((left, right) => left.at - right.at)[0];
      if (!next) break;
      timers.splice(timers.indexOf(next), 1);
      now = next.at;
      next.run();
    }
    now = until;
  };
  return {
    reads, advance, start: () => reads$.start(), stop: () => reads$.stop(), timers,
    live: (value: boolean) => listener!.live(value),
    trade: (value: MarketTrade) => listener!.trade(value),
    setVisible: (value: boolean) => { visible = value; onVisibility?.(); },
    observing: () => listener !== null,
  };
}

test("20 trade frames in 5 s cost one holders read, pinned to the newest checkpoint", () => {
  const s = setup();
  s.start();
  s.live(true);
  assert.deepEqual(s.reads, [{ ms: 0, at: null }]);
  for (let index = 0; index < 20; index++) {
    s.trade(marketTrade(100 + index));
    s.advance(250);
  }
  s.advance(40_000);
  assert.deepEqual(s.reads.slice(1, 2), [{ ms: 15_000, at: 119 }]);
  assert.equal(s.reads.filter((read) => read.at !== null).length, 1);
  // The live, quiet stream polls every 30 s after the last read.
  assert.deepEqual(s.reads.slice(2), [{ ms: 45_000, at: null }]);
});

test("a trade after a quiet spell reads after the floor, not the full gap", () => {
  const s = setup();
  s.start();
  s.live(true);
  s.advance(20_000);
  s.trade(marketTrade(7));
  s.advance(TRADE_READ_FLOOR_MS);
  assert.deepEqual(s.reads.at(-1), { ms: 20_000 + TRADE_READ_FLOOR_MS, at: 7 });
});

test("the fallback polls every 15 s without a live stream and 30 s with one", () => {
  const s = setup();
  s.start();
  s.advance(15_000);
  assert.equal(s.reads.length, 2);
  s.live(true);
  s.advance(29_999);
  assert.equal(s.reads.length, 2);
  s.advance(1);
  assert.equal(s.reads.length, 3);
});

test("nothing reads while hidden; a trade seen then reads on return", () => {
  const s = setup();
  s.start();
  s.live(true);
  s.setVisible(false);
  s.trade(marketTrade(9));
  s.advance(120_000);
  assert.equal(s.reads.length, 1);
  s.setVisible(true);
  assert.deepEqual(s.reads.at(-1), { ms: 120_000, at: 9 });
});

test("a quick tab flip costs no read", () => {
  const s = setup();
  s.start();
  s.live(true);
  s.advance(3_000);
  s.setVisible(false);
  s.advance(2_000);
  s.setVisible(true);
  assert.equal(s.reads.length, 1);
  s.advance(25_000);
  assert.deepEqual(s.reads.at(-1), { ms: 30_000, at: null });
});

test("only accepted trades read, and stopping ends every timer and the observer", () => {
  const s = setup({ initial: false, fallbackMs: () => null, minGapMs: 0, accept: (trade) => trade.trade.trader === "0xme" });
  s.start();
  s.trade(marketTrade(5, "0xother"));
  s.advance(60_000);
  assert.equal(s.reads.length, 0);
  s.trade(marketTrade(6, "0xme"));
  s.advance(TRADE_READ_FLOOR_MS);
  assert.deepEqual(s.reads, [{ ms: 60_000 + TRADE_READ_FLOOR_MS, at: 6 }]);
  s.trade(marketTrade(8, "0xme"));
  s.stop();
  assert.equal(s.timers.length, 0);
  assert.equal(s.observing(), false);
});

test("without an initial read the fallback keeps its pace from the start", () => {
  const s = setup({ initial: false, fallbackMs: () => 30_000, minGapMs: 30_000 });
  s.start();
  s.advance(29_999);
  assert.equal(s.reads.length, 0);
  s.advance(1);
  assert.deepEqual(s.reads, [{ ms: 30_000, at: null }]);
});

test("tabs spread their fallback polls up to 20% longer, so they drift apart", () => {
  const s = setup({}, 0.5);
  s.start();
  s.live(true);
  s.advance(60_000);
  assert.deepEqual(s.reads.map((read) => read.ms), [0, 33_000]);
});
