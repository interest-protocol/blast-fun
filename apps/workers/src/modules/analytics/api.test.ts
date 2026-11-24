import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createAnalyticsHandler } from "./api.ts";
import type { Snapshot } from "./contract.ts";
import { analyticsPool, readApiConfig } from "./config.ts";

const token = "t".repeat(32);
const headers = { authorization: `Bearer ${token}` };
const cut = 1800000000000;
function snapshot(): { generated_at: Date; payload: Snapshot["payload"] } {
  return { generated_at: new Date(cut), payload: {
    version: 2, volumeMethod: "registered-pool-quote-receipts-v1",
    volumeUnit: "registered-pool-turnover-usd", pricingPolicy: "historical-quote-oracle-60s-100bps-v1",
    auditedTotalTradeVolumeUsd: null, quoteTotals: { SUI: "9007199254740993" },
    asOfCheckpoint: "9007199254740993", asOfTimestampMs: String(cut), windowEndExclusiveMs: "1800000000001",
    coverageStartCheckpoint: "0", coverageStartTimestampMs: null, historyScope: "since-configured-checkpoint",
    catchingUp: true, transactionScope: "selected-launch-presale-trade-facts",
    users: { unit: "active-wallets", dau24h: "1", mau30d: "1", uniqueSinceCoverage: "1", productDau: null, productMau: null },
    accountActivity: null, totals: { presale_cancelled: { count: "0", pricedCount: "0", pricedUsd: "0" }, trade_volume: { count: "2", pricedCount: "1", pricedUsd: "9007199254740993.123456789012345678" } },
    volumeWindows: { "24h": { receipts: "2", priced_receipts: "1", priced_usd: "9007199254740993.123456789012345678" }, "30d": { receipts: "2", priced_receipts: "1", priced_usd: "9007199254740993.123456789012345678" } },
    dailyTradeVolume: [{ day_ms: "1799971200000", receipts: "2", priced_receipts: "1", priced_usd: "9007199254740993.123456789012345678" }],
  } };
}
async function serve(load: () => Promise<Snapshot | null>) {
  const server = createServer(createAnalyticsHandler(token, load));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

test("authenticates summary reads before storage and admits only the fixed GET routes", async () => {
  let reads = 0;
  const server = await serve(async () => { reads++; return null; });
  try {
    const live = await fetch(`${server.url}/live`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: "live" });
    const denied = await fetch(`${server.url}/v1/summary`);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: "unauthorized" });
    assert.equal((await fetch(`${server.url}/v1/summary?token=${token}`)).status, 401);
    assert.equal((await fetch(`${server.url}/v1/summary`, { headers: { authorization: `Bearer ${"x".repeat(32)}` } })).status, 401);
    const unknown = await fetch(`${server.url}/v1/summary?query=wallets`, { headers });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "not_found" });
    const post = await fetch(`${server.url}/v1/summary`, { method: "POST", headers });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET");
    assert.deepEqual(await post.json(), { error: "method_not_allowed" });
    assert.equal(reads, 0);
    const missing = await fetch(`${server.url}/v1/summary`, { headers });
    assert.equal(missing.status, 503);
    assert.deepEqual(await missing.json(), { error: "snapshot_unavailable" });
    assert.equal(reads, 1);
  } finally { await server.close(); }
});

test("preserves exact aggregate strings and labels both source and publication staleness", async (t) => {
  t.mock.method(Date, "now", () => cut);
  const value = snapshot();
  const server = await serve(async () => value);
  const summary = async () => {
    const response = await fetch(`${server.url}/v1/summary`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-type"), "application/json");
    return response.json();
  };
  try {
    assert.deepEqual(await summary(), { ...value.payload, generatedAt: "2027-01-15T08:00:00.000Z", stale: false });
    value.payload.asOfTimestampMs = String(cut - 3600001);
    assert.equal((await summary()).stale, true);
    value.payload.asOfTimestampMs = String(cut);
    value.generated_at = new Date(cut - 3600001);
    assert.equal((await summary()).stale, true);
    value.generated_at = new Date(cut);
    value.payload.asOfTimestampMs = "9007199254740993";
    assert.equal((await summary()).stale, true);
    value.payload.asOfTimestampMs = String(cut + 1);
    assert.equal((await summary()).stale, true);
    value.payload.asOfTimestampMs = String(cut);
    value.generated_at = new Date(cut + 1);
    assert.equal((await summary()).stale, true);
    value.generated_at = new Date(cut - 3600000);
    value.payload.asOfTimestampMs = String(cut - 3600000);
    assert.equal((await summary()).stale, false);
  } finally { await server.close(); }
});

test("fails closed on malformed aggregates and redacts storage failures", async () => {
  let value: ReturnType<typeof snapshot> | null = snapshot();
  let failed = false;
  const server = await serve(async () => {
    if (failed) { throw new Error("private postgres://password@host/database"); }
    return value;
  });
  const unavailable = async () => {
    const response = await fetch(`${server.url}/v1/summary`, { headers });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "snapshot_unavailable" });
  };
  try {
    value.payload.quoteTotals.SUI = 9007199254740992 as unknown as string;
    await unavailable();
    value = snapshot();
    value.payload.quoteTotals.SUI = "-1";
    await unavailable();
    value.payload.quoteTotals.SUI = "1x";
    await unavailable();
    value = snapshot();
    value.payload.totals.trade_volume.pricedUsd = "-1";
    await unavailable();
    value.payload.totals.trade_volume.pricedUsd = "1x";
    await unavailable();
    value = snapshot();
    Object.assign(value.payload, { walletRows: ["private-wallet"] });
    await unavailable();
    value = snapshot();
    value.generated_at = new Date(NaN);
    await unavailable();
    value = null;
    await unavailable();
    failed = true;
    await unavailable();
  } finally { await server.close(); }
});

