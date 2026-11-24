import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { scheduler } from "node:timers/promises";
import { Pool } from "pg";
import { mintAccessCode, redeemAccessCode } from "./access-codes.ts";
import { createAnalyticsHandler } from "./api.ts";
import { analyticsPool } from "./config.ts";
import type { Fact } from "./facts.ts";
import { readSnapshot } from "./snapshot-reader.ts";
import { importBatch, initializeWarehouse, publishSnapshot } from "./store.ts";

const url = new URL(process.env.MISSION_CONTROL_TEST_DATABASE_URL ?? "http://missing-test-database.invalid");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Disposable loopback PostgreSQL is required");
const source = new Pool({ connectionString: url.toString(), max: 1 });
const warehouseUrl = new URL(url);
warehouseUrl.pathname = "/analytics_foundation";
const admin = new Pool({ connectionString: warehouseUrl.toString(), max: 1 });
function roleUrl(name: string): string {
  const value = new URL(warehouseUrl);
  value.username = name;
  return value.toString();
}
const writer = analyticsPool(roleUrl("foundation_writer"), "foundation-test-writer");
const reader = analyticsPool(roleUrl("foundation_reader"), "foundation-test-reader");
const access = new Pool({ connectionString: roleUrl("foundation_access"), max: 2 });
const outsider = new Pool({ connectionString: roleUrl("foundation_outsider"), max: 1 });
const sql = await readFile(new URL("./warehouse.sql", import.meta.url), "utf8");
const key = "fixture-wallet-key-never-production";
const scope = "a".repeat(64);
const end = 1800000000000;
const checkpoint = "9007199254740993";
function trade(id: string, timestamp: number, usd: string | null, atoms = "1"): Fact {
  return { fact_id: id, checkpoint, timestamp_ms: String(timestamp), digest: "one-transaction",
    actor: "fixture-wallet-never-in-the-api", kind: "trade", coin_type: "COIN", usd_value: usd,
    quote_type: "SUI", quote_amount: atoms };
}

before(async () => {
  await source.query("CREATE DATABASE analytics_foundation");
  await admin.query(sql);
  await admin.query(`
    CREATE ROLE foundation_writer LOGIN PASSWORD 'disposable-test'; GRANT blast_analytics_writer TO foundation_writer;
    CREATE ROLE foundation_reader LOGIN PASSWORD 'disposable-test'; GRANT blast_analytics_reader TO foundation_reader;
    CREATE ROLE foundation_access LOGIN PASSWORD 'disposable-test'; GRANT blast_analytics_access TO foundation_access;
    CREATE ROLE foundation_outsider LOGIN PASSWORD 'disposable-test';
  `);
});
after(async () => {
  await Promise.all([writer.end(), reader.end(), access.end(), outsider.end(), admin.end()]);
  await source.end();
});

test("refuses the product database and leaves no partially applied warehouse", async () => {
  await assert.rejects(source.query(sql), { message: "analytics requires a separate empty database" });
  await source.query("ROLLBACK");
  assert.equal((await source.query("SELECT to_regnamespace('blast_analytics') AS schema")).rows[0].schema, null);
});

