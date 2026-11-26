import assert from "node:assert/strict";
import { test } from "node:test";
import { linearVestedAt } from "@interest-protocol/blast-util-sdk/vesting";
import { formatVestingAmount } from "@blast/core/modules/vesting/model.ts";
import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import {
  amountAtoms,
  createIntent,
  createSchedule,
  CreationFieldError,
  maxVestingAtoms,
  linearReleaseSummary,
  regularCheckpointReleases,
  releaseTimestamp,
  splitReleaseAtoms,
  vestingPortionAtoms,
  type CreationInput,
} from "./creation-model";
const NOW = 1_700_000_000_000n;
const DAY = 86_400_000n;
const draft: CreationInput = {
  coinType: SUI_COIN_TYPE,
  decimals: 9,
  total: "0.000000101",
  beneficiary: `0x${"a".repeat(64)}`,
  cancelable: false,
  refund: "",
  capRecipient: "",
  kind: "linear",
  start: "2030-01-01T12:00",
  end: "2030-10-28T12:00",
  periodDays: "30",
  periods: "10",
  cliffDays: "45",
  releases: [{ key: "one", date: "2030-01-01T12:00", amount: "0.000000101" }],
};
function fieldError(work: () => unknown, field: string) {
  assert.throws(
    work,
    (error) => error instanceof CreationFieldError && error.field === field,
  );
}

