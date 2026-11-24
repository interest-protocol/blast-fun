import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult, QueryResultRow } from "pg";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createAfterResponseScheduler, createRequestWork, runWithRequestWork, trackRequestWork } from "@blast/server/lib/request-work.ts";
import { createHappeningReader, readHappening } from "@blast/server/modules/social/happening/read.ts";
import { createSocialHappeningRoute } from "@blast/server/modules/social/happening/route.ts";
import { deferred } from "../../../../../core/test/kit.ts";

const config = SOCIAL_CONFIG_DEFAULTS;
const NOW = 1_000_000;
const hiddenKinds = ["trade_buy", "trade_sell"];
type Kind = "bounds" | "asOf" | "lastHour" | "tape" | "candidates" | "pins" | "topCoins" | "chips" | "windows" | "interested";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function queryKind(sql: string): Kind {
  if (sql.includes("FROM chain_read_v1.watermark")) return sql.includes("observed_ms") ? "asOf" : "bounds";
  if (sql.includes("SELECT count(DISTINCT a.actor)")) return "lastHour";
  if (sql.startsWith("SELECT l.activity_id")) return "tape";
  if (sql.includes("'open' AS role")) return "candidates";
  if (sql.includes("FROM social_presale_pins")) return "pins";
  if (sql.startsWith("SELECT market.*")) return "topCoins";
  if (sql.includes("coalesce(p.sale_symbol,'') AS symbol")) return "chips";
  if (sql.startsWith("SELECT a.presale_id, sum")) return "windows";
  assert.match(sql, /SELECT f.target_id/);
  return "interested";
}

function fixture() {
  const calls: { kind: Kind; values: readonly unknown[] }[] = [];
  const gates = new Map<Kind, Promise<void>>();
  const failures = new Map<Kind, Error>();
  const asyncFailures = new Map<Kind, Error>();
  let missingWatermark = false;
  const rows = (kind: Kind): unknown[] => {
    switch (kind) {
      case "bounds": case "asOf": return missingWatermark ? [] : [{ market_checkpoint: "10", market_timestamp_ms: String(NOW - 200), presale_checkpoint: "11", presale_timestamp_ms: String(NOW - 100), observed_ms: String(NOW) }];
      case "lastHour": return [{ wallets: 2, usd: "12.50", unpriced: 0 }];
      case "tape": return [{ activity_id: "11:0:0:0", kind: "presale_commit", timestamp_ms: String(NOW - 300), actor: "0x12345678", presale_id: "sale", usd_value: "12.50", coin_amount: null, quote_refund: null, symbol: "SALE", sale_decimals: 9, quote_decimals: 6, quote_symbol: "USDC", callsign: "alice", display_name: "Alice", avatar_url: null, x_handle: null, verified: true }];
      case "candidates": return [{ presale_id: "sale", role: "open", launched_ms: null, sort_ms: String(NOW + 100) }];
      case "pins":
        return [
          {
            presale_id: "sale",
            launched_ms: null,
            cover_key: "covers/sale.png",
            cover_url: "https://example.test/cover.png",
            cover_width: 10,
            cover_height: 20,
          },
        ];
      case "topCoins": return [{ coin_type: "coin", presale_id: "sale", name: "Sale", symbol: "SALE", icon_url: null, price_usd: "2", price_24h_usd: "1", buyers_24h: 1, holders: 2 }];
      case "chips": return [{ presale_id: "sale", symbol: "SALE", name: "Sale", icon_url: "https://example.test/coin.png", lifecycle: "open", decimals: 9, venue: "cetus", start_ms: "0", end_ms: String(NOW + 100), raise_target: "100", raised: "20", participants: "2", quote_type: "usdc", quote_symbol: "USDC", quote_decimals: 6, presale_price_quote: null, quote_usd: "1", quote_usd_as_of_ms: String(NOW), sale_usd: null, sale_usd_as_of_ms: null }];
      case "windows": return [{ presale_id: "sale", raised: "10" }];
      case "interested": return [{ presale_id: "sale", interested: 3 }];
    }
  };
  const db: ReadableDatabase = {
    read<Row extends QueryResultRow>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
      const kind = queryKind(sql);
      calls.push({ kind, values });
      // A non-async adapter deliberately exercises synchronous query refusal.
      if (failures.has(kind)) throw failures.get(kind);
      return Promise.resolve(gates.get(kind)).then(() => {
        if (asyncFailures.has(kind)) throw asyncFailures.get(kind);
        const result = rows(kind);
        return { rows: result, rowCount: result.length, command: "SELECT", oid: 0, fields: [] } as QueryResult<Row>;
      });
    },
  };
  return { db, calls, gates, failures, asyncFailures, missing(value: boolean) { missingWatermark = value; }, count: (kind: Kind) => calls.filter((call) => call.kind === kind).length };
}