test("publishes exact deduplicated receipt windows and preserves the last snapshot on partial or failed batches", async () => {
  const client = await writer.connect();
  try {
    await assert.rejects(importBatch(client, { checkpoint: "0", digest: "zero", timestampMs: "0", facts: [] }, key), { message: "Analytics warehouse must be initialized" });
    await initializeWarehouse(client, scope, "10");
    await initializeWarehouse(client, scope, "10");
    await assert.rejects(initializeWarehouse(client, "b".repeat(64), "10"), { message: "Analytics scope changed; rebuild required" });
    await assert.rejects(initializeWarehouse(client, scope, "11"), { message: "Analytics scope changed; rebuild required" });
    assert.equal(await readSnapshot(reader), null);
    const launch: Fact = { fact_id: "launch", checkpoint, timestamp_ms: String(end), digest: "launch-transaction", actor: null,
      kind: "coin_launched", coin_type: "COIN", usd_value: null };
    const batch = { checkpoint, digest: "checkpoint-digest", timestampMs: String(end), startTimestampMs: "1797407999999", facts: [
      trade("old", end - 2592000000, "999"),
      trade("month-boundary", end + 1 - 2592000000, "0.000000000000000001"),
      trade("day-boundary", end + 1 - 86400000, "9007199254740993.123456789012345678", "9007199254740993"),
      trade("at-end", end, "2"), trade("unpriced", end, null), launch,
      { ...launch, fact_id: "launch-duplicate-coin" },
      { ...launch, fact_id: "fundraising", kind: "presale_funded", usd_value: "1000000" },
    ] };
    await assert.rejects(importBatch(client, { ...batch, checkpoint: "9", facts: [] }, key), { message: "Analytics checkpoint precedes coverage" });
    await assert.rejects(importBatch(client, { ...batch, facts: [{ ...launch, checkpoint: "9007199254740994" }] }, key), { message: "Analytics fact lies outside the batch coverage" });
    await assert.rejects(importBatch(client, { ...batch, facts: [{ ...launch, checkpoint: "9" }] }, key), { message: "Analytics fact lies outside the batch coverage" });
    await assert.rejects(importBatch(client, { ...batch, facts: [{ ...launch, timestamp_ms: String(end + 1) }] }, key), { message: "Analytics fact lies outside the batch coverage" });
    await assert.rejects(importBatch(client, { ...batch, checkpoint: "09007199254740993", digest: "different", facts: [{ ...launch, fact_id: "leading-zero-unseen" }] }, key), { message: "Analytics coordinates must be canonical PostgreSQL unsigned bigint strings" });
    await assert.rejects(importBatch(client, { ...batch, timestampMs: "01800000000000" }, key), { message: "Analytics coordinates must be canonical PostgreSQL unsigned bigint strings" });
    await assert.rejects(importBatch(client, { ...batch, checkpoint: "9223372036854775808" }, key), { message: "Analytics coordinates must be canonical PostgreSQL unsigned bigint strings" });
    await assert.rejects(importBatch(client, { ...batch, facts: [{ ...launch, checkpoint: "-1" }] }, key), { message: "Analytics coordinates must be canonical PostgreSQL unsigned bigint strings" });
    await importBatch(client, batch, key);
    await importBatch(client, batch, key);
    await assert.rejects(importBatch(client, { ...batch, facts: [{ ...launch, fact_id: "late-unseen-fact" }] }, key), { message: "Analytics completed checkpoint has new facts; rebuild required" });
    await publishSnapshot(client, "9007199254740994");
    const published = await readSnapshot(reader);
    assert.ok(published);
    assert.equal(published.payload.asOfCheckpoint, "9007199254740993");
    assert.equal(published.payload.coverageStartCheckpoint, "10");
    assert.equal(published.payload.coverageStartTimestampMs, "1797407999999");
    assert.equal(published.payload.windowEndExclusiveMs, "1800000000001");
    assert.equal(published.payload.catchingUp, true);
    assert.deepEqual(published.payload.volumeWindows["24h"], { receipts: "3", priced_receipts: "2", priced_usd: "9007199254740995.123456789012345678" });
    assert.deepEqual(published.payload.volumeWindows["30d"], { receipts: "4", priced_receipts: "3", priced_usd: "9007199254740995.123456789012345679" });
    assert.deepEqual(published.payload.totals.trade_volume, { count: "5", pricedCount: "4", pricedUsd: "9007199254741994.123456789012345679" });
    assert.equal(published.payload.totals.launched_coins.count, "1");
    assert.equal(published.payload.totals.transactions.count, "2");
    assert.equal(published.payload.quoteTotals.SUI, "9007199254740997");
    assert.equal(published.payload.auditedTotalTradeVolumeUsd, null);
    assert.deepEqual(published.payload.users, { unit: "active-wallets", dau24h: "1", mau30d: "1", uniqueSinceCoverage: "1", productDau: null, productMau: null });
    assert.equal(published.payload.accountActivity, null);
    const saved = (await admin.query("SELECT actor_hash FROM blast_analytics.facts WHERE actor_hash IS NOT NULL LIMIT 1")).rows[0].actor_hash;
    assert.equal(saved, "841ebed6232d8f767723f3d980e2b8db326d07c06c680aa5a8bcfa77d3c5389e");
    const partial = { checkpoint: "9007199254740994", digest: "next", timestampMs: String(end + 1), complete: false, facts: [trade("partial", end + 1, "3")] };
    await importBatch(client, partial, key);
    await publishSnapshot(client, partial.checkpoint);
    assert.deepEqual(await readSnapshot(reader), published);
    const state = (await client.query("SELECT * FROM blast_analytics.state")).rows;
    await assert.rejects(importBatch(client, { ...partial, complete: true, facts: [trade("invalid", end + 1, "-1")] }, key), { code: "23514" });
    assert.deepEqual((await client.query("SELECT * FROM blast_analytics.state")).rows, state);
    assert.deepEqual(await readSnapshot(reader), published);
    await assert.rejects(importBatch(client, { ...partial, facts: [] }, key), { message: "Partial batch cannot be empty" });
    await assert.rejects(importBatch(client, { ...partial, facts: Array(5001).fill(launch) }, key), { message: "Analytics batches are limited to 5000 facts" });
    await assert.rejects(importBatch(client, { ...partial, facts: [{ ...launch, fact_id: "x".repeat(16 * 1024 * 1024) }] }, key), { message: "Analytics batches are limited to 16 MiB" });
    await assert.rejects(importBatch(client, partial, "short"), { message: "Analytics wallet key must have at least 32 characters" });
    await assert.rejects(importBatch(client, { ...partial, checkpoint: "9007199254740995", complete: true }, key), { message: "Analytics pending checkpoint must finish before advancing" });
    await assert.rejects(importBatch(client, { ...partial, digest: "changed", complete: true }, key), { message: "Analytics pending checkpoint must finish before advancing" });
    await assert.rejects(importBatch(client, { ...partial, timestampMs: String(end + 2), complete: true }, key), { message: "Analytics pending checkpoint must finish before advancing" });
    assert.deepEqual((await client.query("SELECT * FROM blast_analytics.state")).rows, state);
    await importBatch(client, { ...partial, complete: true }, key);
    await publishSnapshot(client, partial.checkpoint);
    assert.equal((await readSnapshot(reader))?.payload.catchingUp, false);
    assert.equal((await readSnapshot(reader))?.payload.totals.trade_volume.count, "6");
    const completed = await readSnapshot(reader);
    await assert.rejects(importBatch(client, { ...batch, timestampMs: String(end + 1) }, key), { message: "Analytics checkpoint cannot move backwards" });
    await assert.rejects(importBatch(client, { ...partial, checkpoint: "9007199254740995", timestampMs: String(end), complete: true, facts: [] }, key), { message: "Analytics checkpoint cannot move backwards" });
    await assert.rejects(importBatch(client, batch, key), { message: "Analytics checkpoint cannot move backwards" });
    await publishSnapshot(client, partial.checkpoint);
    assert.deepEqual((await readSnapshot(reader))?.payload, completed?.payload);
    await assert.rejects(importBatch(client, { ...partial, timestampMs: String(end), complete: true }, key), { message: "Analytics checkpoint cannot move backwards" });
    await assert.rejects(importBatch(client, { ...partial, digest: "changed", complete: true }, key), { message: "Analytics completed checkpoint changed; rebuild required" });
    await assert.rejects(importBatch(client, partial, key), { message: "Analytics completed checkpoint changed; rebuild required" });
    const [timeouts] = (await client.query("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock, current_setting('max_parallel_workers_per_gather') AS parallel")).rows;
    assert.deepEqual(timeouts, { statement: "10s", lock: "1s", parallel: "0" });
  } finally { client.release(); }
});