test("exact amounts, Max and percentage shortcuts never round through a display value", () => {
  const large = 18_446_744_073_709_551_615n;
  assert.equal(amountAtoms("18446744073.709551615", 9), large);
  const available = large - 20_000_000n;
  assert.equal(maxVestingAtoms(SUI_COIN_TYPE, large), available);
  assert.equal(maxVestingAtoms(USDC_COIN_TYPE, large), large);
  assert.equal(maxVestingAtoms(SUI_COIN_TYPE, 19_000_000n), 0n);
  for (const percent of [25, 50, 75] as const) {
    const atoms = vestingPortionAtoms(SUI_COIN_TYPE, large, percent);
    assert.equal(atoms, (available * BigInt(percent)) / 100n);
    assert.equal(amountAtoms(formatVestingAmount(atoms, 9), 9), atoms);
  }
  assert.equal(vestingPortionAtoms(USDC_COIN_TYPE, 3n, 25), 0n);
  fieldError(() => amountAtoms("0.0000000001", 9), "total");
  fieldError(() => amountAtoms("18446744073.709551616", 9), "total");
});
test("equal allocation is exact, positive, bounded and deterministic up to u64", () => {
  assert.deepEqual(splitReleaseAtoms(10n, 3), [4n, 3n, 3n]);
  for (const count of [1, 3, 256]) {
    const atoms = splitReleaseAtoms(18_446_744_073_709_551_615n, count);
    assert.equal(
      atoms.reduce((sum, part) => sum + part, 0n),
      18_446_744_073_709_551_615n,
    );
    assert.ok(atoms.every((part) => part > 0n));
    assert.ok(atoms[0]! - atoms.at(-1)! <= 1n);
  }
  assert.throws(() => splitReleaseAtoms(2n, 3));
  assert.throws(() => splitReleaseAtoms(1000n, 257));
});
test("#1012: an empty cliff box is no cliff, so the box can start empty", () => {
  const intent = createIntent({ ...draft, cliffDays: "" }, NOW);
  assert.equal(intent.schedule.kind === "linear" && intent.schedule.cliff_ms, "0");
});
test("continuous linear intent accrues proportionally between days at millisecond precision", () => {
  const intent = createIntent({ ...draft, cliffDays: "0" }, NOW);
  assert.equal(intent.schedule.kind, "linear");
  if (intent.schedule.kind !== "linear") return;
  const start = releaseTimestamp(draft.start, "start");
  const duration = releaseTimestamp(draft.end, "end") - start;
  assert.equal(intent.schedule.period_ms, "1");
  assert.equal(intent.schedule.periods, String(duration));
  const shape = {
    startMs: start,
    cliffMs: 0n,
    periodMs: 1n,
    periods: duration,
  };
  for (const elapsed of [
    0n,
    1n,
    DAY / 2n,
    duration / 3n,
    duration - 1n,
    duration,
  ]) {
    assert.equal(
      linearVestedAt(101n, shape, start + elapsed),
      (101n * elapsed) / duration,
    );
  }
  assert.equal(linearVestedAt(101n, shape, start - 1n), 0n);
  assert.equal(linearVestedAt(101n, shape, start + duration + 1n), 101n);
});
test("continuous cliff gates accrued value without resetting the slope or end", () => {
  const schedule = createIntent(draft, NOW).schedule;
  assert.equal(schedule.kind, "linear");
  if (schedule.kind !== "linear") return;
  const summary = linearReleaseSummary(schedule, 101n);
  assert.equal(summary.cliffEnd, summary.start + 45n * DAY);
  assert.equal(summary.final, releaseTimestamp(draft.end, "end"));
  const shape = {
    startMs: summary.start,
    cliffMs: 45n * DAY,
    periodMs: 1n,
    periods: summary.final - summary.start,
  };
  assert.equal(linearVestedAt(101n, shape, summary.cliffEnd - 1n), 0n);
  assert.equal(linearVestedAt(101n, shape, summary.cliffEnd), 15n);
  assert.equal(summary.firstAmount, 15n);
  assert.equal(linearVestedAt(101n, shape, summary.final), 101n);
});
test("small continuous allocations report the first whole atom rather than promising fractional tokens", () => {
  const schedule = createSchedule({ ...draft, cliffDays: "0" }, 2n, NOW);
  assert.equal(schedule.kind, "linear");
  if (schedule.kind !== "linear") return;
  const summary = linearReleaseSummary(schedule, 2n);
  assert.equal(
    summary.first,
    summary.start + (summary.final - summary.start) / 2n,
  );
  assert.equal(summary.firstAmount, 1n);
});
test("invalid end dates, cliff and short lead time identify the corresponding field", () => {
  fieldError(
    () => createSchedule({ ...draft, end: draft.start }, 101n, NOW),
    "end",
  );
  fieldError(
    () => createSchedule({ ...draft, end: "2029-01-01T12:00" }, 101n, NOW),
    "end",
  );
  fieldError(() => createSchedule({ ...draft, end: "" }, 101n, NOW), "end");
  fieldError(
    () => createSchedule({ ...draft, cliffDays: "301" }, 101n, NOW),
    "cliff",
  );
  fieldError(
    () => createSchedule({ ...draft, cliffDays: "1.5" }, 101n, NOW),
    "cliff",
  );
  fieldError(
    () =>
      createSchedule(
        draft,
        101n,
        releaseTimestamp(draft.start, "start") - 59_999n,
      ),
    "start",
  );
  fieldError(() => releaseTimestamp("not a date", "start"), "start");
});
test("regular steps generate exact checkpoint intents, never continuous linear terms", () => {
  const releases = regularCheckpointReleases(
    { ...draft, periods: "3", periodDays: "7" },
    101n,
  );
  const schedule = createIntent(
    { ...draft, kind: "checkpoints", releases },
    NOW,
  ).schedule;
  assert.equal(schedule.kind, "checkpoints");
  if (schedule.kind !== "checkpoints") return;
  assert.deepEqual(
    schedule.checkpoints.map((point) => point.cumulative_amount),
    ["34", "68", "101"],
  );
  assert.deepEqual(
    schedule.checkpoints.map((point) => BigInt(point.timestamp_ms)),
    [1n, 2n, 3n].map(
      (i) => releaseTimestamp(draft.start, "start") + 7n * DAY * i,
    ),
  );
  fieldError(
    () => regularCheckpointReleases({ ...draft, periods: "257" }, 1000n),
    "periods",
  );
  assert.throws(() =>
    regularCheckpointReleases({ ...draft, periods: "3" }, 2n),
  );
});
test("generated checkpoint dates are exact UTC instants", () => {
  const input = { ...draft, start: "2030-03-09T12:00", periodDays: "1", periods: "3" };
  const releases = regularCheckpointReleases(input, 101n);
  const start = releaseTimestamp(input.start, "start");
  assert.equal(releases[0]!.date, "2030-03-10T12:00:00.000Z");
  releases.forEach((release, i) =>
    assert.equal(releaseTimestamp(release.date, "date"), start + DAY * BigInt(i + 1)),
  );
});
test("custom schedules use exact cumulative atoms and preserve input when validation fails", () => {
  const custom = {
    ...draft,
    kind: "checkpoints" as const,
    releases: [
      { key: "one", date: "2030-01-01T12:00", amount: "0.000000051" },
      { key: "two", date: "2030-02-01T12:00", amount: "0.000000050" },
    ],
  };
  const snapshot = structuredClone(custom);
  const schedule = createIntent(custom, NOW).schedule;
  assert.equal(schedule.kind, "checkpoints");
  if (schedule.kind === "checkpoints")
    assert.deepEqual(
      schedule.checkpoints.map((point) => point.cumulative_amount),
      ["51", "101"],
    );
  fieldError(
    () =>
      createSchedule(
        {
          ...custom,
          releases: [
            custom.releases[0]!,
            { ...custom.releases[1]!, date: custom.releases[0]!.date },
          ],
        },
        101n,
        NOW,
      ),
    "date-two",
  );
  fieldError(() => createSchedule(custom, 102n, NOW), "releases");
  assert.deepEqual(custom, snapshot);
});
test("full recipient and cancellation addresses are validated and policy stays explicit", () => {
  fieldError(
    () => createIntent({ ...draft, beneficiary: "0x2" }, NOW),
    "beneficiary",
  );
  fieldError(
    () => createIntent({ ...draft, beneficiary: `0x${"0".repeat(64)}` }, NOW),
    "beneficiary",
  );
  const irrevocable = createIntent(draft, NOW);
  assert.equal(irrevocable.refundRecipient, null);
  assert.equal(irrevocable.cancelCapRecipient, null);
  fieldError(() => createIntent({ ...draft, cancelable: true }, NOW), "refund");
  const cancelable = createIntent(
    {
      ...draft,
      cancelable: true,
      refund: draft.beneficiary,
      capRecipient: `0x${"b".repeat(64)}`,
    },
    NOW,
  );
  assert.equal(cancelable.refundRecipient, draft.beneficiary);
  assert.equal(cancelable.cancelCapRecipient, `0x${"b".repeat(64)}`);
});

