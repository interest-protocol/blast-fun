import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { QueryResult, QueryResultRow } from "pg";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { forYouNewEntries, forYouNewHead } from "@blast/server/modules/social/feed/for-you.ts";
import { createForYouNewReader } from "@blast/server/modules/social/feed/feed-reader.ts";

const config = SOCIAL_CONFIG_DEFAULTS;
const NOW = 1_000_000;
type Metric = Record<string, unknown>;
type Entry = { entry_id: string; occurred_at_ms: string; named_account_id: string | null; candidate: boolean };

function capture(t: TestContext, random = 0) {
  const previous = process.env.MISSION_CONTROL_METRICS;
  delete process.env.MISSION_CONTROL_METRICS;
  t.after(() => {
    if (previous === undefined) delete process.env.MISSION_CONTROL_METRICS;
    else process.env.MISSION_CONTROL_METRICS = previous;
  });
  const records: Metric[] = [];
  t.mock.method(Math, "random", () => random);
  t.mock.method(console, "info", (line: string) => records.push(JSON.parse(line)));
  return records;
}

function entries(count: number, offset = 0, candidates = count): Entry[] {
  return Array.from({ length: count }, (_, index) => ({
    entry_id: `private-entry-${offset + index}`,
    occurred_at_ms: String(NOW - offset - index),
    named_account_id: null,
    candidate: index < candidates,
  }));
}

