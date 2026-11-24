import assert from "node:assert/strict";
import test from "node:test";
import { HIDDEN_AMOUNT } from "@blast/core/lib/format.ts";
import type { PublicVesting } from "@blast/core/modules/vesting/model.ts";
import { overviewSchedule } from "./overview-model";

const schedule: PublicVesting = {
  schedule_id: `0x${"b".repeat(64)}`,
  coin_type: "0x2::coin::TOKEN",
  beneficiary: `0x${"a".repeat(64)}`,
  creator: null,
  total: "101",
  released: "0",
  refunded: "0",
  refund_recipient: null,
  cancel_cap_id: null,
  terms: { kind: "linear", start_ms: "1000", cliff_ms: "0", period_ms: "100", periods: "10" },
  status: "active",
  created_timestamp_ms: null,
  created_digest: null,
  coin_name: "Token",
  coin_symbol: "TOKEN",
  coin_decimals: 0,
  coin_icon_url: null,
  indexed: true,
};

test("available, claimed and unlocked stay distinct, including fully unlocked unclaimed schedules", () => {
  const partial = overviewSchedule({ ...schedule, released: "20" }, 1500, false);
  assert.equal(partial.available, "30");
  assert.equal(partial.claimed, "20");
  assert.equal(partial.remaining, "81");
  assert.deepEqual(partial.balances, { claimed: 20n, remaining: 81n, available: 30n });
  assert.equal(partial.unlocked, "50");
  assert.equal(partial.allocated, "101");
  assert.equal(partial.timing.at, 1600n);
  const unlocked = overviewSchedule(schedule, 2000, false);
  assert.equal(unlocked.available, "101");
  assert.equal(unlocked.progress, 100);
  assert.equal(unlocked.state, "Fully unlocked · claim available");
  assert.notEqual(unlocked.state, "Fully claimed");
  assert.equal(overviewSchedule({ ...schedule, released: "101" }, 2000, false).state, "Fully claimed");
});

test("one-atom balances and maximum u64 allocations retain exact decimal precision", () => {
  const view = overviewSchedule({ ...schedule, total: "18446744073709551615", released: "18446744073709551614", coin_decimals: 18 }, 2000, false);
  assert.equal(view.available, "0.000000000000000001");
  assert.equal(view.remaining, "0.000000000000000001");
  assert.equal(view.allocated, "18.446744073709551615");
  assert.equal(view.claimed, "18.446744073709551614");
});

test("unavailable checkpoint terms do not produce a zero balance or progress", () => {
  const view = overviewSchedule({ ...schedule, terms: { kind: "checkpoints", checkpoints: null, checkpoint_count: "2" } }, 1500, false);
  assert.equal(view.available, "—");
  assert.equal(view.unlocked, "—");
  assert.equal(view.claimed, "0");
  assert.equal(view.progress, null);
  assert.equal(view.progressText, "Unlocked amount unavailable");
  assert.equal(view.state, "Schedule data unavailable");
  assert.equal(view.timing.at, null);
  assert.equal(view.timing.text, "Schedule data unavailable");
});

test("next release skips zero-atom linear boundaries and keeps continuous timing honest", () => {
  const tiny = { ...schedule, total: "2" };
  assert.equal(overviewSchedule(tiny, 1100, false).timing.at, 1500n);
  const continuous = { ...tiny, terms: { ...schedule.terms, kind: "linear" as const, start_ms: "1000", cliff_ms: "0", period_ms: "1", periods: "1000" } };
  const before = overviewSchedule(continuous, 1100, false);
  assert.equal(before.timing.label, "First release");
  assert.equal(before.timing.at, 1500n);
  const started = overviewSchedule(continuous, 1500, false);
  assert.equal(started.timing.label, "Unlocking continuously");
  assert.equal(started.timing.text, "Fully unlocked");
  assert.equal(started.timing.at, 2000n);
});

test("privacy masks every amount and semantic progress without changing schedule state", () => {
  const view = overviewSchedule(schedule, 1500, true);
  assert.equal(view.available, HIDDEN_AMOUNT);
  assert.equal(view.allocated, HIDDEN_AMOUNT);
  assert.equal(view.claimed, HIDDEN_AMOUNT);
  assert.equal(view.remaining, HIDDEN_AMOUNT);
  assert.equal(view.unlocked, HIDDEN_AMOUNT);
  assert.equal(view.progress, null);
  assert.equal(view.progressText, "Amounts hidden");
  assert.equal(view.timing.at, 1600n);
});

test("terminal schedules do not invent a historical unlocked amount or future release", () => {
  const view = overviewSchedule({ ...schedule, status: "canceled", released: "20", refunded: "81" }, 1500, false);
  assert.equal(view.state, "Canceled");
  assert.equal(view.remaining, "0");
  assert.equal(view.balances.remaining, 0n);
  assert.equal(view.available, "0");
  assert.equal(view.claimed, "20");
  assert.equal(view.unlocked, "—");
  assert.equal(view.progress, null);
  assert.equal(view.timing.at, null);
  assert.equal(view.timing.text, "No future releases");
});

test("progress text truncates to hundredths and never shows a started schedule as 0%", () => {
  assert.equal(overviewSchedule(schedule, 1500, false).progressText, "49.5% unlocked");
  const fine = { ...schedule, total: "100000", terms: { ...schedule.terms, period_ms: "1", periods: "100000" } };
  assert.equal(overviewSchedule(fine, 1000, false).progressText, "0% unlocked");
  assert.equal(overviewSchedule(fine, 1001, false).progressText, "<0.01% unlocked");
});
