import assert from "node:assert/strict";
import test from "node:test";

import type { MarketTrade } from "./market-stream-hub.ts";
import { coinDay, newerThanRead, tradeFigures } from "./trade-figures.ts";

const POOL = `blast_curve:0x${"11".repeat(32)}`;
const OTHER = `bluefin:0x${"22".repeat(32)}`;

function frame(checkpoint: number, summary: unknown): MarketTrade {
  return { poolKey: POOL, checkpoint, summary, trade: {} as MarketTrade["trade"] };
}

const day = { volume_quote: "1500", volume_usd: "12.5", buys: 3, sells: 1, trades: 4 };

test("a frame's summary gives holders and the 24 h window; each malformed figure is null on its own", () => {
  assert.deepEqual(tradeFigures(frame(9, { holders: 42, windows: { "24h": day } })), {
    poolKey: POOL, checkpoint: 9, holders: 42,
    day: { volumeQuote: 1500n, volumeUsd: "12.5", buys: 3, sells: 1, trades: 4 },
  });
  assert.deepEqual(tradeFigures(frame(9, { holders: "many", windows: { "24h": day } })).holders, null);
  assert.equal(tradeFigures(frame(9, { holders: 42, windows: { "24h": { ...day, buys: -1 } } })).day, null);
  assert.deepEqual(tradeFigures(frame(9, null)), { poolKey: POOL, checkpoint: 9, holders: null, day: null });
  assert.deepEqual(tradeFigures(frame(9, "junk")), { poolKey: POOL, checkpoint: 9, holders: null, day: null });
});

test("streamed figures never show behind the read they replace", () => {
  const figures = tradeFigures(frame(105, { holders: 100, windows: {} }));
  assert.equal(newerThanRead(figures, 104), figures);
  assert.equal(newerThanRead(figures, 105), null);
  assert.equal(newerThanRead(figures, 106), null);
  assert.equal(newerThanRead(figures, null), figures);
  assert.equal(newerThanRead(null, 1), null);
});

test("a pool's 24 h window stands for the coin's only while the coin trades on that one pool", () => {
  const figures = tradeFigures(frame(9, { holders: 1, windows: { "24h": day } }));
  assert.equal(coinDay(figures, [POOL]), figures.day);
  assert.equal(coinDay(figures, [POOL, OTHER]), null);
  assert.equal(coinDay(figures, [OTHER]), null);
  assert.equal(coinDay(null, [POOL]), null);
});
