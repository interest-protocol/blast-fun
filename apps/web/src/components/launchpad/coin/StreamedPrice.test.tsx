import assert from "node:assert/strict";
import test from "node:test";

import type { ChartPriceUpdate } from "../chart/chart-live-price.ts";
import { priceCoversHeader } from "../chart/chart-live-price.ts";

const update = (checkpoint: number | null, cursor: string | null): ChartPriceUpdate => ({
  price: "0.005", poolKey: `blast_curve:0x${"a1".repeat(32)}`, cursor,
  provenance: { source: "blast-infra", network: "mainnet", deployment: "a".repeat(64), checkpoint, timestampMs: 1_000, observedAt: 1_010, lagMs: 10 },
});

test("a partial streamed transaction cannot replace a header that includes its complete checkpoint", () => {
  assert.equal(priceCoversHeader(update(100, "100:1:1:0"), 100), false);
  assert.equal(priceCoversHeader(update(99, "99:9:9:0"), 100), false);
  assert.equal(priceCoversHeader(update(101, "101:1:1:0"), 100), true);
});

test("validated durable candle history may correct the same complete checkpoint, but never an older one", () => {
  assert.equal(priceCoversHeader(update(100, null), 100), true);
  assert.equal(priceCoversHeader(update(99, null), 100), false);
  assert.equal(priceCoversHeader(update(null, null), null), false);
  assert.equal(priceCoversHeader(update(100, null), null), true);
});
