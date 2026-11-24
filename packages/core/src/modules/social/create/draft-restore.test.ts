import assert from "node:assert/strict";
import test from "node:test";
import { blankDraft, draftQuote, parseDraft } from "@blast/core/modules/social/create/model.ts";

const TEST_QUOTE = "0x963331df9a26c8674c33eb97655fe44807d5ff1aa4092bcbe2bdbe044b17b03d::test_sui::TEST_SUI";

test("saved explicit vesting units restore exactly, even while vesting is off", () => {
  const draft = blankDraft();
  const stored = {
    ...draft,
    token_recipients: [{ label: "Team", address: "", bps: 1_900, vest: false, cliff: 3, cliff_unit: "minutes", duration: 12, duration_unit: "months" }],
  };
  assert.deepEqual(parseDraft(stored).token_recipients, stored.token_recipients);
});

test("the saved test quote restores without relabeling its amounts", () => {
  const stored = { ...blankDraft(), quote_type: TEST_QUOTE };
  const restored = parseDraft(stored);
  assert.deepEqual(restored, stored);
  assert.equal(draftQuote(restored).symbol, "TEST_SUI");
  assert.equal(draftQuote(restored).decimals, 9);
});
