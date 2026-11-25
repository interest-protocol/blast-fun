import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult, QueryResultRow } from "pg";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { forYouNewEntries, forYouNewEntriesFromHead, forYouNewHead } from "@blast/server/modules/social/feed/for-you.ts";
import { createAfterResponseScheduler, createRequestWork, runWithRequestWork, trackRequestWork } from "@blast/server/lib/request-work.ts";
import { createForYouNewReader } from "@blast/server/modules/social/feed/feed-reader.ts";
import { createSocialFeedRoute } from "@blast/server/modules/social/feed/route.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import { deferred } from "../../../../../core/test/kit.ts";

const config = SOCIAL_CONFIG_DEFAULTS;
const NOW = 1_000_000;
type Entry = { entry_id: string; occurred_at_ms: string; named_account_id: string | null; candidate: boolean; kind: string };

function entries(count: number): Entry[] {
  return Array.from({ length: count }, (_, i) => ({
    entry_id: `entry-${String(count - i).padStart(3, "0")}`,
    occurred_at_ms: String(NOW - Math.floor(i / 2)),
    named_account_id: i % 5 === 0 ? null : `actor-${i % 7}`,
    candidate: true,
    kind: "presale_commit",
  }));
}

function database(source: Entry[], options: { gate?: Promise<void>; missingActors?: readonly string[] } = {}) {
  let scans = 0;
  let watermarks = 0;
  let identities = 0;
  let failure: Error | undefined;
  let readable = true;
  let watermarkError: Error | undefined;
  const scanInputs: unknown[][] = [];
  const db: ReadableDatabase = {
    async read<Row extends QueryResultRow>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
      let rows: unknown[];
      if (sql.includes("FROM social_feed_entries e")) {
        scans += 1;
        scanInputs.push([...values]);
        await options.gate;
        if (failure) throw failure;
        rows = source.filter((entry) => {
          const time = Number(entry.occurred_at_ms);
          if (time < Number(values[2]) || (values[4] as readonly string[]).includes(entry.kind)) return false;
          if (sql.includes("e.occurred_at_ms > $9")) return time > Number(values[8]);
          return time < Number(values[8]) || (time === Number(values[8]) && Buffer.compare(Buffer.from(entry.entry_id), Buffer.from(String(values[9]))) < 0);
        }).sort((a, b) => Number(b.occurred_at_ms) - Number(a.occurred_at_ms) || Buffer.compare(Buffer.from(b.entry_id), Buffer.from(a.entry_id)))
          .slice(0, Number(values[7]));
      } else if (sql.includes("FROM chain_read_v1.watermark")) {
        watermarks += 1;
        if (watermarkError) throw watermarkError;
        rows = readable ? [{ market_checkpoint: "10", market_timestamp_ms: "900", presale_checkpoint: "11", presale_timestamp_ms: "950", observed_ms: "1000" }] : [];
      } else {
        assert.match(sql, /FROM social_account_identities/);
        identities += 1;
        rows = (values[0] as readonly string[]).filter((id) => !options.missingActors?.includes(id))
          .map((id) => ({ account_id: id, callsign: id, display_name: null, avatar_url: null }));
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult<Row>;
    },
  };
  return { db, scans: () => scans, watermarks: () => watermarks, identities: () => identities, scanInputs,
    fail(error?: Error) { failure = error; }, readable(value: boolean) { readable = value; },
    failWatermark(error?: Error) { watermarkError = error; } };
}

test("chronological count head matches direct since-bound scans across ties, caps and sparse scan steps", async () => {
  const source = entries(95).map((entry, i) => ({ ...entry, candidate: i % 3 !== 0 }));
  const db = database(source);
  for (const scanBatch of [1, 7, 400]) {
    const head = await forYouNewHead(db.db, { config, nowMs: NOW, max: 50, scanBatch, hiddenKinds: [] });
    assert.equal(head.entries.length, 51);
    for (const sinceMs of [0, NOW - 100, NOW - 30, NOW - 1, NOW, NOW + 1]) {
      const direct = await forYouNewEntries(db.db, { config, nowMs: NOW, sinceMs, max: 50, actors: 3, scanBatch, hiddenKinds: [] });
      assert.deepEqual(forYouNewEntriesFromHead(head, sinceMs, 3), direct, `since ${sinceMs}, batch ${scanBatch}`);
    }
    assert.ok(head.entries.every((entry, i) => i === 0 || entry.occurredAtMs <= head.entries[i - 1]!.occurredAtMs));
  }
});

test("head keeps bytewise tie order and excludes the 51st actor from the first50 actor window", async () => {
  const source = entries(51).map((entry, i) => ({ ...entry, occurred_at_ms: String(NOW), named_account_id: i < 50 ? "first" : "extra" }));
  source[0]!.entry_id = "é";
  source[1]!.entry_id = "z";
  const head = await forYouNewHead(database(source).db, { config, nowMs: NOW, max: 50, scanBatch: 7, hiddenKinds: [] });
  assert.equal(head.entries[0]?.entryId, "é");
  assert.equal(head.entries[1]?.entryId, "z");
  assert.deepEqual(forYouNewEntriesFromHead(head, 0, 3), { count: 50, more: true, actorIds: ["first"] });
  assert.deepEqual(forYouNewEntriesFromHead(head, NOW, 3), { count: 0, more: false, actorIds: [] });
});

