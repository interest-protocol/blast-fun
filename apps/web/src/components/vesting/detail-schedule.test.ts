import assert from "node:assert/strict";
import test from "node:test";
import {
  vestingAmounts,
  type PublicVesting,
} from "@blast/core/modules/vesting/model.ts";
import {
  isContinuousSchedule,
  releaseAfter,
  releasePage,
  scheduleState,
} from "./detail-schedule";
import {
  compactAmount,
  exactAmount,
  readableAmount,
  readableDate,
} from "./detail-format";

const schedule: PublicVesting = {
  schedule_id: `0x${"b".repeat(64)}`,
  coin_type: "0x2::coin::TOKEN",
  beneficiary: `0x${"a".repeat(64)}`,
  creator: null,
  total: "124968397112711982",
  released: "0",
  refunded: "0",
  refund_recipient: null,
  cancel_cap_id: null,
  terms: {
    kind: "linear",
    start_ms: "1792276800000",
    cliff_ms: "0",
    period_ms: "2592000000",
    periods: "12",
  },
  status: "active",
  created_timestamp_ms: null,
  created_digest: null,
  coin_name: null,
  coin_symbol: "AFTEST",
  coin_decimals: 9,
  coin_icon_url: null,
  indexed: true,
};

test("exact grouped and explicitly approximate amounts preserve all atomic units", () => {
  assert.equal(exactAmount(schedule.total, 9), "124,968,397.112711982");
  assert.equal(compactAmount(schedule.total, 9), "≈ 124.97M");
  assert.equal(
    exactAmount("18446744073709551615", 0),
    "18,446,744,073,709,551,615",
  );
  assert.equal(
    exactAmount("18446744073709551615", 9),
    "18,446,744,073.709551615",
  );
  assert.equal(
    exactAmount("18446744073709551615", null),
    "18,446,744,073,709,551,615 atoms",
  );
  assert.equal(compactAmount("1", 18), "<0.01");
  assert.equal(compactAmount("999999999999999", 9), "≈ 999,999.99");
  assert.equal(compactAmount("1999999999", 9), "≈ 1.99");
  assert.equal(compactAmount("1250000000", 9), "1.25");
  assert.equal(compactAmount("0", 9), "0");
});

test("first regular release is one period after start and final release conserves every atom", () => {
  const releases = releasePage(schedule, -1n);
  assert.equal(releases.length, 12);
  assert.equal(releases[0]!.time, 1794868800000n);
  assert.equal(releases[0]!.amount, 10414033092725998n);
  assert.equal(releases.at(-1)!.cumulative, BigInt(schedule.total));
  assert.equal(
    releases.reduce((sum, row) => sum + row.amount, 0n),
    BigInt(schedule.total),
  );
  assert.equal(
    releaseAfter(schedule, releases[0]!.time)!.time,
    releases[1]!.time,
  );
  assert.equal(releaseAfter(schedule, releases.at(-1)!.time), null);
});

test("positive releases handle tiny totals, huge counts and cliffs between periods", () => {
  const terms = {
    kind: "linear" as const,
    start_ms: "1000",
    cliff_ms: "250",
    period_ms: "100",
    periods: "10",
  };
  const cliff = { ...schedule, total: "101", terms };
  assert.deepEqual(releaseAfter(cliff, 1100n), {
    time: 1250n,
    amount: 20n,
    cumulative: 20n,
  });
  assert.deepEqual(releaseAfter(cliff, 1250n), {
    time: 1300n,
    amount: 10n,
    cumulative: 30n,
  });
  const tiny = { ...cliff, total: "2" };
  assert.deepEqual(
    releasePage(tiny, -1n).map((row) => row.time),
    [1500n, 2000n],
  );
  const dense = {
    ...schedule,
    total: "2",
    terms: {
      ...terms,
      cliff_ms: "0",
      period_ms: "1",
      periods: "1000000000000",
    },
  };
  assert.equal(isContinuousSchedule(dense), true);
  assert.equal(releaseAfter(dense, 1000n)!.time, 500000001000n);
  assert.equal(releasePage(dense, -1n).length, 2);
});

