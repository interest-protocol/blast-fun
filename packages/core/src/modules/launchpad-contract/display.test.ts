import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCoinFeePolicy,
  parseCoinMarket,
  parseOptionalHolders,
} from "./display.ts";

const pool = `cetus:0x${"1".repeat(64)}`;
const market = {
  market_cap_usd: "184467440737095516150000000000000000.123456789123456789",
  change_24h_bps: "-1234",
  interval_end_ms: 100_000_000,
  baseline_timestamp_ms: 13_500_000,
  baseline_pool: pool,
  current_pool: pool,
  basis: "usd_price",
  baseline_resolution_ms: 300_000,
};

test("optional market facts retain exact decimals, signed changes and true zero", () => {
  assert.deepEqual(parseCoinMarket(market), market);
  assert.deepEqual(
    parseCoinMarket({ ...market, market_cap_usd: "0", change_24h_bps: "0" }),
    { ...market, market_cap_usd: "0", change_24h_bps: "0" },
  );
  assert.equal(parseOptionalHolders(0), 0);
  assert.equal(parseOptionalHolders(undefined), null);
  assert.equal(parseOptionalHolders(-1), null);
});

test("missing, unpriced and malformed optional facts cannot invalidate the core read", () => {
  assert.equal(parseCoinMarket(undefined), null);
  assert.deepEqual(
    parseCoinMarket({
      ...market,
      market_cap_usd: null,
      change_24h_bps: null,
      baseline_timestamp_ms: null,
      baseline_pool: null,
    }),
    {
      ...market,
      market_cap_usd: null,
      change_24h_bps: null,
      baseline_timestamp_ms: null,
      baseline_pool: null,
    },
  );
  for (const patch of [
    { market_cap_usd: 10 },
    { change_24h_bps: "1.5" },
    { baseline_timestamp_ms: 99_000_000 },
    { baseline_timestamp_ms: 1 },
    { basis: "quote_price" },
  ]) {
    assert.equal(parseCoinMarket({ ...market, ...patch }), null);
  }
});

test("current protocol shares validate independently of the coin's core data", () => {
  const curve = {
    protocol_bps: "6500",
    cursor: "100:1:2:0",
    timestamp_ms: 1_000,
  };
  assert.deepEqual(parseCoinFeePolicy({ curve, lp: null }), {
    curve,
    lp: null,
  });
  assert.equal(
    parseCoinFeePolicy({
      curve: { ...curve, protocol_bps: "10001" },
      lp: null,
    }),
    null,
  );
  assert.equal(parseCoinFeePolicy(undefined), null);
});


test("effective LP defaults, overrides and removal keep their separate observations", () => {
  const lp = { policy_id: `0x${"a".repeat(64)}`, meme_bps: "0", quote_bps: "10000", source: "override", cursor: "100:1:2:0", timestamp_ms: 1000, override_cursor: "100:1:2:0", override_timestamp_ms: 1000 };
  assert.deepEqual(parseCoinFeePolicy({ curve: null, lp }), { curve: null, lp });
  assert.equal(parseCoinFeePolicy({ curve: null, lp: { ...lp, meme_bps: 5000 } }), null);
  assert.equal(parseCoinFeePolicy({ curve: null, lp: { ...lp, quote_bps: "10001" } }), null);
  const removed = { ...lp, source: "default", meme_bps: "5000", quote_bps: "1500", cursor: "99:0:1:0", timestamp_ms: 900 };
  assert.deepEqual(parseCoinFeePolicy({ curve: null, lp: removed }), { curve: null, lp: removed });
});
