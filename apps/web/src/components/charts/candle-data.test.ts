import assert from "node:assert/strict";
import test from "node:test";
import { linePoints } from "./candle-data";

const candle = (bucketStart: number, close: string) => ({
  bucketStart, open: close, high: close, low: close, close,
  volumeQuote: 1n, volumeMeme: 1n, volumeUsd: null, buys: 1, sells: 0, trades: 1,
});

// The live BLAST launch 0x8dd1…a1e2: launched 15:28, migrated 15:29:28 inside the 15:25 5m bucket.
const interval = 300_000;
const migrationAt = 1_795_188_568_424;
const opening = { timestampMs: 1_795_188_480_000, price: "0.0012" };

test("the venue line starts at the migration, never left of the curve line's end", () => {
  const curve = linePoints([candle(1_795_188_300_000, "0.0124")], opening, interval, -Infinity, migrationAt);
  const venue = linePoints([candle(1_795_188_300_000, "0.0041"), candle(1_795_188_600_000, "0.0044")], undefined, interval, migrationAt, Infinity);
  assert.equal(curve.at(-1)!.timestampMs, migrationAt);
  assert.deepEqual(venue.map((point) => point.timestampMs), [migrationAt, 1_795_188_600_000]);
});

test("without a migration floor every close stays at its bucket start", () => {
  const points = linePoints([candle(0, "1"), candle(interval, "2")], undefined, interval, -Infinity, Infinity);
  assert.deepEqual(points.map((point) => point.timestampMs), [0, interval]);
});

test("the line holds the last close flat through empty buckets, never breaking or slanting", () => {
  const points = linePoints([candle(0, "1"), candle(interval, "2"), candle(5 * interval, "3"), candle(6 * interval, "4"), candle(9 * interval, "5")], undefined, interval, -Infinity, Infinity);
  assert.deepEqual(
    points.map((point) => [point.timestampMs / interval, point.price]),
    [[0, "1"], [1, "2"], [4, "2"], [5, "3"], [6, "4"], [8, "4"], [9, "5"]],
  );
});

test("a held stretch never starts left of the venue floor", () => {
  const points = linePoints([candle(0, "1"), candle(3 * interval, "2")], undefined, interval, 2.5 * interval, Infinity);
  assert.ok(points.every((point) => point.timestampMs >= 2.5 * interval));
});

test("the line holds the opening price until the first trade's bucket", () => {
  const points = linePoints([candle(5 * interval, "2")], { timestampMs: 0, price: "1" }, interval, -Infinity, Infinity);
  assert.deepEqual(
    points.map((point) => [point.timestampMs / interval, point.price]),
    [[0, "1"], [4, "1"], [5, "2"]],
  );
});

test("the curve line holds its last close up to the migration so the venue line meets it", () => {
  const points = linePoints([candle(0, "1"), candle(interval, "2")], undefined, interval, -Infinity, 4 * interval);
  assert.deepEqual(
    points.map((point) => [point.timestampMs / interval, point.price]),
    [[0, "1"], [1, "2"], [4, "2"]],
  );
});
