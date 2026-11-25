import assert from "node:assert/strict";
import test from "node:test";

import { POST } from "#web/app/api/launchpad/market/timing/route.ts";
import { ClockOffset, createLiveTiming, frameSegments, LIVE_TIMING_PATH, parseTimingReport, percentile, TIMING_REPORT_MS } from "./live-timing.ts";

// This fails if the reported p50/p95 are not nearest-rank over the minute's samples.
test("percentile is nearest rank", () => {
  const sorted = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(sorted, 0.5), 10);
  assert.equal(percentile(sorted, 0.95), 19);
  assert.equal(percentile([7], 0.95), 7);
});

// This fails if the offset comes from a slow round trip, which would hide a hop as big as rtt/2.
test("the clock keeps the smallest round trip", () => {
  const clock = new ClockOffset();
  assert.equal(clock.offset, null);
  clock.sample(1_000, 1_600, 1_400); // rtt 400: server is 400 ahead
  clock.sample(2_000, 2_510, 2_020); // rtt 20: server is 500 ahead
  clock.sample(3_000, 3_900, 3_300); // rtt 300: ignored
  assert.equal(clock.rtt, 20);
  assert.equal(clock.offset, 500);
});

// This fails if a hop is measured across two clocks without the offset, or a stale replay counts.
test("frame segments use engine stamps, the relay stamp and the browser offset", () => {
  const hops = { arrived_ms: 10_000, intake_committed_ms: 10_060, written_ms: 10_180, picked_ms: 10_340, relay_ms: 10_350 };
  // Browser clock is 500 behind the server: receipt 9_900 browser = 10_400 server.
  assert.deepEqual(frameSegments({ timestampMs: 9_700, hops }, 9_900, 9_916, 500), {
    intake: 60, market: 120, reader: 160, hints: 10, wire: 50, paint: 16, chain: 716,
  });
  assert.deepEqual(frameSegments({ timestampMs: 9_700, hops }, 9_900, 9_916, null), { intake: 60, market: 120, reader: 160, hints: 10, paint: 16 });
  assert.deepEqual(frameSegments({ timestampMs: 1, hops: null }, 500_000, 500_010, 0), { paint: 10 });
});

// This fails if a sampled tab never pings, reports with the wrong clock, or reports nothing.
test("a sampled tab pings its socket and sends one beacon a minute", () => {
  let now = 100_000;
  const timers: { run: () => void; at: number }[] = [];
  const sent: string[] = [];
  const beacons: [string, string][] = [];
  const timing = createLiveTiming({
    now: () => now,
    schedule: (run, ms) => { timers.push({ run, at: now + ms }); },
    afterPaint: (run) => { now += 16; run(); },
    visible: () => true,
    send: (path, body) => { beacons.push([path, body]); },
  });
  const advance = (ms: number) => {
    for (const end = now + ms; now < end;) {
      now = Math.min(end, now + 1_000);
      for (const timer of timers.filter((t) => t.at <= now)) { timers.splice(timers.indexOf(timer), 1); timer.run(); }
    }
  };
  timing.socket({ send: (text) => { sent.push(text); return true; } });
  advance(1_000);
  assert.deepEqual(JSON.parse(sent[0]!), { op: "ping", t: 101_000 });
  now += 40;
  timing.pong(JSON.stringify({ t: 101_000, server_ms: 101_020 })); // offset 0, rtt 40
  timing.market(JSON.stringify({ timestamp_ms: now - 700, provenance: { hops: { picked_ms: now - 30, relay_ms: now - 20 } } }));
  advance(TIMING_REPORT_MS);
  assert.equal(sent.length, 3, "pings at 1, 3 and 5 s, then once a minute");
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0]![0], LIVE_TIMING_PATH);
  const report = parseTimingReport(JSON.parse(beacons[0]![1]));
  assert.deepEqual(report, {
    transport: "socket",
    offset_rtt_ms: 40,
    hops: { hints: { n: 1, p50: 10, p95: 10 }, wire: { n: 1, p50: 20, p95: 20 }, paint: { n: 1, p50: 16, p95: 16 }, chain: { n: 1, p50: 716, p95: 716 } },
  });
  advance(TIMING_REPORT_MS);
  assert.equal(beacons.length, 1, "an empty minute sends nothing");
});

// This fails if the beacon route logs arbitrary keys or accepts oversized bodies.
test("the timing route accepts only a known report", async () => {
  const post = (body: string) => POST(new Request("http://localhost/api/launchpad/market/timing", { method: "POST", body }));
  const good = { transport: "socket", offset_rtt_ms: 40, hops: { wire: { n: 3, p50: 20, p95: 31 } } };
  assert.equal((await post(JSON.stringify(good))).status, 204);
  assert.equal((await post(JSON.stringify({ ...good, hops: { secret: { n: 1, p50: 1, p95: 1 } } }))).status, 400);
  assert.equal((await post(JSON.stringify({ ...good, hops: { wire: { n: 1, p50: 1, p95: 1, x: "y" } } }))).status, 400);
  assert.equal((await post(JSON.stringify({ ...good, transport: "carrier-pigeon" }))).status, 400);
  assert.ok([400, 413].includes((await post("x".repeat(3_000))).status), "oversized");
  assert.equal((await post("{")).status, 400);
});