test("release pagination retains deltas and never expands an unbounded schedule", () => {
  const dense = {
    ...schedule,
    total: "18446744073709551615",
    terms: {
      kind: "linear" as const,
      start_ms: "1000",
      cliff_ms: "0",
      period_ms: "100",
      periods: "1000000000",
    },
  };
  const first = releasePage(dense, -1n);
  const second = releasePage(dense, first.at(-1)!.time);
  assert.equal(first.length, 32);
  assert.equal(second.length, 32);
  assert.equal(
    second[0]!.cumulative - first.at(-1)!.cumulative,
    second[0]!.amount,
  );
});

test("checkpoint, canceled and unavailable schedules do not fabricate future actions", () => {
  const custom = {
    ...schedule,
    total: "101",
    terms: {
      kind: "checkpoints" as const,
      checkpoints: [
        { timestamp_ms: "1000", cumulative_amount: "30" },
        { timestamp_ms: "2500", cumulative_amount: "101" },
      ],
    },
  };
  assert.deepEqual(
    releasePage(custom, -1n).map((row) => row.amount),
    [30n, 71n],
  );
  assert.equal(scheduleState(custom, 999n), "Awaiting first release");
  assert.equal(scheduleState(custom, 1000n), "Releases in progress");
  assert.equal(
    scheduleState(custom, 2500n),
    "Fully unlocked · claim available",
  );
  assert.equal(
    scheduleState({ ...custom, released: "101" }, 2500n),
    "Fully claimed",
  );
  assert.equal(
    scheduleState({ ...custom, status: "canceled" }, 2500n),
    "Canceled",
  );
  assert.equal(scheduleState({ ...custom, status: "closed" }, 2500n), "Closed");
  const unknown = {
    ...schedule,
    terms: {
      kind: "checkpoints" as const,
      checkpoints: null,
      checkpoint_count: "2",
    },
  };
  assert.equal(releaseAfter(unknown, 1000n), null);
  assert.equal(scheduleState(unknown, 1000n), "Schedule data unavailable");
});

test("release boundaries match canonical projections over cliff, remainder and atom edge cases", () => {
  for (const total of [1n, 2n, 7n, 101n, 18446744073709551615n]) {
    for (const cliff of [0n, 50n, 250n, 1000n]) {
      const sample = {
        ...schedule,
        total: String(total),
        terms: {
          kind: "linear" as const,
          start_ms: "1000",
          cliff_ms: String(cliff),
          period_ms: "100",
          periods: "10",
        },
      };
      const rows = releasePage(sample, -1n);
      let previous = 0n;
      for (const row of rows) {
        assert.ok(row.amount > 0n);
        assert.equal(vestingAmounts(sample, row.time)!.vested, row.cumulative);
        assert.equal(vestingAmounts(sample, row.time - 1n)!.vested, previous);
        previous = row.cumulative;
      }
      assert.equal(previous, total);
    }
  }
});

test("display dates retain UTC instants across daylight saving transitions", () => {
  assert.equal(
    readableDate(String(Date.parse("2030-03-10T06:59:00Z"))),
    "10 Mar 2030, 06:59 UTC",
  );
  assert.equal(
    readableDate(String(Date.parse("2030-03-10T07:00:00Z"))),
    "10 Mar 2030, 07:00 UTC",
  );
  assert.match(readableDate("18446744073709551615"), /^Unix /);
});

test("primary amounts show grouped digits without abbreviating or losing tiny balances", () => {
  assert.equal(readableAmount(schedule.total, 9), "≈ 124,968,397.11");
  assert.equal(readableAmount("1250000000", 9), "1.25");
  assert.equal(readableAmount("1", 18), "<0.01");
  assert.equal(
    readableAmount("18446744073709551615", null),
    "18,446,744,073,709,551,615 atoms",
  );
});

test("readable timestamps show seconds and milliseconds only when present", () => {
  assert.equal(
    readableDate(Date.parse("2026-10-17T22:33:16Z").toString()),
    "17 Oct 2026, 22:33:16 UTC",
  );
  assert.equal(
    readableDate(Date.parse("2026-10-17T22:33:16.751Z").toString()),
    "17 Oct 2026, 22:33:16.751 UTC",
  );
});