test("overlapping Happening requests share one source and clock, retain no settled answer, and match the direct read", async () => {
  const source = fixture();
  const gate = deferred();
  source.gates.set("bounds", gate.promise);
  let sources = 0;
  let clocks = 0;
  const read = createHappeningReader(() => { sources += 1; return { read: source.db.read }; }, () => { clocks += 1; return NOW; });
  const first = read({ config, hiddenKinds: [] });
  const second = read({ config, hiddenKinds: [] });
  await tick();
  assert.equal(sources, 1, "fresh database wrappers do not split a service-owned source context");
  gate.resolve();
  const [one, two] = await Promise.all([first, second]);
  assert.deepEqual(one, two);
  assert.equal(clocks, 1);
  assert.equal(source.calls.length, 10);
  assert.equal(one.clock_ms, NOW - 100);
  assert.deepEqual(one.as_of, { checkpoint: 10, timestamp_ms: NOW - 200, lag_ms: 200 });
  assert.deepEqual(source.calls.find((call) => call.kind === "topCoins")?.values, [NOW - 200, NOW, 10]);
  assert.deepEqual(source.calls.find((call) => call.kind === "pins")?.values, [8, NOW]);
  const direct = fixture();
  assert.deepEqual(one, await readHappening(direct.db, { config, nowMs: NOW, hiddenKinds: [] }));
  assert.deepEqual(source.calls, direct.calls, "sharing changes no SQL inputs or query count for a producer");
  await read({ config, hiddenKinds: [] });
  assert.equal(sources, 2);
  assert.equal(clocks, 2);
  assert.equal(source.calls.length, 20);
});

test("Happening keys canonicalize visibility, separate selection settings and route sources, and ignore unused config", async () => {
  const source = fixture();
  const gate = deferred();
  source.gates.set("bounds", gate.promise);
  const read = createHappeningReader(() => source.db, () => NOW);
  const pending = [
    read({ config, hiddenKinds }),
    read({ config, hiddenKinds: ["trade_sell", "trade_buy", "trade_buy"] }),
    read({ config: { ...config, big_commit_usd: "999" }, hiddenKinds }),
    read({ config: { ...config, fastest_window_ms: config.fastest_window_ms + 1 }, hiddenKinds }),
    read({ config, hiddenKinds: [] }),
  ];
  const other = fixture();
  const otherRead = createHappeningReader(() => other.db, () => NOW);
  await tick();
  assert.equal(source.count("bounds"), 3);
  gate.resolve();
  await Promise.all(pending);
  assert.deepEqual(source.calls.filter((call) => call.kind === "windows").map((call) => call.values[2]), [config.fastest_window_ms, config.fastest_window_ms + 1, config.fastest_window_ms]);
  assert.equal(source.count("topCoins"), 1);
  assert.equal((await otherRead({ config, hiddenKinds })).fastest.length, 1);
  assert.equal(other.count("bounds"), 1);
});

test("each Happening consumer receives independent nested response objects", async () => {
  const source = fixture();
  const read = createHappeningReader(() => source.db, () => NOW);
  const [one, two] = await Promise.all([read({ config, hiddenKinds: [] }), read({ config, hiddenKinds: [] })]);
  const expected = structuredClone(two);
  assert.notStrictEqual(one.fastest[0]!.presale, two.fastest[0]!.presale);
  Reflect.set(one.fastest[0]!.presale, "name", "changed");
  Reflect.set(one.tape[0]!.actor, "callsign", "changed");
  const cover = one.today[0]!.cover;
  assert.ok(cover, "the fixture must exercise a stored cover");
  Reflect.set(cover, "url", "changed");
  Reflect.set(one.top_coins!.trending[0]!, "symbol", "changed");
  Reflect.set(one.as_of, "lag_ms", 999);
  assert.deepEqual(two, expected);
});

test("Happening shares only pending failures, recovers missing watermarks, and keeps Top coins optional", async () => {
  const source = fixture();
  const read = createHappeningReader(() => source.db, () => NOW);
  source.missing(true);
  const failed = await Promise.allSettled([read({ config, hiddenKinds: [] }), read({ config, hiddenKinds: [] })]);
  assert.ok(failed.every((entry) => entry.status === "rejected" && entry.reason.code === "service_unavailable"));
  assert.equal(source.count("bounds"), 1);
  assert.equal(source.count("lastHour"), 0);
  source.missing(false);
  source.failures.set("topCoins", new Error("optional market read"));
  assert.equal((await read({ config, hiddenKinds: [] })).top_coins, null);
  assert.equal(source.count("bounds"), 2);
});