test("overlapping different since values share one exact producer clock, scan, watermark and actor read; settled reads are not retained", async () => {
  const gate = deferred();
  const fixture = database(entries(65), { gate: gate.promise });
  let clockReads = 0;
  const read = createForYouNewReader(() => fixture.db, () => { clockReads += 1; return NOW + clockReads; });
  const requests = [0, NOW - 20, NOW - 1, NOW, NOW + 1];
  const pending = requests.map((sinceMs) => read({ config, sinceMs, hiddenKinds: [] }));
  await Promise.resolve();
  assert.equal(fixture.scans(), 1);
  gate.resolve();
  const result = await Promise.all(pending);
  assert.equal(clockReads, 1);
  assert.equal(fixture.scans(), 1);
  assert.equal(fixture.watermarks(), 1);
  assert.equal(fixture.identities(), 1);
  assert.deepEqual(result.map((reply) => reply.count), [50, 40, 2, 0, 0]);
  assert.deepEqual(result[0]!.as_of, { checkpoint: 10, timestamp_ms: 900, lag_ms: 100 });
  (result[0]!.as_of as { lag_ms: number }).lag_ms = 9_999;
  assert.equal(result[1]!.as_of.lag_ms, 100, "callers do not share mutable response objects");
  await read({ config, sinceMs: 0, hiddenKinds: [] });
  assert.equal(fixture.scans(), 2);
  assert.equal(clockReads, 2);
});

test("missing hydrated identities disappear without filling from a fourth actor", async () => {
  const source = entries(4).map((entry, i) => ({ ...entry, named_account_id: `actor-${i}` }));
  const fixture = database(source, { missingActors: ["actor-0"] });
  const read = createForYouNewReader(() => fixture.db, () => NOW);
  const result = await read({ config, sinceMs: 0, hiddenKinds: [] });
  assert.deepEqual(result.actors.map((actor) => actor.callsign), ["actor-1", "actor-2"]);
  assert.equal(result.count, 4);
});

test("hidden kind sets canonicalize while every selection config and source context stays isolated", async () => {
  const gate = deferred();
  const fixture = database(entries(8), { gate: gate.promise });
  const read = createForYouNewReader(() => fixture.db, () => NOW);
  const same = [read({ config, sinceMs: 0, hiddenKinds: ["trade_buy", "trade_sell"] }), read({ config, sinceMs: 1, hiddenKinds: ["trade_sell", "trade_buy", "trade_buy"] })];
  const changed = [
    { ...config, big_commit_usd: "2000" }, { ...config, big_trade_usd: "2000" },
    { ...config, for_you_window_days: 31 }, { ...config, for_you_migrated_days: 8 },
    { ...config, why_boost_ms: 1 }, { ...config, big_boost_ms: 1 },
  ].map((selection) => read({ config: selection, sinceMs: 0, hiddenKinds: ["trade_buy", "trade_sell"] }));
  const visible = read({ config, sinceMs: 0, hiddenKinds: [] });
  const other = database(entries(1));
  const otherRead = createForYouNewReader(() => other.db, () => NOW);
  gate.resolve();
  await Promise.all([...same, ...changed, visible]);
  assert.equal(fixture.scans(), 8);
  assert.equal((await otherRead({ config, sinceMs: 0, hiddenKinds: [] })).count, 1);
  assert.equal(other.scans(), 1);
});

test("source errors and missing watermarks are shared only in flight and recover on the next read", async () => {
  const fixture = database(entries(5));
  const read = createForYouNewReader(() => fixture.db, () => NOW);
  fixture.fail(new Error("read failed"));
  const first = await Promise.allSettled([read({ config, sinceMs: 0, hiddenKinds: [] }), read({ config, sinceMs: 1, hiddenKinds: [] })]);
  assert.ok(first.every((result) => result.status === "rejected" && result.reason.message === "read failed"));
  assert.equal(fixture.scans(), 1);
  fixture.fail();
  fixture.readable(false);
  await assert.rejects(read({ config, sinceMs: 0, hiddenKinds: [] }), (error: unknown) => error instanceof Error && "code" in error && error.code === "service_unavailable");
  fixture.readable(true);
  assert.equal((await read({ config, sinceMs: 0, hiddenKinds: [] })).count, 5);
  assert.equal(fixture.scans(), 3);
});


