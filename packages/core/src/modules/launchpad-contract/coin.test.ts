import assert from "node:assert/strict";
import test from "node:test";

import { parseCoinSummary, parseVenuePool } from "./coin.ts";
import { COIN_FIXTURE, VENUE_POOL_KEY, coinBody, venuePoolSummary } from "../../../test/fixtures/modules/launchpad-coin/fixtures.ts";

function read(over: Record<string, unknown> = {}) {
  return parseVenuePool({ pool: { ...venuePoolSummary(), ...over } }, VENUE_POOL_KEY, COIN_FIXTURE.coinType);
}

test("venue market cap converts quote atoms using that pool's USD stamp exactly", () => {
  assert.equal(read().marketCapUsd, "53938.95462187500000000");
  const stamp = { price: "1234567890123456789", expo: 2, publish_time: 1, age_ms: 0 };
  assert.equal(read({ market_cap: "1000000001", quote_usd: stamp }).marketCapUsd, "123456789135802467912.3456789");
});

test("missing or invalid USD stamps leave the pool usable without invented dollars", () => {
  const stamp = { price: "345210000", expo: -8, publish_time: 1, age_ms: 0 };
  for (const quote_usd of [undefined, null, {}, { ...stamp, price: "-1" }, { ...stamp, expo: 21 }, { ...stamp, expo: -256 }]) {
    const pool = read({ quote_usd });
    assert.equal(pool.marketCapUsd, null);
    assert.equal(pool.economics.marketCap, 15624968750000n);
  }
});

test("USD market cap keeps confirmed zero and omits missing cap or quote units", () => {
  assert.equal(read({ market_cap: "0" }).marketCapUsd, "0.00000000000000000");
  assert.equal(read({ market_cap: null }).marketCapUsd, null);
  const inputs = venuePoolSummary().inputs as Record<string, unknown>;
  assert.equal(read({ inputs: { ...inputs, quote_decimals: null } }).marketCapUsd, null);
});

test("the coin summary keeps its current pool's USD market and drops a malformed one without failing the coin", () => {
  const market = {
    market_cap_usd: "6.52",
    change_24h_bps: null,
    interval_end_ms: 1_800_000_000_000,
    baseline_timestamp_ms: null,
    baseline_pool: null,
    current_pool: VENUE_POOL_KEY,
    basis: "usd_price",
    baseline_resolution_ms: 300_000,
  };
  const summary = (over: Record<string, unknown>) => parseCoinSummary({ ...coinBody("migrated", 1_800_000_000_000), ...over }, COIN_FIXTURE.coinType);
  assert.equal(summary({ market }).market?.market_cap_usd, "6.52");
  assert.equal(summary({ market: { ...market, market_cap_usd: "six" } }).market, null);
  assert.equal(summary({}).market, null);
});

test("the coin summary keeps its public launch wallet when creator rights are unclaimed", () => {
  const body = { ...coinBody("live", 1_800_000_000_000), creator: null, creator_source: null };
  const readLauncher = (launcher: unknown) => parseCoinSummary({ ...body, launcher }, COIN_FIXTURE.coinType).launcher;
  assert.equal(readLauncher(COIN_FIXTURE.creator), COIN_FIXTURE.creator);
  for (const launcher of [undefined, null, "0x1234", `0x${"0".repeat(64)}`]) {
    assert.equal(readLauncher(launcher), null);
  }
});

test("the coin summary reads null holders as unknown, never zero, and still refuses a negative count", () => {
  const body = coinBody("live", 1_800_000_000_000);
  assert.equal(parseCoinSummary({ ...body, holders: null }, COIN_FIXTURE.coinType).stats.holders, null);
  assert.equal(parseCoinSummary({ ...body, holders: 0 }, COIN_FIXTURE.coinType).stats.holders, 0);
  assert.throws(() => parseCoinSummary({ ...body, holders: -1 }, COIN_FIXTURE.coinType), /coin\.holders/);
});