test("a blocked writer rechecks the committed state instead of overwriting a concurrent completed cut", async () => {
  const client = await writer.connect();
  await client.query("SET lock_timeout=0");
  const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const lock = await admin.connect();
  await lock.query("BEGIN");
  await lock.query("SELECT FROM blast_analytics.state WHERE singleton FOR UPDATE");
  const attempt = importBatch(client, { checkpoint: "9007199254740995", digest: "waiting-cut", timestampMs: String(end + 2),
    facts: [trade("blocked-fact", end + 2, "99")] }, key).then(() => null, (error: unknown) => error);
  try {
    const deadline = Date.now() + 5000;
    while (!(await source.query("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock') AS blocked", [pid])).rows[0].blocked) {
      assert.ok(Date.now() < deadline, "Writer must wait on the state row lock");
      await scheduler.yield();
    }
    await lock.query("UPDATE blast_analytics.state SET checkpoint=9007199254740996,digest='concurrent-cut',timestamp_ms=1800000000004 WHERE singleton");
    await lock.query("COMMIT");
    const result = await attempt;
    assert.ok(result instanceof Error);
    assert.equal(result.message, "Analytics checkpoint cannot move backwards");
    assert.deepEqual((await client.query("SELECT checkpoint::text,digest FROM blast_analytics.state")).rows,
      [{ checkpoint: "9007199254740996", digest: "concurrent-cut" }]);
    assert.equal((await client.query("SELECT count(*)::text AS count FROM blast_analytics.facts WHERE fact_id='blocked-fact'")).rows[0].count, "0");
  } finally {
    await lock.query("ROLLBACK");
    await attempt;
    await client.query("SET lock_timeout=1000");
    lock.release();
    client.release();
  }
});

