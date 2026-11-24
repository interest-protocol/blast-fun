import assert from "node:assert/strict";
import test from "node:test";
import type { PoolCandlePage } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { lineCloseTime } from "./candle-data.ts";
import { walletMarkerBadges, walletMarkers, type WalletChartTrade } from "./wallet-markers.ts";

const page: PoolCandlePage = {
  source: "venue", venue: "cetus", poolKey: "cetus:0x1", interval: "1m", migration: null,
  candles: [{ bucketStart: 60_000, open: "1", high: "1", low: "1", close: "1", volumeQuote: 0n, volumeMeme: 0n, volumeUsd: null, buys: 2, sells: 1, trades: 3 }],
};
const seller = `0x${"11".repeat(32)}`;
const buyer = `0x${"22".repeat(32)}`;
const trades: WalletChartTrade[] = [
  { cursor: "3", address: seller, poolKey: page.poolKey, timestampMs: 95_000, side: "sell", labels: ["deployer", "whale"] },
  { cursor: "2", address: buyer, poolKey: page.poolKey, timestampMs: 92_000, side: "buy", labels: ["whale"] },
  { cursor: "1", address: buyer, poolKey: page.poolKey, timestampMs: 91_000, side: "buy", labels: ["sniper", "whale"] },
  { cursor: "4", address: seller, poolKey: page.poolKey, timestampMs: 118_000, side: "sell", labels: [] },
  { cursor: "5", address: seller, poolKey: page.poolKey, timestampMs: 120_000, side: "sell", labels: ["deployer"] },
  { cursor: "6", address: buyer, poolKey: "bluefin:0x2", timestampMs: 95_000, side: "buy", labels: ["deployer"] },
];

test("wallet markers separate buys and sells, group repeated labels, and require a candle in the same pool", () => {
  const marks = walletMarkers(trades, page, (bucket) => bucket);
  assert.deepEqual(marks.map(({ time, count, side, labels }) => [time, count, side, labels]), [
    [60, 2, "buy", ["whale", "sniper"]], [60, 1, "sell", ["deployer", "whale"]],
  ]);
  assert.deepEqual([...marks[0]!.wallets], [[buyer, 92_000]], "repeat trades use the latest represented time even if activity is newest first");
});

test("venue line markers use the drawn point when migration occurs inside a candle interval", () => {
  const marks = walletMarkers(trades, page, (bucket) => lineCloseTime(bucket, undefined, 60_000, 90_000, Infinity));
  assert.deepEqual(marks.map(({ time }) => time), [90, 90]);
});

test("phone badges stay inside the price pane and connect grouped trades to exact prices", () => {
  const marks = walletMarkers(trades, page, bucket => bucket);
  const repeated = [...marks, ...marks.map(mark => ({
    ...mark, key: mark.key + ":next", time: (mark.time + 1) as typeof mark.time,
    wallets: mark.side === "buy" ? new Map([[buyer, 157_000], [seller, 166_000]]) : mark.wallets,
  }))];
  const compact = walletMarkerBadges(repeated, 280, 140, 14, mark => ({
    x: 200 + (mark.time - 60) * 8, y: mark.side === "buy" ? 77 : 68,
  }), true);
  const [buy, sell] = compact;
  assert.deepEqual(buy!.points, [{ x: 200, y: 77, key: marks[0]!.key }, { x: 208, y: 77, key: marks[0]!.key + ":next" }]);
  assert.equal(buy!.count, 4);
  assert.equal(sell!.count, 2);
  assert.deepEqual([...buy!.wallets], [[buyer, 157_000], [seller, 166_000]], "the combined badge preserves distinct wallet choices and their latest trade times");
  assert.equal(buy!.badgeHeight, 44);
  assert.ok(buy!.badgeWidth >= 44);
  for (const [rem, touch, expected] of [[14, false, 24], [20, false, 30], [20, true, 55]] as const) {
    const [badge] = walletMarkerBadges(marks, 280, 140, rem, () => ({ x: 150, y: 70 }), touch);
    assert.equal(badge?.badgeHeight, expected, `target height at ${rem}px rem, touch=${touch}`);
  }
  assert.ok(buy!.top > 77 && sell!.top + sell!.badgeHeight < 68);
  assert.ok(buy!.left >= 0 && buy!.left + buy!.badgeWidth <= 280);
  const zoomed = walletMarkerBadges(repeated, 280, 140, 16, mark => ({ x: 40 + (mark.time - 60) * 180, y: 70 }));
  assert.deepEqual(zoomed.map(badge => badge.points.length), [1, 1, 1, 1]);
  assert.deepEqual(walletMarkerBadges(marks, 280, 140, 16, () => ({ x: 100, y: 155 })), [], "the volume pane has no price markers");
});

test("opposite trades at the chart edge have separate badges and visible price anchors", () => {
  const marks = walletMarkers(trades, page, bucket => bucket);
  for (const y of [1, 139]) {
    const [buy, sell] = walletMarkerBadges(marks, 280, 140, 16, () => ({ x: 278, y }));
    assert.deepEqual(buy!.anchor, { x: 278, y, key: marks[0]!.key });
    assert.deepEqual(sell!.anchor, { x: 278, y, key: marks[1]!.key });
    assert.ok(Math.abs(buy!.top - sell!.top) > buy!.badgeHeight);
    for (const badge of [buy!, sell!]) {
      assert.ok(badge.top >= 0 && badge.top + badge.badgeHeight <= 140);
      assert.ok(badge.left + badge.badgeWidth <= 280);
      assert.ok(y < badge.top || y > badge.top + badge.badgeHeight, "the badge leaves the price anchor visible");
    }
  }
});