test("rejects unsafe connection and token configuration without echoing secrets", async () => {
  assert.doesNotThrow(() => createAnalyticsHandler("a".repeat(4096), async () => null));
  const local = analyticsPool("postgresql://reader@127.0.0.1/db", "test");
  await local.end();
  const override = analyticsPool("postgres://reader@ep-test-pooler.neon.tech/db?host=127.0.0.1", "test");
  await override.end();
  assert.throws(() => createAnalyticsHandler("short", async () => null), { message: "ANALYTICS_API_TOKEN must be 32–4096 non-whitespace characters" });
  assert.throws(() => createAnalyticsHandler("a".repeat(4097), async () => null), { message: "ANALYTICS_API_TOKEN must be 32–4096 non-whitespace characters" });
  assert.throws(() => createAnalyticsHandler("a".repeat(32) + "\n", async () => null), { message: "ANALYTICS_API_TOKEN must be 32–4096 non-whitespace characters" });
  assert.throws(() => analyticsPool("private-secret", "test"), { message: "Analytics database URLs must use PostgreSQL" });
  assert.throws(() => analyticsPool("https://private-secret", "test"), { message: "Analytics database URLs must use PostgreSQL" });
  assert.throws(() => analyticsPool("postgres://reader@remote.invalid/db", "test"), { message: "Analytics remote databases require sslmode=verify-full" });
  assert.throws(() => analyticsPool("postgres://reader@ep-test-pooler.neon.tech/db?sslmode=verify-full", "test"), { message: "Analytics requires direct endpoints without custom connection options" });
  assert.throws(() => analyticsPool("postgres://reader@EP-TEST-POOLER.neon.tech/db?sslmode=verify-full", "test"), { message: "Analytics requires direct endpoints without custom connection options" });
  assert.throws(() => analyticsPool("postgres://reader@ep-test%2dpooler.neon.tech/db?sslmode=verify-full", "test"), { message: "Analytics requires direct endpoints without custom connection options" });
  assert.throws(() => analyticsPool("postgres://reader@ep-test-pooler%2eneon.tech/db?sslmode=verify-full", "test"), { message: "Analytics requires direct endpoints without custom connection options" });
  assert.throws(() => analyticsPool("postgres://reader@ep-test-pooler.neon.tech/db?host=&sslmode=verify-full", "test"), { message: "Analytics requires direct endpoints without custom connection options" });
  assert.throws(() => analyticsPool("postgres://reader@127.0.0.1/db?options=private", "test"), { message: "Analytics requires direct endpoints without custom connection options" });
  assert.throws(() => analyticsPool("postgres://reader@remote.invalid/db?sslmode=verify-full&sslmode=disable", "test"), { message: "Analytics database URLs must not repeat query parameters" });
  assert.throws(() => analyticsPool("postgres://reader@remote.invalid/db?host=localhost&host=remote.invalid", "test"), { message: "Analytics database URLs must not repeat query parameters" });
  assert.throws(() => readApiConfig({}), { message: "ANALYTICS_READ_DATABASE_URL is required" });
  assert.throws(() => readApiConfig({ ANALYTICS_READ_DATABASE_URL: "postgres://fixture@127.0.0.1/db" }), { message: "ANALYTICS_API_TOKEN is required" });
  assert.deepEqual(readApiConfig({ ANALYTICS_READ_DATABASE_URL: "postgres://fixture@127.0.0.1/db", ANALYTICS_API_TOKEN: token }), { databaseUrl: "postgres://fixture@127.0.0.1/db", token, port: 8080 });
  assert.equal(readApiConfig({ ANALYTICS_READ_DATABASE_URL: "postgres://fixture@127.0.0.1/db", ANALYTICS_API_TOKEN: token, PORT: "65535" }).port, 65535);
  assert.equal(readApiConfig({ ANALYTICS_READ_DATABASE_URL: "postgres://fixture@127.0.0.1/db", ANALYTICS_API_TOKEN: token, PORT: "1" }).port, 1);
  assert.throws(() => readApiConfig({ ANALYTICS_READ_DATABASE_URL: "   " }), { message: "ANALYTICS_READ_DATABASE_URL is required" });
  assert.throws(() => readApiConfig({ PORT: "80 " }), { message: "Invalid PORT" });
  assert.throws(() => readApiConfig({ PORT: "65536" }), { message: "Invalid PORT" });
  assert.throws(() => readApiConfig({ PORT: "0" }), { message: "Invalid PORT" });
  assert.throws(() => readApiConfig({ PORT: " 80" }), { message: "Invalid PORT" });
});
