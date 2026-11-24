import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";

import { createHintObservationReporter, recordBrowserHintObservation } from "./hint-observations.ts";

let now = () => 1;
let random = () => 0;
beforeEach(() => {
  now = () => 1;
  random = () => 0;
  mock.method(performance, "now", () => now());
  mock.method(Math, "random", () => random());
});
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  mock.restoreAll();
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

/** Fake the browser's analytics, clock and random boundaries, without production options. */
function reporter(ports: Readonly<{
  browser?: () => boolean;
  now?: () => number;
  random?: () => number;
  send?: (name: string, fields: Record<string, string | number | boolean>) => void;
}> = {}) {
  Object.defineProperty(globalThis, "window", { configurable: true, get: () => (ports.browser?.() ?? true) ? {
    va: (_event: string, payload: { name: string; data: Record<string, string | number | boolean> }) => ports.send?.(payload.name, payload.data),
  } : undefined });
  now = ports.now ?? (() => 1);
  random = ports.random ?? (() => 0);
  return createHintObservationReporter();
}

test("hint observations use fixed labels, drop private fields, and label refresh evidence honestly", () => {
  const seen: unknown[] = [];
  const report = reporter({ browser: () => true, random: () => 0, now: () => 10, send: (...args) => seen.push(args) });
  report("social.activity_hints", { event: "painted", surface: "feed_new", ms: 42.4, wallet: "private", presale: "private", url: "private" });
  report("social.activity_hints", { event: "refetch", surface: "happening", cause: "hint", id: "private" });
  report("social.activity_hints", { event: "hint", kind: "presale_lifecycle", presaleId: "private" });
  assert.deepEqual(seen, [
    ["social_hint_observation", { event: "refresh_completed", surface: "feed_new", ms: 42, freshness: "unverified", sampleRate: 0.02, capPerMinute: 20 }],
    ["social_hint_observation", { event: "refetch", surface: "happening", cause: "hint", sampleRate: 0.02, capPerMinute: 20 }],
    ["social_hint_observation", { event: "hint", kind: "presale_lifecycle", sampleRate: 0.02, capPerMinute: 20 }],
  ]);
});

test("hint observations reject unknown labels and invalid durations before sampling", () => {
  let sampled = 0;
  const report = reporter({ browser: () => true, random: () => { sampled += 1; return 0; }, send: () => assert.fail("invalid event sent") });
  report("private", { event: "connect" });
  for (const fields of [
    { event: "wallet" }, { event: "hint", kind: "private" }, { event: "refetch", surface: "0xprivate", cause: "hint" },
    { event: "refetch", surface: "queries", cause: "private" }, { event: "unavailable", reason: "private" },
    { event: "reconnect", failures: Number.POSITIVE_INFINITY }, { event: "painted", surface: "happening", ms: -1 },
    { event: "painted", surface: "feed_new", ms: Number.NaN }, { event: "painted", surface: "feed_new", ms: 300_001 },
  ]) report("social.activity_hints", fields);
  assert.equal(sampled, 0);
});

test("every existing fixed hint surface is observed without dynamic labels", () => {
  const seen: string[] = [];
  const report = reporter({ browser: () => true, random: () => 0, now: () => 1, send: (_name, fields) => seen.push(String(fields.surface)) });
  const surfaces = ["feed_new", "happening", "queries", "blast-ticker", "home", "blast-lanes"];
  for (const surface of surfaces) report("social.activity_hints", { event: "painted", surface, ms: 5 });
  assert.deepEqual(seen, surfaces);
});

test("probability sampling and a rolling per-tab budget bound output without retries", () => {
  let time = 1;
  let draw = 0.5;
  const seen: unknown[] = [];
  const report = reporter({ browser: () => true, random: () => draw, now: () => time, send: (...args) => seen.push(args) });
  report("social.activity_hints", { event: "connect" });
  assert.equal(seen.length, 0);
  draw = 0;
  for (let i = 0; i < 1_000; i += 1) report("social.activity_hints", { event: "connect" });
  assert.equal(seen.length, 20);
  time += 59_999;
  report("social.activity_hints", { event: "connect" });
  assert.equal(seen.length, 20);
  time += 1;
  report("social.activity_hints", { event: "connect" });
  assert.equal(seen.length, 21);
});

test("the budget does not allow a double burst across a fixed minute boundary", () => {
  let time = 0;
  let sent = 0;
  const report = reporter({ browser: () => true, random: () => 0, now: () => time, send: () => { sent += 1; } });
  for (let i = 0; i < 10; i += 1) report("social.activity_hints", { event: "connect" });
  time = 59_999;
  for (let i = 0; i < 10; i += 1) report("social.activity_hints", { event: "connect" });
  time = 60_000;
  for (let i = 0; i < 100; i += 1) report("social.activity_hints", { event: "connect" });
  assert.equal(sent, 30);
  time = 60_001;
  report("social.activity_hints", { event: "connect" });
  assert.equal(sent, 30);
});

test("observation failures stay isolated and even a throwing sink consumes its bounded budget", () => {
  let calls = 0;
  const broken = () => { throw new Error("telemetry unavailable"); };
  for (const port of ["browser", "random", "now"] as const) {
    const report = reporter({ browser: () => true, random: () => 0, now: () => 1, send: broken, [port]: broken });
    assert.doesNotThrow(() => report("social.activity_hints", { event: "connect" }));
  }
  const report = reporter({ browser: () => true, random: () => 0, now: () => 1, send: () => { calls += 1; broken(); } });
  for (let i = 0; i < 100; i += 1) assert.doesNotThrow(() => report("social.activity_hints", { event: "connect" }));
  assert.equal(calls, 20);
  assert.doesNotThrow(() => report("social.activity_hints", Object.defineProperty({}, "event", { get: broken })));
});

test("server mode and invalid sampler/clock values emit nothing", () => {
  const fail = () => assert.fail("observation emitted");
  reporter({ browser: () => false, random: fail, now: fail, send: fail })("social.activity_hints", { event: "connect" });
  for (const random of [() => Number.NaN, () => -1, () => 1]) {
    reporter({ browser: () => true, random, now: () => 1, send: fail })("social.activity_hints", { event: "connect" });
  }
  for (const now of [() => Number.NaN, () => -1, () => Number.POSITIVE_INFINITY]) {
    reporter({ browser: () => true, random: () => 0, now, send: fail })("social.activity_hints", { event: "connect" });
  }
});

test("the default browser reporter reaches the installed analytics transport", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events: unknown[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { va: (...args: unknown[]) => events.push(args) } });
  try {
    recordBrowserHintObservation("social.activity_hints", { event: "painted", surface: "happening", ms: 123 });
    assert.deepEqual(events, [["event", { name: "social_hint_observation", data: {
      event: "refresh_completed", surface: "happening", ms: 123, freshness: "unverified", sampleRate: 0.02, capPerMinute: 20,
    }, options: undefined }]]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
