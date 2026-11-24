import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { MAX_VESTING_DURATION_MS } from "@interest-protocol/blast-sdk";
import { VESTING_UNITS, VESTING_UNIT_MS, type VestingUnit } from "@blast/core/modules/social/contracts/vesting.ts";
import { blankDraft, draftIssues, parseDraft, DraftShapeError, CREATE_DEFAULT_FEE_POLICY } from "@blast/core/modules/social/create/model.ts";
import type { CreateRecipient } from "@blast/core/modules/social/contracts/create.ts";
import { presaleArgs, vestingTerms } from "@blast/core/modules/social/create/presale-args.ts";
import { filledSample } from "../../../../test/fixtures/social/create/create-fixtures.ts";

const context = { fees: CREATE_DEFAULT_FEE_POLICY, allowlist: null };
const schema = JSON.parse(readFileSync(new URL("../contracts/schemas/create-draft.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020().compile(schema);

function draftWith(cliff: number, duration: number, cliff_unit: VestingUnit, duration_unit: VestingUnit) {
  const draft = filledSample();
  return { ...draft, token_recipients: [{ ...draft.token_recipients[0]!, cliff, duration, cliff_unit, duration_unit }, draft.token_recipients[1]!] };
}

function vestIssues(draft: ReturnType<typeof draftWith>) {
  return draftIssues(draft, context).filter((issue) => issue.path.endsWith(".vest"));
}

test("cliff and duration units convert independently into SDK-valid terms", () => {
  for (const cliffUnit of VESTING_UNITS) {
    for (const durationUnit of VESTING_UNITS) {
      const duration = Math.ceil(VESTING_UNIT_MS[cliffUnit] / VESTING_UNIT_MS[durationUnit]);
      const draft = draftWith(1, duration, cliffUnit, durationUnit);
      assert.equal(validate(draft), true, JSON.stringify(validate.errors));
      assert.deepEqual(parseDraft(draft), draft);
      assert.deepEqual(vestIssues(draft), []);
      const terms = vestingTerms(1, duration, cliffUnit, durationUnit);
      assert.equal(terms.cliffDelayMs, BigInt(VESTING_UNIT_MS[cliffUnit]));
      assert.equal(terms.periodDurationMs * terms.periods, BigInt(duration * VESTING_UNIT_MS[durationUnit]));
    }
  }
});

test("minute token and raise allocations produce exact SDK terms", () => {
  const draft = draftWith(1, 5, "minutes", "minutes");
  const minuteRow = { ...draft.raise_recipients[0]!, cliff: 1, duration: 5, cliff_unit: "minutes", duration_unit: "minutes" } as const;
  const args = presaleArgs({ ...draft, raise_recipients: [minuteRow] }, { ...context, creator: `0x${"ab".repeat(32)}`, logoUrl: null });
  const expected = { cliffDelayMs: 60_000n, periodDurationMs: 60_000n, periods: 5n };
  assert.deepEqual(args.recipientAllocations[0]!.recipient.vestingTerms, expected);
  assert.deepEqual(args.raiseAllocations[0]!.recipient.vestingTerms, expected);
  assert.deepEqual(vestingTerms(0, 5, "months", "minutes"), { ...expected, cliffDelayMs: 0n });
  assert.deepEqual(vestingTerms(1, 1, "minutes", "days"), { ...expected, periods: 1_440n });
  assert.deepEqual(vestingTerms(0, 1, "minutes", "months"), { cliffDelayMs: 0n, periodDurationMs: 86_400_000n, periods: 30n });
});

test("mixed units compare actual times and use the contract duration bound, without a product cap", () => {
  assert.deepEqual(vestIssues(draftWith(2, 6, "weeks", "months")), []);
  assert.deepEqual(vestIssues(draftWith(1, 4, "months", "weeks")).map((issue) => issue.message), ["The cliff is longer than the vesting"]);
  assert.deepEqual(vestIssues(draftWith(7, 1, "days", "weeks")), []);
  assert.deepEqual(vestIssues(draftWith(0, 5_184_000, "minutes", "minutes")), []);
  assert.deepEqual(vestIssues(draftWith(0, 5_184_001, "minutes", "minutes")), []);
  assert.deepEqual(vestIssues(draftWith(0, 10_000, "months", "months")), []);
  const maxMinutes = Number(MAX_VESTING_DURATION_MS / 60_000n);
  const valid = draftWith(0, maxMinutes, "milliseconds", "minutes");
  assert.deepEqual(vestIssues(valid), []);
  assert.deepEqual(parseDraft(valid), valid);
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  const terms = vestingTerms(0, maxMinutes, "milliseconds", "minutes");
  assert.equal(terms.periodDurationMs * terms.periods, BigInt(maxMinutes) * 60_000n);
  assert.match(vestIssues(draftWith(0, maxMinutes + 1, "milliseconds", "minutes"))[0]!.message, /contract's limit/);
  assert.throws(() => vestingTerms(0, maxMinutes + 1, "milliseconds", "minutes"));
  for (const duration of [0, -1, 1.5, NaN, Infinity]) assert.ok(vestIssues(draftWith(0, duration, "minutes", "minutes")).length);
  for (const cliff of [-1, 0.5, NaN, Infinity]) assert.ok(vestIssues(draftWith(cliff, 5, "minutes", "minutes")).length);
});

test("vesting terms outside the contract's limits throw before any transaction is built", () => {
  // The SDK's bound is inclusive: a schedule of exactly 2^63 ms is valid.
  assert.deepEqual(vestingTerms(0, 2 ** 63, "milliseconds", "milliseconds"), { cliffDelayMs: 0n, periodDurationMs: 1n, periods: 2n ** 63n });
  assert.deepEqual(vestingTerms(12, 12), { cliffDelayMs: 360n * 86_400_000n, periodDurationMs: 86_400_000n, periods: 360n });
  const refused = { name: "RangeError", message: "The vesting schedule is outside the contract's limits." };
  assert.throws(() => vestingTerms(0, 2 ** 63 + 2 ** 11, "milliseconds", "milliseconds"), refused);
  assert.throws(() => vestingTerms(0, 0), refused);
  assert.throws(() => vestingTerms(13, 12), refused);
  assert.throws(() => vestingTerms(-1, 12), refused);
});

test("canonical month schedules remain exact; retired recipient keys, unknown units and ambiguous shapes are refused", () => {
  const draft = draftWith(3, 12, "months", "months");
  assert.equal(validate(draft), true, JSON.stringify(validate.errors));
  assert.deepEqual(parseDraft(draft), draft);
  const terms = vestingTerms(3, 12, "months", "months");
  assert.equal(terms.cliffDelayMs, 3n * 30n * 86_400_000n);
  assert.equal(terms.periodDurationMs * terms.periods, 12n * 30n * 86_400_000n);
  const legacyRecipient = (row: CreateRecipient) => ({ label: row.label, address: row.address, bps: row.bps, vest: row.vest, cliff_months: row.cliff, months: row.duration });
  const legacy = { ...draft, token_recipients: draft.token_recipients.map(legacyRecipient), raise_recipients: draft.raise_recipients.map(legacyRecipient) };
  assert.equal(validate(legacy), false);
  assert.throws(() => parseDraft(legacy), DraftShapeError);
  const invalid = { ...draft, token_recipients: [{ ...draft.token_recipients[0]!, cliff_unit: "fortnights" }, draft.token_recipients[1]!] };
  assert.equal(validate(invalid), false);
  assert.throws(() => parseDraft(invalid), DraftShapeError);
  const ambiguous = { ...draft, token_recipients: [{ ...draft.token_recipients[0]!, cliff_months: 3, months: 12 }, draft.token_recipients[1]!] };
  assert.equal(validate(ambiguous), false);
  assert.throws(() => parseDraft(ambiguous), DraftShapeError);
});


test("buyer vesting survives save, validates terms and reaches participant settings", () => {
  const draft = { ...filledSample(), buyer_vesting: { vest: true, cliff: 1, duration: 6, cliff_unit: "weeks", duration_unit: "months" } } as const;
  assert.equal(validate(draft), true, JSON.stringify(validate.errors));
  assert.deepEqual(parseDraft(draft), draft);
  assert.deepEqual(draftIssues(draft, context).filter((issue) => issue.path === "buyer_vesting.vest"), []);
  assert.deepEqual(presaleArgs(draft, { ...context, creator: `0x${"ab".repeat(32)}`, logoUrl: null }).participantVesting, vestingTerms(1, 6, "weeks", "months"));
  const legacy: Record<string, unknown> = { ...draft };
  delete legacy.buyer_vesting;
  assert.deepEqual(parseDraft(legacy).buyer_vesting, blankDraft().buyer_vesting);
  assert.equal(presaleArgs(parseDraft(legacy), { ...context, creator: `0x${"ab".repeat(32)}`, logoUrl: null }).participantVesting, null);
  for (const terms of [{ duration: 0 }, { cliff: 7, cliff_unit: "months" as const }, { duration: 1.5 }]) {
    assert.ok(draftIssues({ ...draft, buyer_vesting: { ...draft.buyer_vesting, ...terms } }, context).some((issue) => issue.path === "buyer_vesting.vest"));
  }
  assert.throws(() => parseDraft({ ...draft, buyer_vesting: { ...draft.buyer_vesting, start_ms: 0 } }), DraftShapeError);
});
