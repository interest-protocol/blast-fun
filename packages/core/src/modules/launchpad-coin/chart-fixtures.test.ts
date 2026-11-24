import assert from "node:assert/strict";
import test from "node:test";

import { CANDLE_INTERVALS, parsePoolCandlePage } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { candleFixtureBody } from "../../../test/fixtures/modules/launchpad-coin/chart-fixtures.ts";
import { CURVE_POOL_KEY, VENUE_POOL_KEY } from "../../../test/fixtures/modules/launchpad-coin/fixtures.ts";

const NOW = 1_790_400_000_000;

test("the fixture engine's per-pool candles meet the contract at every interval, around the committed migration", () => {
  for (const interval of CANDLE_INTERVALS) {
    const curve = parsePoolCandlePage(CURVE_POOL_KEY, interval, candleFixtureBody("curve", "migrated", { interval }, NOW));
    const venue = parsePoolCandlePage(VENUE_POOL_KEY, interval, candleFixtureBody("venue", "migrated", { interval }, NOW));
    assert.ok(curve.candles.length > 0 && venue.candles.length > 0, interval);
    assert.deepEqual(curve.migration, venue.migration);
    assert.equal(curve.migration?.cursor, "326100000:2:5:0");
    assert.equal(curve.migration?.timestampMs, 1_790_230_000_000);
  }
  // At 1m the curve has a gap (no trades) and so does the venue; both trade in the migration's bucket at 5m.
  const curve = parsePoolCandlePage(CURVE_POOL_KEY, "1m", candleFixtureBody("curve", "migrated", { interval: "1m" }, NOW));
  const starts = curve.candles.map((candle) => candle.bucketStart);
  assert.ok(starts.slice(1).some((start, index) => start - starts[index] > 60_000), "the curve has a gap");
  const at5m = (source: "curve" | "venue") =>
    parsePoolCandlePage(source === "curve" ? CURVE_POOL_KEY : VENUE_POOL_KEY, "5m", candleFixtureBody(source, "migrated", { interval: "5m" }, NOW)).candles.map(
      (candle) => candle.bucketStart,
    );
  assert.ok(at5m("curve").some((start) => at5m("venue").includes(start)));
});

test("before migration the curve page names no migration; pages are bounded like blast-infra's", () => {
  const live = parsePoolCandlePage(CURVE_POOL_KEY, "1m", candleFixtureBody("curve", "live", { interval: "1m" }, NOW));
  assert.equal(live.migration, null);
  const all = parsePoolCandlePage(CURVE_POOL_KEY, "1m", candleFixtureBody("curve", "migrated", { interval: "1m" }, NOW));
  const newest = parsePoolCandlePage(CURVE_POOL_KEY, "1m", candleFixtureBody("curve", "migrated", { interval: "1m", limit: 2 }, NOW));
  assert.deepEqual(newest.candles, all.candles.slice(-2));
  const before = all.candles.at(-1)!.bucketStart;
  const older = parsePoolCandlePage(CURVE_POOL_KEY, "1m", candleFixtureBody("curve", "migrated", { interval: "1m", to: before, from: all.candles[1].bucketStart }, NOW));
  assert.deepEqual(older.candles, all.candles.slice(1, -1));
});

test("the dev fixture server serves each pool's candles to the app's server, with a venue outage and an untracked venue", async () => {
  const { startCoinFixtureServer } = await import("../../../test/fixtures/modules/launchpad-coin/fixture-server.ts");
  const { COIN_FIXTURE } = await import("../../../test/fixtures/modules/launchpad-coin/fixtures.ts");
  const server = await startCoinFixtureServer({ now: () => NOW });
  try {
    const get = (path: string) => fetch(new URL(path, server.origin), { headers: { Origin: "http://127.0.0.1:3191" } });
    const curvePath = `/v1/pools/blast_curve/${COIN_FIXTURE.launchId}/candles?interval=5m&limit=500`;
    const venuePath = `/v1/pools/bluefin/${COIN_FIXTURE.venuePoolId}/candles?interval=5m&limit=500`;
    Object.assign(server.state, { indexed: "migrated", fresh: "migrated" });
    const curve = await get(curvePath);
    assert.equal(curve.status, 200);
    assert.equal(curve.headers.get("access-control-allow-origin"), null, "no browser reads it: only the app's server (WP2)");
    assert.equal(parsePoolCandlePage(CURVE_POOL_KEY, "5m", await curve.json()).migration?.venuePoolKey, VENUE_POOL_KEY);
    assert.equal((await get(venuePath)).status, 200);
    assert.equal((await get(`/v1/pools/blast_curve/${COIN_FIXTURE.launchId}/candles?interval=2m`)).status, 400);

    Object.assign(server.state, { venue: "down" });
    assert.equal((await get(venuePath)).status, 503);
    assert.equal((await get(curvePath)).status, 200, "the curve's history stays readable");

    Object.assign(server.state, { venue: "untracked" });
    const untracked = parsePoolCandlePage(CURVE_POOL_KEY, "5m", await (await get(curvePath)).json());
    assert.equal(untracked.migration?.venuePoolKey, null);
    assert.equal((await get(venuePath)).status, 404);
  } finally {
    await server.close();
  }
});
