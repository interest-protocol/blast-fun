import assert from "node:assert/strict";
import test from "node:test";

import { WORKLOAD_ROUTES } from "./resources.ts";

test("one table routes every workload: writes and sensitive reads to the primary, chain joins to the replica, market data to blast-infra", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(WORKLOAD_ROUTES).map(([name, policy]) => [name, policy.host])),
    {
      write: "primary",
      "discovery-market-facts": "blast-infra",
      market: "blast-infra",
      search: "replica",
      "thesis-join": "replica",
      social: "primary",
      moderation: "primary",
      "consistent-read": "primary",
    },
  );
  assert.deepEqual(WORKLOAD_ROUTES.search, {
    host: "replica",
    maxLagMs: 10_000,
    onLag: "stale",
    maxStaleMs: 120_000,
  });
  assert.deepEqual(WORKLOAD_ROUTES["thesis-join"], { host: "replica", maxLagMs: 5_000, onLag: "primary" });
  assert.deepEqual(WORKLOAD_ROUTES.market, { host: "blast-infra", maxLagMs: 30_000 });
});
