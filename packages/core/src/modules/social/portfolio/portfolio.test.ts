import assert from "node:assert/strict";
import test from "node:test";

import { atomsToUsd, isFreshPrice, positionStatus, pricedBalances } from "@blast/core/modules/social/portfolio/read.ts";

/** Social-feed T-019: the portfolio's pure parts: USD, price freshness, and statuses. */

const NOW = 1_800_000_000_000;

test("T-019: atoms at a price give USD to two places, rounded half away from zero, never through floats", () => {
  assert.equal(atomsToUsd("3500000000", 9, "3.5"), "12.25");
  assert.equal(atomsToUsd("15500000", 6, "0.9998"), "15.50");
  assert.equal(atomsToUsd("0", 9, "3.5"), "0.00");
  assert.equal(atomsToUsd("1", 9, "3.5"), "0.00");
  // 0.005 rounds up; 0.004999… does not.
  assert.equal(atomsToUsd("5000", 6, "1"), "0.01");
  assert.equal(atomsToUsd("4999", 6, "1"), "0.00");
  assert.equal(atomsToUsd("123456789012345678901234567890", 9, "1.000000000000000001"), "123456789012345679024.69");
  for (const price of ["-1", "1e3", "", "abc", "1."]) assert.equal(atomsToUsd("1000", 6, price), null, price);
  assert.equal(atomsToUsd("-5", 6, "1"), null);
});

test("T-019-AC-3 (AC-112): a price at most 120 s old is fresh; 121 s, a missing price or a bad time is not", () => {
  assert.equal(isFreshPrice({ usd_price: "1", as_of_ms: NOW - 120_000 }, NOW), true);
  assert.equal(isFreshPrice({ usd_price: "1", as_of_ms: NOW - 121_000 }, NOW), false);
  assert.equal(isFreshPrice(undefined, NOW), false);
  assert.equal(isFreshPrice({ usd_price: "1", as_of_ms: Number.NaN }, NOW), false);

  const priced = pricedBalances(
    { sui: "2000000000", usdc: "1000000" },
    { sui: { usd_price: "2", as_of_ms: NOW - 5_000 }, usdc: { usd_price: "1", as_of_ms: NOW - 121_000 } },
    NOW,
  );
  assert.deepEqual(priced, {
    balances: { sui: { atoms: "2000000000", usd: "4.00" }, usdc: { atoms: "1000000", usd: null } },
    pricesAsOfMs: NOW - 5_000,
  });
  // The oldest price behind a USD value shown.
  assert.equal(
    pricedBalances(
      { sui: "1", usdc: "1" },
      { sui: { usd_price: "2", as_of_ms: NOW - 5_000 }, usdc: { usd_price: "1", as_of_ms: NOW - 90_000 } },
      NOW,
    ).pricesAsOfMs,
    NOW - 90_000,
  );
});

test("T-019-AC-4 (AC-113): a position's status follows its presale and the claim", () => {
  const at = (lifecycle: string, endMs: number, claimed = false, startMs = 0) =>
    positionStatus({ lifecycle, start_ms: startMs, end_ms: endMs, claimed }, NOW);
  assert.equal(at("open", NOW + 1), "open");
  assert.equal(at("open", NOW + 2, false, NOW + 1), "closed", "an open sale before its start takes no commitments yet");
  assert.equal(at("open", NOW), "closed");
  assert.equal(at("funded", NOW - 1), "closed");
  assert.equal(at("pending", NOW + 1), "closed");
  assert.equal(at("something_new", NOW + 1), "closed");
  assert.equal(at("migrated", NOW - 1), "claimable");
  assert.equal(at("cancelled", NOW - 1), "claimable");
  assert.equal(at("migrated", NOW - 1, true), "delivered");
  assert.equal(at("cancelled", NOW - 1, true), "delivered");
});