test("one aborted caller cannot cancel a shared fill or release its tracked work before the database settles", async () => {
  const gate = deferred();
  const fixture = database(entries(5), { gate: gate.promise });
  const read = createForYouNewReader(() => fixture.db, () => NOW);
  const scheduler = createAfterResponseScheduler();
  const first = createRequestWork(scheduler);
  const second = createRequestWork(scheduler);
  const disconnect = new AbortController();
  const a = runWithRequestWork(first, () => trackRequestWork(read({ config, sinceMs: 0, hiddenKinds: [] })), disconnect.signal);
  const b = runWithRequestWork(second, () => trackRequestWork(read({ config, sinceMs: NOW - 1, hiddenKinds: [] })));
  await Promise.resolve();
  disconnect.abort(new Error("caller disconnected"));
  let released = false;
  const completion = first.complete().then(() => { released = true; });
  await Promise.resolve();
  assert.equal(released, false);
  assert.equal(fixture.scans(), 1);
  gate.resolve();
  const [one, two] = await Promise.all([a, b]);
  assert.equal(one.count, 5);
  assert.equal(two.count, 2);
  await Promise.all([completion, second.complete()]);
  assert.equal(released, true);
  assert.equal(fixture.scans(), 1);
});


test("watermark failure keeps the shared fill owned until its still-running selection settles", async () => {
  const gate = deferred();
  const fixture = database(entries(5), { gate: gate.promise });
  fixture.failWatermark(new Error("watermark failed"));
  const read = createForYouNewReader(() => fixture.db, () => NOW);
  let settled = false;
  const first = read({ config, sinceMs: 0, hiddenKinds: [] });
  void first.then(() => { settled = true; }, () => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  const second = read({ config, sinceMs: 1, hiddenKinds: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.scans(), 1, "failed sibling does not evict the pending producer");
  assert.equal(fixture.watermarks(), 1);
  gate.resolve();
  const result = await Promise.allSettled([first, second]);
  assert.ok(result.every((entry) => entry.status === "rejected" && entry.reason.message === "watermark failed"));
  fixture.failWatermark();
  assert.equal((await read({ config, sinceMs: 0, hiddenKinds: [] })).count, 5);
  assert.equal(fixture.scans(), 2, "settled failure is not retained");
});

for (const [stage, pausedSql, failingSql] of [
  ["selection", "FROM social_presale_pins pin", "FROM chain_read_v1.watermark"],
  ["item lookups", "FROM social_reactions", "FROM social_attributions"],
] as const) {
  test(`a failed first-page fill shares outstanding ${stage} until it settles, then retries`, async () => {
    const gate = deferred();
    const paused = deferred();
    let fail = true;
    let loads = 0;
    const db: ReadableDatabase = {
      async read<Row extends QueryResultRow>(sql: string): Promise<QueryResult<Row>> {
        if (sql.includes(pausedSql)) {
          paused.resolve();
          await gate.promise;
        }
        if (fail && sql.includes(failingSql)) throw new Error("database read failed");
        const rows: unknown[] = sql.includes("FROM chain_read_v1.watermark")
          ? [{ market_checkpoint: "10", market_timestamp_ms: "900", presale_checkpoint: "11", presale_timestamp_ms: "950", observed_ms: "1000" }]
          : sql.includes("LIMIT $8")
            ? [{ entry_id: "a:10:0:0:0", occurred_at_ms: "900", rank_ms: "900", source: "activity", kind: "presale_commit", named_account_id: null, presale_id: null, usd_price_as_of_ms: null }]
            : [];
        return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult<Row>;
      },
    };
    const origin = "https://blast.fun";
    const unexpected = () => { throw new Error("unexpected authentication or primary access"); };
    const kit = createSocialRouteKit({
      expectedOrigin: origin, tradingVisible: () => true, verifyAccessToken: unexpected,
      limiter: { async consume(bucket) { return { allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 }; } },
      accounts: { resolve: unexpected, resolveWallet: unexpected }, primary: unexpected,
    });
    const { GET } = createSocialFeedRoute({ kit, config: async () => config, now: () => NOW, database: () => {
      loads += 1;
      return db;
    } });
    const get = () => GET(new Request(`${origin}/api/social/feed`), testClient());

    const first = get();
    await paused.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = get();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(loads, 1, "a rejected sibling must not release the pending fill");
    } finally {
      gate.resolve();
    }
    assert.deepEqual((await Promise.all([first, second])).map((reply) => reply.status), [503, 503]);
    fail = false;
    assert.equal((await get()).status, 200);
    assert.equal(loads, 2);
  });
}

test("a complete head can scan farther than a high-since query when eligible candidates are sparse", async () => {
  const source = entries(1_200).map((entry, i) => ({ ...entry, candidate: i % 23 === 0 }));
  const global = database(source);
  const direct = database(source);
  const head = await forYouNewHead(global.db, { config, nowMs: NOW, max: 50, hiddenKinds: [] });
  const recent = await forYouNewEntries(direct.db, { config, nowMs: NOW, sinceMs: NOW - 5, max: 50, actors: 3, hiddenKinds: [] });
  assert.deepEqual(forYouNewEntriesFromHead(head, NOW - 5, 3), recent);
  assert.equal(head.entries.length, 51);
  assert.equal(global.scans(), 3);
  assert.equal(direct.scans(), 1);
});
