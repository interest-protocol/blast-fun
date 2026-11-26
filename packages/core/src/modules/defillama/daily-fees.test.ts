import assert from "node:assert/strict";
import test from "node:test";
import { DefillamaAccounting } from "./accounting.ts";
import { HOUR_SECONDS, METHODOLOGY, type Snapshot } from "./contracts.ts";
import { feeSummaryGap, sumFeeSummaries, summarizeDailyFees } from "./daily-fees.ts";
import { creation, day, launchEvent, profile, quote, start } from "./fixtures.test.ts";

const sui = "sui:0x2::sui::SUI";

test("a partner launch hour publishes gross fees and leaves only its revenue unknown", () => {
  const end = start + HOUR_SECONDS * 1000;
  const account = new DefillamaAccounting(profile, start, end);
  for (const event of [
    ...creation(true),
    launchEvent("Bought", { quote_in: 1000n, protocol_quote_fee: 7n, creator_quote_fee: 3n }),
  ]) {
    account.apply(event);
  }
  account.addFrontendFees([{ id: "receipt", venue: "cetus", coin: quote, amount: 5n }]);
  const snapshot: Snapshot = {
    schema_version: 1,
    chain: "sui",
    date: day,
    start_timestamp: start / 1000,
    end_timestamp: end / 1000,
    methodology_version: METHODOLOGY,
    profile,
    source: { checkpoint: "101", digest: "cut", timestamp_ms: end, history_start_ms: start },
    frontend_fee_coverage: { status: "complete", reason: null },
    frontend_fee_policy: [],
    ...account.result(),
  };
  assert.equal(snapshot.scope_coverage.launchpad.revenue.reason, "mutable_deferred_partner_allocation");
  assert.equal(feeSummaryGap(snapshot), null);

  const hour = summarizeDailyFees(snapshot)!;
  assert.deepEqual(hour, {
    dailyFees: { creation: { [sui]: "100" }, curve_swaps: { [sui]: "10" }, cetus: { [sui]: "5" } },
    dailyRevenue: { creation: { [sui]: null }, curve_swaps: { [sui]: null }, cetus: { [sui]: "5" } },
    dailySupplySideRevenue: { creation: { [sui]: null }, curve_swaps: { [sui]: null } },
  });
  // Unknown stays unknown when hours are added together.
  const plain = {
    dailyFees: { curve_swaps: { [sui]: "4" } },
    dailyRevenue: { curve_swaps: { [sui]: "4" }, cetus: { [sui]: "2" } },
    dailySupplySideRevenue: {},
  };
  assert.deepEqual(sumFeeSummaries([plain, hour]).dailyRevenue, {
    curve_swaps: { [sui]: null },
    cetus: { [sui]: "7" },
    creation: { [sui]: null },
  });

  const missing = { status: "unavailable", reason: "frontend_fee_source_incomplete" } as const;
  assert.equal(feeSummaryGap({ ...snapshot, frontend_fee_coverage: missing }), missing.reason);
  assert.equal(summarizeDailyFees({ ...snapshot, frontend_fee_coverage: missing }), undefined);
});