function result<Row extends QueryResultRow>(rows: readonly unknown[]): QueryResult<Row> {
  return { rows: [...rows], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult<Row>;
}

function database(batches: readonly (readonly Entry[] | Error)[]) {
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  const db: ReadableDatabase = {
    async read<Row extends QueryResultRow>(sql: string, values: readonly unknown[] = []) {
      queries.push({ sql, values });
      const batch = batches[queries.length - 1];
      assert.ok(batch, "the scanner must not add a database query");
      if (batch instanceof Error) throw batch;
      return result<Row>(batch);
    },
  };
  return { db, queries };
}

function measurements(records: Metric[]) {
  return records.filter((record) => record.metric === "social.feed_new.scan");
}

function assertMeasurement(metric: Metric, expected: { mode: "head" | "since"; steps: number; rows: number; outcome: "ok" | "error" }) {
  const { mode, steps, rows, outcome, durationMs } = metric;
  assert.equal(metric.level, 30);
  assert.deepEqual({ mode, steps, rows, outcome }, expected);
  assert.ok(Number.isSafeInteger(durationMs) && Number(durationMs) >= 0);
  assert.deepEqual(Object.keys(metric).sort(), ["at", "durationMs", "level", "metric", "mode", "outcome", "rows", "steps", ...(outcome === "ok" ? ["sampleRate"] : [])].sort());
  assert.equal(metric.sampleRate, outcome === "ok" ? 0.02 : undefined);
}

test("scan metrics count empty, dense and sparse raw work while retaining the chronological cap", async (t) => {
  const records = capture(t);
  for (const [batches, expected] of [
    [[[]], { steps: 1, rows: 0, selected: 0 }],
    [[entries(400)], { steps: 1, rows: 400, selected: 51 }],
    [[entries(400, 0, 17), entries(400, 400, 17), entries(400, 800, 17)], { steps: 3, rows: 1_200, selected: 51 }],
  ] as const) {
    const fixture = database(batches);
    const head = await forYouNewHead(fixture.db, { config, nowMs: NOW, max: 50, hiddenKinds: [] });
    assert.equal(head.entries.length, expected.selected);
    assert.equal(fixture.queries.length, expected.steps);
    assertMeasurement(measurements(records).at(-1)!, { mode: "head", steps: expected.steps, rows: expected.rows, outcome: "ok" });
  }
  assert.equal(measurements(records).length, 3);
});

test("direct since scans have a distinct fixed label even when since is zero", async (t) => {
  const records = capture(t);
  const fixture = database([entries(3)]);
  assert.deepEqual(await forYouNewEntries(fixture.db, { config, nowMs: NOW, sinceMs: 0, max: 50, actors: 3, hiddenKinds: [] }), { count: 3, more: false, actorIds: [] });
  assertMeasurement(measurements(records)[0]!, { mode: "since", steps: 1, rows: 3, outcome: "ok" });
  assert.equal(fixture.queries[0]!.values[8], 0, "the direct SQL lower bound is unchanged");
});

test("scan failures always report attempted steps and only successfully returned rows without exposing error values", async (t) => {
  const records = capture(t, 0.99);
  const error = Object.assign(new Error("private-provider-payload"), { code: "PRIVATE_DATABASE_CODE" });
  const fixture = database([entries(400, 0, 1), error]);
  await assert.rejects(forYouNewHead(fixture.db, { config, nowMs: NOW, max: 50, hiddenKinds: [] }), (actual: unknown) => actual === error);
  const metric = measurements(records)[0]!;
  assertMeasurement(metric, { mode: "head", steps: 2, rows: 400, outcome: "error" });
  assert.equal(fixture.queries.length, 2);
  assert.equal(measurements(records).length, 1);
  assert.doesNotMatch(JSON.stringify(metric), /private-provider-payload|PRIVATE_DATABASE_CODE/);
});

test("successful sampling omits unsampled events without changing results or query count", async (t) => {
  const records = capture(t, 0.99);
  const fixture = database([entries(3)]);
  const head = await forYouNewHead(fixture.db, { config, nowMs: NOW, max: 50, hiddenKinds: [] });
  assert.equal(head.entries.length, 3);
  assert.equal(fixture.queries.length, 1);
  assert.equal(measurements(records).length, 0);
});

test("throwing metric sinks cannot replace successful results or the original database failure", async (t) => {
  capture(t);
  t.mock.method(console, "info", () => { throw new Error("metric sink failed"); });
  const success = database([entries(3)]);
  assert.equal((await forYouNewHead(success.db, { config, nowMs: NOW, max: 50, hiddenKinds: [] })).entries.length, 3);
  assert.equal(success.queries.length, 1);
  const original = new Error("source failed");
  const failure = database([original]);
  await assert.rejects(forYouNewHead(failure.db, { config, nowMs: NOW, max: 50, hiddenKinds: [] }), (actual: unknown) => actual === original);
  assert.equal(failure.queries.length, 1);
});

test("a throwing sampler also leaves source results unchanged", async (t) => {
  const records = capture(t);
  t.mock.method(Math, "random", () => { throw new Error("sampler failed"); });
  const fixture = database([entries(3)]);
  assert.equal((await forYouNewHead(fixture.db, { config, nowMs: NOW, max: 50, hiddenKinds: [] })).entries.length, 3);
  assert.equal(fixture.queries.length, 1);
  assert.equal(measurements(records).length, 0);
});

test("metrics contain fixed labels and work measurements, never entry, actor, since, hidden-kind or config values", async (t) => {
  const records = capture(t);
  const fixture = database([[{ ...entries(1)[0]!, entry_id: "secret-entry-id", named_account_id: "secret-account-id" }]]);
  await forYouNewEntries(fixture.db, { config: { ...config, big_commit_usd: "81234.56789" }, nowMs: NOW, sinceMs: 123_456, max: 50, actors: 3, hiddenKinds: ["secret-kind"] });
  const metric = measurements(records)[0]!;
  assertMeasurement(metric, { mode: "since", steps: 1, rows: 1, outcome: "ok" });
  assert.doesNotMatch(JSON.stringify(metric), /secret-entry-id|secret-account-id|81234\.56789|123456|secret-kind|SELECT|social_feed_entries/);
});

test("coalesced count consumers record one scan event for the producer", async (t) => {
  const records = capture(t);
  let scans = 0;
  const db: ReadableDatabase = {
    async read<Row extends QueryResultRow>(sql: string) {
      if (sql.includes("FROM chain_read_v1.watermark")) {
        return result<Row>([{ market_checkpoint: "10", market_timestamp_ms: "900", presale_checkpoint: "11", presale_timestamp_ms: "950", observed_ms: "1000" }]);
      }
      assert.match(sql, /FROM social_feed_entries/);
      scans += 1;
      return result<Row>(entries(3));
    },
  };
  const read = createForYouNewReader(() => db, () => NOW);
  const replies = await Promise.all(Array.from({ length: 20 }, (_, sinceMs) => read({ config, sinceMs, hiddenKinds: [] })));
  assert.ok(replies.every((reply) => reply.count === 3));
  assert.equal(scans, 1);
  assert.equal(measurements(records).length, 1);
  assertMeasurement(measurements(records)[0]!, { mode: "head", steps: 1, rows: 3, outcome: "ok" });
});