for (const [failureKind, delayedKind] of [["bounds", "asOf"], ["tape", "pins"], ["windows", "chips"]] as const) {
  for (const mode of ["synchronous", "asynchronous"] as const) {
  test(`Happening ${mode} ${failureKind} failure waits for its ${delayedKind} sibling before releasing the shared fill`, async () => {
    const source = fixture();
    const gate = deferred();
    source.gates.set(delayedKind, gate.promise);
    const failure = new Error(`${failureKind} failed`);
    const failures = mode === "synchronous" ? source.failures : source.asyncFailures;
    failures.set(failureKind, failure);
    const read = createHappeningReader(() => source.db, () => NOW);
    let settled = false;
    const first = read({ config, hiddenKinds: [] });
    void first.then(() => { settled = true; }, () => { settled = true; });
    await tick();
    assert.equal(source.count(delayedKind), 1);
    assert.equal(settled, false);
    const second = read({ config, hiddenKinds: [] });
    await tick();
    assert.equal(source.count("bounds"), 1);
    gate.resolve();
    const outcomes = await Promise.allSettled([first, second]);
    assert.ok(outcomes.every((entry) => entry.status === "rejected" && entry.reason === failure));
    failures.clear();
    assert.equal((await read({ config, hiddenKinds: [] })).fastest.length, 1);
    assert.equal(source.count("bounds"), 2);
  });
  }
}

test("one disconnected Happening caller cannot cancel the producer or release tracked work before its query settles", async () => {
  const source = fixture();
  const gate = deferred();
  source.gates.set("tape", gate.promise);
  const read = createHappeningReader(() => source.db, () => NOW);
  const scheduler = createAfterResponseScheduler();
  const first = createRequestWork(scheduler);
  const second = createRequestWork(scheduler);
  const disconnect = new AbortController();
  const one = runWithRequestWork(first, () => trackRequestWork(read({ config, hiddenKinds: [] })), disconnect.signal);
  const two = runWithRequestWork(second, () => trackRequestWork(read({ config, hiddenKinds: [] })));
  await tick();
  disconnect.abort(new Error("disconnected"));
  let released = false;
  const completion = first.complete().then(() => { released = true; });
  await tick();
  assert.equal(released, false);
  assert.equal(source.count("tape"), 1);
  gate.resolve();
  const responses = await Promise.all([one, two]);
  assert.deepEqual(responses[0], responses[1]);
  await Promise.all([completion, second.complete()]);
  assert.equal(released, true);
});

test("Happening route admission precedes shared lookup and trading visibility remains isolated", async () => {
  const source = fixture();
  const gate = deferred();
  source.gates.set("bounds", gate.promise);
  let admissions = 0;
  let configReads = 0;
  let allowed = true;
  const kit = createSocialRouteKit({
    tradingVisible: (request) => request.headers.has("x-test-trades"),
    expectedOrigin: "https://example.test",
    verifyAccessToken: async () => { throw new Error("public route must not authenticate"); },
    limiter: { async consume(bucket) { admissions += 1; return { allowed, bucket, policyVersion: 1, retryAfterSeconds: 7 }; } },
    accounts: { resolve: async () => null, resolveWallet: async () => null },
    primary: () => { throw new Error("read route must not access primary"); },
    metricSampleRate: 0,
  });
  const route = createSocialHappeningRoute({ kit, database: () => source.db, config: async () => { configReads += 1; return config; }, now: () => NOW });
  const request = (trading = false) => new Request("https://example.test/api/social/happening", { headers: trading ? { "x-test-trades": "yes" } : {} });
  const first = route.GET(request(), testClient());
  await tick();
  allowed = false;
  const denied = await route.GET(request(), testClient());
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "7");
  assert.equal(configReads, 1);
  assert.equal(source.count("bounds"), 1);
  allowed = true;
  const withTrades = route.GET(request(true), testClient());
  await tick();
  assert.equal(source.count("bounds"), 2);
  gate.resolve();
  const [hidden, visible] = await Promise.all([first, withTrades]);
  assert.equal(hidden.status, 200);
  assert.equal(visible.status, 200);
  assert.equal((await hidden.json()).top_coins, null);
  assert.equal((await visible.json()).top_coins.trending.length, 1);
  assert.equal(admissions, 3);
});
