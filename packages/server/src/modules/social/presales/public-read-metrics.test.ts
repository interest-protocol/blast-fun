import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { createForYouNewReader } from "@blast/server/modules/social/feed/feed-reader.ts";
import { createHappeningReader } from "@blast/server/modules/social/happening/read.ts";
import { createPublicPresaleReader } from "@blast/server/modules/social/presales/public-reads.ts";

function enableMetrics(t: TestContext, value = "on") {
  const previous = process.env.MISSION_CONTROL_METRICS;
  process.env.MISSION_CONTROL_METRICS = value;
  t.after(() => {
    if (previous === undefined) delete process.env.MISSION_CONTROL_METRICS;
    else process.env.MISSION_CONTROL_METRICS = previous;
  });
}

function observations(t: TestContext) {
  enableMetrics(t);
  const lines: Record<string, unknown>[] = [];
  t.mock.method(Math, "random", () => 0);
  t.mock.method(console, "info", (line: string) => { lines.push(JSON.parse(line)); });
  return () => lines.filter((line) => line.metric === "social.public_read.share");
}

test("sharing observations distinguish fills, in-flight joins and separate keys without request data", async (t) => {
  const observed = observations(t);
  const share = createPublicPresaleReader(Date.now, "feed_new");
  let release!: (value: object) => void;
  const pending = new Promise<object>((resolve) => { release = resolve; });
  let loads = 0;
  const load = () => { loads += 1; return pending; };
  const first = share("private-wallet-config-key", load, 0);
  const joined = share("private-wallet-config-key", load, 0);
  const separate = share("private-hidden-kind-key", load, 0);
  assert.equal(first, joined);
  assert.notEqual(first, separate);
  assert.equal(loads, 0, "instrumentation preserves loader microtask deferral");
  assert.deepEqual(observed().map(({ outcome }) => outcome), ["fill", "join", "fill"]);

  const value = {};
  release(value);
  assert.deepEqual(await Promise.all([first, joined, separate]), [value, value, value]);
  assert.equal(loads, 2);
  const fresh = share("private-wallet-config-key", load, 0);
  assert.notEqual(fresh, first);
  assert.equal(await fresh, value);
  assert.equal(loads, 3);
  assert.deepEqual(observed().map(({ outcome }) => outcome), ["fill", "join", "fill", "fill"]);
  for (const line of observed()) {
    assert.deepEqual(Object.keys(line).sort(), ["at", "level", "metric", "outcome", "reader", "sampleRate"]);
    assert.equal(line.level, 30);
    assert.equal(line.reader, "feed_new");
    assert.equal(line.sampleRate, 0.02);
    assert.doesNotMatch(JSON.stringify(line), /private|wallet|config|hidden/);
  }
});

test("a retained result is observed as a hit rather than an in-flight join", async (t) => {
  const observed = observations(t);
  let now = 0;
  const share = createPublicPresaleReader(() => now, "happening");
  const first = share("key", async () => 1, 10);
  assert.equal(await first, 1);
  assert.equal(share("key", async () => 2, 10), first);
  now = 10;
  assert.equal(await share("key", async () => 2, 10), 2);
  assert.deepEqual(observed().map(({ reader, outcome }) => ({ reader, outcome })), [
    { reader: "happening", outcome: "fill" },
    { reader: "happening", outcome: "hit" },
    { reader: "happening", outcome: "fill" },
  ]);
});

for (const failingComponent of ["sampler", "sink"] as const) {
  test(`sharing preserves rejection identity and recovery when the metric ${failingComponent} throws`, async (t) => {
    enableMetrics(t);
    const telemetryFailure = new Error("telemetry failure");
    t.mock.method(Math, "random", () => {
      if (failingComponent === "sampler") throw telemetryFailure;
      return 0;
    });
    t.mock.method(console, "info", () => { throw telemetryFailure; });
    const share = createPublicPresaleReader(Date.now, "feed_new");
    const sourceFailure = new Error("private source error");
    let loads = 0;
    const first = share("private key", () => { loads += 1; throw sourceFailure; }, 0);
    const joined = share("private key", async () => 99, 0);
    assert.equal(first, joined);
    assert.equal(loads, 0);
    const results = await Promise.allSettled([first, joined]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.equal(result.reason, sourceFailure);
    }
    assert.equal(loads, 1);
    const recovered = share("private key", async () => 42, 0);
    assert.notEqual(recovered, first);
    assert.equal(await recovered, 42);
  });
}

test("metrics-off and unlabeled readers skip both the sampler and sink", async (t) => {
  enableMetrics(t, "off");
  const random = t.mock.method(Math, "random", () => { throw new Error("unexpected sampler"); });
  const info = t.mock.method(console, "info", () => { throw new Error("unexpected sink"); });
  for (const share of [createPublicPresaleReader(Date.now, "feed_new"), createPublicPresaleReader()]) {
    const first = share("key", async () => 42, 0);
    assert.equal(share("key", async () => 99, 0), first);
    assert.equal(await first, 42);
  }
  process.env.MISSION_CONTROL_METRICS = "on";
  assert.equal(await createPublicPresaleReader()("key", async () => 42, 0), 42);
  assert.equal(random.mock.callCount(), 0);
  assert.equal(info.mock.callCount(), 0);
});

test("the feed and Happening factories wire their fixed sharing labels", async (t) => {
  const observed = observations(t);
  const sourceFailure = new Error("private database error");
  const db: ReadableDatabase = { read: async () => { throw sourceFailure; } };
  let sourceReads = 0;
  const database = () => { sourceReads += 1; return db; };
  const feed = createForYouNewReader(database);
  const happening = createHappeningReader(database);
  const config = SOCIAL_CONFIG_DEFAULTS;
  const results = await Promise.allSettled([
    feed({ config, sinceMs: 0, hiddenKinds: [] }),
    feed({ config, sinceMs: 1, hiddenKinds: [] }),
    happening({ config, hiddenKinds: [] }),
    happening({ config, hiddenKinds: [] }),
  ]);
  assert.equal(sourceReads, 2);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason, sourceFailure);
  }
  assert.deepEqual(observed().map(({ reader, outcome }) => ({ reader, outcome })), [
    { reader: "feed_new", outcome: "fill" },
    { reader: "feed_new", outcome: "join" },
    { reader: "happening", outcome: "fill" },
    { reader: "happening", outcome: "join" },
  ]);
});
