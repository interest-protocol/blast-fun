import assert from "node:assert/strict";
import { test } from "node:test";

import { LIVE_STALE_MS, liveCoinStats, newerStats, reconnecting, statsAfterRead } from "./live-coin.ts";

const POOL = "cetus:0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab";

function frame(checkpoint: number, extra: Record<string, unknown> = {}) {
  return { type: "coin_stats", coin: "0x2::sui::SUI", pool_key: POOL, checkpoint, timestamp_ms: 1, cursor: "1:0:0:0", provenance: {}, ...extra };
}

test("a coin_stats frame gives the header its numbers; missing or malformed ones stay null", () => {
  assert.deepEqual(liveCoinStats(frame(7, {
    lifecycle: "migrated", holders: 1_204,
    market: { fdv_usd: "1250000.5", market_cap_usd: "1", change_24h_bps: "-2124" }, window_24h: { volume_usd: "8400.25", trades: 3 },
  })), { poolKey: POOL, checkpoint: 7, lifecycle: "migrated", holders: 1_204, fdvUsd: "1250000.5", volumeUsd: "8400.25", changeBps: -2124 });
  assert.deepEqual(liveCoinStats(frame(7, { holders: -1, market: { fdv_usd: "1e9", change_24h_bps: 12 }, window_24h: null })),
    { poolKey: POOL, checkpoint: 7, lifecycle: null, holders: null, fdvUsd: null, volumeUsd: null, changeBps: null });
  assert.equal(liveCoinStats({ ...frame(7), type: "price" }), null);
  assert.equal(liveCoinStats(frame(-1)), null);
  assert.equal(liveCoinStats(null), null);
});

test("the newest stats win, and a stats frame never shows behind the page's own read", () => {
  const older = liveCoinStats(frame(5))!;
  const newer = liveCoinStats(frame(9))!;
  assert.equal(newerStats(newer, older), newer);
  assert.equal(newerStats(older, newer), newer);
  assert.equal(newerStats(null, older), older);
  assert.equal(statsAfterRead(newer, 9), null);
  assert.equal(statsAfterRead(newer, 8), newer);
  assert.equal(statsAfterRead(newer, null), newer);
  assert.equal(statsAfterRead(null, 8), null);
});

test("the screen says Reconnecting only after the stream has not been live for 10 s", () => {
  assert.equal(reconnecting("reconnecting", 0, LIVE_STALE_MS - 1), false);
  assert.equal(reconnecting("reconnecting", 0, LIVE_STALE_MS), true);
  assert.equal(reconnecting("connecting", 0, LIVE_STALE_MS), true);
  assert.equal(reconnecting("live", 0, LIVE_STALE_MS * 9), false);
  assert.equal(reconnecting("paused", 0, LIVE_STALE_MS * 9), false);
  assert.equal(reconnecting("unavailable", 0, LIVE_STALE_MS * 9), false);
  assert.equal(reconnecting(null, 0, LIVE_STALE_MS * 9), false);
});
