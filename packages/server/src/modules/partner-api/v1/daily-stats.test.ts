import assert from "node:assert/strict";
import test from "node:test";
import { DefillamaError } from "@blast/core/modules/defillama/contracts.ts";
import { handleDailyStatsRequest } from "./daily-stats.ts";

const path = "https://blast.test/api/v1/market/launchpad/daily-stats";
const now = Date.parse("2026-11-24T00:00:00Z");

test("daily stats serve one completed UTC date and preserve exact volume", async () => {
  const response = await handleDailyStatsRequest(
    new Request(`${path}?date=2026-11-23`),
    async () => ({
      launches: 2,
      graduations: 1,
      volume: [
        { quote_coin_type: "0x2::sui::SUI", amount_atomic: "9007199254740993" },
      ],
    }),
    now,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    date: "2026-11-23",
    launches: 2,
    graduations: 1,
    volume: [
      { quote_coin_type: "0x2::sui::SUI", amount_atomic: "9007199254740993" },
    ],
  });

  const read = async () =>
    assert.fail("Invalid dates must not reach the reporting database.");
  for (const [query, status, code] of [
    ["", 400, "invalid_parameters"],
    ["?day=2026-11-23", 400, "invalid_parameters"],
    ["?date=2026-11-23&date=2026-11-22", 400, "invalid_parameters"],
    ["?date=2026-11-31", 400, "invalid_date"],
    ["?date=2026-11-24", 409, "day_not_complete"],
  ] as const) {
    const rejected = await handleDailyStatsRequest(
      new Request(path + query),
      read,
      now,
    );
    assert.equal(rejected.status, status);
    assert.equal((await rejected.json()).error.code, code);
  }
});

test("daily stats distinguish an unpublished day from a reporting outage", async () => {
  const response = await handleDailyStatsRequest(
    new Request(`${path}?date=2026-11-23`),
    async () => {
      throw new DefillamaError("not_published", 404);
    },
    now,
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "daily_stats_not_published");

  for (const error of [
    Object.assign(new Error("Reporting database unavailable"), {
      code: "not_published",
    }),
    new DefillamaError("reporting_profile_unavailable", 503),
  ]) {
    const unavailable = await handleDailyStatsRequest(
      new Request(`${path}?date=2026-11-23`),
      async () => {
        throw error;
      },
      now,
    );
    assert.equal(unavailable.status, 503);
    assert.equal(
      (await unavailable.json()).error.code,
      "daily_stats_unavailable",
    );
    assert.equal(unavailable.headers.get("retry-after"), "5");
  }
});
