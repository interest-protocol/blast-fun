import assert from "node:assert/strict";
import test from "node:test";

import { vestingAttemptResponseSchema, vestingEligibilitySchema } from "./responses.ts";

test("the attempt boundary leaves byte and digest verification to the signing workflow", () => {
  const attempt = {
    request_id: "request",
    action: "claim",
    state: "submitted",
    digest: "malformed digest",
    transaction_bytes: "not-signable",
    schedule_id: null,
    gas_budget: "5000000",
    expires_at_ms: 1,
    sponsor_reservation_id: null,
  };
  assert.deepEqual(vestingAttemptResponseSchema.parse(attempt), attempt);
  assert.equal(
    vestingAttemptResponseSchema.safeParse({ ...attempt, state: "unknown" }).success,
    false,
  );
  assert.equal(
    vestingAttemptResponseSchema.safeParse({ ...attempt, transaction_bytes: 42 }).success,
    false,
  );
});

test("eligibility parses only the cancellation capability consumed by the detail page", () => {
  assert.deepEqual(vestingEligibilitySchema.parse({ can_cancel: false, schedule_id: "unused" }), {
    can_cancel: false,
  });
  assert.equal(vestingEligibilitySchema.safeParse({ can_cancel: "true" }).success, false);
});
