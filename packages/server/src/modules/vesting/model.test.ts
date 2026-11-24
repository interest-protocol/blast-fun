import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createVestingSchema,
  parseVestingAmount,
  formatVestingAmount,
  vestingAmounts,
  nextUnlock,
  vestingPath,
  type PublicVesting,
} from "@blast/core/modules/vesting/model.ts";
const schedule: PublicVesting = {
  schedule_id: `0x${"1".repeat(64)}`,
  coin_type: "0x2::sui::SUI",
  beneficiary: `0x${"2".repeat(64)}`,
  creator: null,
  total: "101",
  released: "0",
  refunded: "0",
  refund_recipient: null,
  cancel_cap_id: null,
  terms: {
    kind: "linear",
    start_ms: "1000",
    cliff_ms: "250",
    period_ms: "100",
    periods: "10",
  },
  status: "active",
  created_timestamp_ms: null,
  created_digest: null,
  coin_name: null,
  coin_symbol: null,
  coin_decimals: 0,
  coin_icon_url: null,
  indexed: true,
};
test("linear amounts follow exact steps, cliff catch-up and final remainder", () => {
  assert.equal(vestingAmounts(schedule, 1249n)!.releasable, 0n);
  assert.equal(vestingAmounts(schedule, 1250n)!.releasable, 20n);
  assert.equal(vestingAmounts(schedule, 1299n)!.releasable, 20n);
  assert.equal(vestingAmounts(schedule, 1300n)!.releasable, 30n);
  assert.equal(
    vestingAmounts({ ...schedule, released: "20" }, 1300n)!.releasable,
    10n,
  );
  assert.equal(vestingAmounts(schedule, 1999n)!.releasable, 90n);
  assert.equal(vestingAmounts(schedule, 2000n)!.releasable, 101n);
  assert.equal(nextUnlock(schedule.terms, 1200n), 1250n);
  assert.equal(nextUnlock(schedule.terms, 1250n), 1300n);
});
test("checkpoint boundaries and cancellation retain exact terminal payouts", () => {
  const custom = {
    ...schedule,
    terms: {
      kind: "checkpoints" as const,
      checkpoints: [
        { timestamp_ms: "1000", cumulative_amount: "30" },
        { timestamp_ms: "2000", cumulative_amount: "101" },
      ],
    },
  };
  assert.equal(vestingAmounts(custom, 999n)!.vested, 0n);
  assert.equal(vestingAmounts(custom, 1000n)!.vested, 30n);
  assert.equal(vestingAmounts(custom, 2000n)!.vested, 101n);
  assert.equal(
    vestingAmounts(
      { ...custom, status: "canceled", released: "30", refunded: "71" },
      3000n,
    )!.releasable,
    0n,
  );
});
test("unknown history is explicit and never fabricated", () => {
  assert.equal(
    vestingAmounts(
      {
        ...schedule,
        terms: {
          kind: "checkpoints",
          checkpoints: null,
          checkpoint_count: "2",
        },
      },
      2000n,
    ),
    null,
  );
});
test("u64 amounts round-trip without Number conversion, including unknown decimals", () => {
  assert.equal(
    parseVestingAmount("18446744073.709551615", 9),
    "18446744073709551615",
  );
  assert.equal(
    formatVestingAmount("18446744073709551615", 9),
    "18446744073.709551615",
  );
  assert.equal(formatVestingAmount("101", null), "101 atoms");
  assert.throws(() => parseVestingAmount("1.001", 2));
  assert.throws(() => parseVestingAmount("18446744073709551616", 0));
  assert.throws(() => parseVestingAmount("1e9", 9));
});
test("creation normalizes public IDs and refuses unbounded or ambiguous input", () => {
  const intent = {
    action: "create",
    coinType: "0x2::sui::SUI",
    total: "101",
    beneficiary: "0x2",
    refundRecipient: null,
    cancelCapRecipient: null,
    schedule: schedule.terms,
  };
  // Address normalization accepts complete Sui addresses, never an arbitrary string.
  assert.equal(
    createVestingSchema.safeParse({
      ...intent,
      beneficiary: schedule.beneficiary,
    }).success,
    true,
  );
  assert.equal(
    createVestingSchema.safeParse({
      ...intent,
      beneficiary: schedule.beneficiary,
      cancelCapRecipient: schedule.beneficiary,
    }).success,
    false,
  );
  assert.equal(
    createVestingSchema.safeParse({
      ...intent,
      beneficiary: schedule.beneficiary,
      total: "18446744073709551616",
    }).success,
    false,
  );
  assert.equal(
    vestingPath(schedule.schedule_id),
    `/vesting/${schedule.schedule_id}`,
  );
});

test("public paths reject incomplete and non-hex IDs", () => {
  assert.throws(() => vestingPath("invalid"));
  assert.throws(() => vestingPath("0x2"));
  assert.equal(
    vestingPath(` ${schedule.schedule_id} `),
    `/vesting/${schedule.schedule_id}`,
  );
});

test("continuous payouts advance between checkpoints and cancellation freezes terminal payouts", () => {
  const continuous: PublicVesting = {
    ...schedule,
    released: "17",
    terms: {
      kind: "linear",
      start_ms: "1000",
      cliff_ms: "250",
      period_ms: "1",
      periods: "1000",
    },
  };
  assert.equal(
    vestingAmounts({ ...continuous, released: "0" }, 1249n)!.vested,
    0n,
  );
  assert.equal(vestingAmounts(continuous, 1250n)!.vested, 25n);
  const middle = vestingAmounts(continuous, 1456n)!;
  assert.equal(middle.vested, 46n);
  assert.equal(middle.releasable, 29n);
  assert.equal(middle.unvested, 55n);
  assert.equal(vestingAmounts(continuous, 1999n)!.vested, 100n);
  assert.equal(vestingAmounts(continuous, 2000n)!.vested, 101n);
  const canceled: PublicVesting = {
    ...continuous,
    status: "canceled",
    released: "46",
    refunded: "55",
  };
  const terminal = vestingAmounts(canceled, 9000n)!;
  assert.equal(terminal.releasable, 0n);
  assert.equal(terminal.vested, 46n);
  assert.equal(terminal.unvested, 0n);
});