test("restricts the API to aggregate snapshots and returns a safe failure when its database role loses access", async () => {
  await assert.rejects(reader.query("SELECT * FROM blast_analytics.facts"), { code: "42501" });
  await assert.rejects(reader.query("UPDATE blast_analytics.snapshots SET payload='{}'"), { code: "42501" });
  await assert.rejects(outsider.query("SELECT * FROM blast_analytics.snapshots"), { code: "42501" });
  const token = "fixture-private-api-token-32-bytes";
  const headers = { authorization: `Bearer ${token}` };
  const server = createServer(createAnalyticsHandler(token, () => readSnapshot(reader)));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const path = `http://127.0.0.1:${address.port}/v1/summary`;
  try {
    const response = await fetch(path, { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.asOfCheckpoint, "9007199254740994");
    assert.equal(body.totals.trade_volume.pricedUsd, "9007199254741997.123456789012345679");
    assert.equal(body.accountActivity, null);
    assert.doesNotMatch(JSON.stringify(body), /fixture-wallet|actor_hash|checkpoint-digest|password/);
    await admin.query("REVOKE SELECT ON blast_analytics.snapshots FROM blast_analytics_reader");
    const unavailable = await fetch(path, { headers });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: "snapshot_unavailable" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await admin.query("GRANT SELECT ON blast_analytics.snapshots TO blast_analytics_reader");
  }
});

test("rejects snapshot reads beyond ten queued requests instead of building an unbounded database backlog", async () => {
  await reader.query("SET lock_timeout=0");
  const lock = await admin.connect();
  await lock.query("BEGIN");
  await lock.query("LOCK blast_analytics.snapshots IN ACCESS EXCLUSIVE MODE");
  const token = "fixture-private-api-token-32-bytes";
  const headers = { authorization: `Bearer ${token}` };
  const server = createServer(createAnalyticsHandler(token, () => readSnapshot(reader)));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const path = `http://127.0.0.1:${address.port}/v1/summary`;
  const requests = Array.from({ length: 11 }, () => fetch(path, { headers }));
  try {
    const deadline = Date.now() + 5000;
    while (reader.waitingCount !== 10) {
      assert.ok(Date.now() < deadline, "Eleven actual requests must reach the bounded pool");
      await scheduler.yield();
    }
    const overloaded = await fetch(path, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(overloaded.status, 503);
    assert.deepEqual(await overloaded.json(), { error: "snapshot_unavailable" });
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
    const completed = await Promise.all(requests);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await reader.query("SET lock_timeout=1000");
    assert.deepEqual(completed.map((response) => response.status), [200,200,200,200,200,200,200,200,200,200,200]);
  }
});

test("stores only hashed one-hour codes and atomically allows one redemption without granting data or mint access", async () => {
  const code = await mintAccessCode(admin);
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  const hash = createHash("sha256").update(code).digest("hex");
  const saved = (await admin.query("SELECT code_hash, used_at, expires_at > now()+INTERVAL '59 minutes' AND expires_at <= now()+INTERVAL '1 hour' AS one_hour FROM blast_analytics.access_codes")).rows;
  assert.deepEqual(saved, [{ code_hash: hash, used_at: null, one_hour: true }]);
  const results = await Promise.all([redeemAccessCode(access, code), redeemAccessCode(access, code)]);
  assert.equal(results.filter((result) => result === hash).length, 1);
  assert.equal(results.filter((result) => result === null).length, 1);
  assert.equal(await redeemAccessCode(access, code), null);
  assert.equal(await redeemAccessCode(access, "invalid"), null);
  assert.equal(await redeemAccessCode(access, "z".repeat(43)), null);
  const expired = "e".repeat(43);
  const boundary = "b".repeat(43);
  await admin.query("INSERT INTO blast_analytics.access_codes VALUES($1,now()-INTERVAL '1 second',NULL),($2,now(),NULL)", [createHash("sha256").update(expired).digest("hex"), createHash("sha256").update(boundary).digest("hex")]);
  assert.equal(await redeemAccessCode(access, expired), null);
  assert.equal(await redeemAccessCode(access, boundary), null);
  const equality = await admin.query(`WITH boundary AS (
    UPDATE blast_analytics.access_codes SET expires_at=statement_timestamp() WHERE code_hash=$1 RETURNING code_hash
  ) SELECT blast_analytics.redeem_access_code(code_hash) AS accepted FROM boundary`, [createHash("sha256").update(boundary).digest("hex")]);
  assert.deepEqual(equality.rows, [{ accepted: false }]);
  await assert.rejects(access.query("SELECT * FROM blast_analytics.access_codes"), { code: "42501" });
  await assert.rejects(access.query("SELECT * FROM blast_analytics.snapshots"), { code: "42501" });
  await assert.rejects(mintAccessCode(access), { code: "42501" });
  await assert.rejects(mintAccessCode(writer), { code: "42501" });
  await assert.rejects(reader.query("SELECT blast_analytics.redeem_access_code($1)", [hash]), { code: "42501" });
  await assert.rejects(outsider.query("SELECT blast_analytics.redeem_access_code($1)", [hash]), { code: "42501" });
});