test("continuous first payouts and cancellation projections stay exact up to u64", () => {
  for (const total of [1n, 2n, 101n, 18_446_744_073_709_551_615n]) {
    for (const cliff of [0n, 45n * DAY, 300n * DAY]) {
      const start = releaseTimestamp(draft.start, "start");
      const duration = 300n * DAY;
      const schedule = {
        kind: "linear" as const,
        start_ms: String(start),
        cliff_ms: String(cliff),
        period_ms: "1",
        periods: String(duration),
      };
      const summary = linearReleaseSummary(schedule, total);
      const shape = {
        startMs: start,
        cliffMs: cliff,
        periodMs: 1n,
        periods: duration,
      };
      assert.equal(linearVestedAt(total, shape, summary.first - 1n), 0n);
      assert.ok(linearVestedAt(total, shape, summary.first) > 0n);
      assert.equal(linearVestedAt(total, shape, summary.final), total);
    }
  }
});
test("sponsored SUI Max and portions do not reserve wallet gas", () => {
  const balance = 10_000_000n;
  assert.equal(maxVestingAtoms(SUI_COIN_TYPE, balance, true), balance);
  assert.equal(
    vestingPortionAtoms(SUI_COIN_TYPE, balance, 50, true),
    5_000_000n,
  );
  assert.equal(maxVestingAtoms(SUI_COIN_TYPE, balance), 0n);
});

test("unqualified creation dates default to UTC independently of the browser timezone", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Honolulu";
    assert.equal(releaseTimestamp("2027-01-15T10:30", "start"), BigInt(Date.parse("2027-01-15T10:30:00Z")));
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
