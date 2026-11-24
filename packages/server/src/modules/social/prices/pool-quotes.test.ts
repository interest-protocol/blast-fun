import assert from "node:assert/strict";
import test from "node:test";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import { POOL_QUOTE_FIGURES_SQL, POOL_QUOTE_SERIES_SQL, readPoolQuotes } from "@blast/server/modules/social/prices/pool-quotes.ts";
import { readPriceHistories, PRICE_FIGURES_SQL, PRICE_SERIES_SQL } from "@blast/server/modules/social/prices/history.ts";

const NOW = 1_791_944_500_000;
const keys = [{ presaleId: "eman", coinType: "EMAN", launchedMs: NOW - 8_000_000 }, { presaleId: "lick", coinType: "LICK", launchedMs: NOW - 9_000_000 }];
const figures = keys.map((key) => ({ presale_id: key.presaleId, quote_type: "test::sui::TSUI", quote_symbol: "TSUI", price_quote: "0.000088098231292", as_of_ms: String(NOW - 1000), price_24h_quote: null }));
const observations = [
  { ord: 1, as_of_ms: String(NOW - 7_000_000), price_quote: "0.000000163333333" },
  { ord: 1, as_of_ms: String(NOW - 1000), price_quote: "0.000088098231292" },
  { ord: 2, as_of_ms: String(NOW - 8_000_000), price_quote: "0.000000267272727" },
];
const database: ReadableDatabase = { read: async (sql: string) => {
  if (sql === POOL_QUOTE_FIGURES_SQL) return { rows: figures } as never;
  if (sql === POOL_QUOTE_SERIES_SQL) return { rows: observations } as never;
  if (sql === PRICE_FIGURES_SQL) return { rows: keys.map((_, i) => ({ ord: i + 1, price_usd: null, at_24h: null, at_day_open: null })) } as never;
  if (sql === PRICE_SERIES_SQL) return { rows: [] } as never;
  throw new Error("Unexpected read");
} };

test("real quote observations remain separate from USD and never gain a synthetic endpoint", async () => {
  const result = await readPriceHistories(database, keys, { window: "24h", clockMs: NOW, points: 60 });
  assert.equal(result.length, 2);
  assert.equal(result[0]!.price_usd, null);
  assert.deepEqual(result[0]!.points, []);
  assert.equal(result[0]!.quote!.symbol, "TSUI");
  assert.equal(result[0]!.quote!.change_24h_bps, null);
  assert.deepEqual(result[0]!.quote!.points, observations.slice(0, 2).map((row) => [Number(row.as_of_ms), row.price_quote]));
  assert.equal(result[1]!.quote!.points.length, 1, "an opening price alone cannot form a chart");
  assert.ok(result[0]!.quote!.points.every(([at]) => at < NOW));
});

test("a historical-only quote has no measured 24h return, while fresh equal observations retain a real zero", async () => {
  const samples = [
    { id: "alon", at: NOW - 172_800_000, previous: "0.000088098231292", expected: null },
    { id: "blastoff", at: NOW - 86_400_000, previous: "0.000088098231292", expected: null },
    { id: "opening", at: NOW - 1000, previous: null, expected: null },
    { id: "flat", at: NOW - 1000, previous: "0.000088098231292", expected: 0 },
  ];
  for (const sample of samples) {
    const db: ReadableDatabase = { read: async (sql) => ({ rows: sql === POOL_QUOTE_FIGURES_SQL
      ? [{ ...figures[0]!, presale_id: sample.id, as_of_ms: String(sample.at), price_24h_quote: sample.previous }]
      : [] }) as never };
    const result = await readPoolQuotes(db, [{ ...keys[0]!, presaleId: sample.id }], { window: "24h", clockMs: NOW, points: 60 });
    assert.equal(result.get(sample.id)?.change_24h_bps, sample.expected, sample.id);
    assert.equal(result.get(sample.id)?.as_of_ms, sample.at, "the original observation time remains inspectable");
    assert.deepEqual(result.get(sample.id)?.points, [], "a scalar never invents a recent series");
  }
});

test("quote fallback tolerates an unapplied Infra view, but propagates real read failures", async () => {
  const missing = { read: async () => { throw Object.assign(new Error("missing view"), { code: "42P01" }); } };
  assert.equal((await readPoolQuotes(missing, keys, { window: "launch", clockMs: NOW, points: 60 })).size, 0);
  await assert.rejects(readPoolQuotes({ read: async () => { throw new Error("offline"); } }, keys, { window: "24h", clockMs: NOW, points: 60 }), /offline/);
});

test("pool reads use published views with bounded history and no invented timestamps", () => {
  for (const sql of [POOL_QUOTE_FIGURES_SQL, POOL_QUOTE_SERIES_SQL]) assert.doesNotThrow(() => assertChainReadThroughViews(sql));
  assert.match(POOL_QUOTE_SERIES_SQL, /ph.bucket_ms > k.lo AND ph.bucket_ms <= k.hi/);
  assert.match(POOL_QUOTE_SERIES_SQL, /ph.as_of_ms > k.after AND ph.as_of_ms <= k.hi/);
});
