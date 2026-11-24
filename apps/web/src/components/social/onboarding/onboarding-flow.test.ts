import assert from "node:assert/strict";
import test from "node:test";

import {
  callsignMessage,
  checkFromReason,
  localCallsignCheck,
  suggestedCallsign,
  typedCallsign,
} from "./onboarding-flow.ts";

/** The editable call sign's decisions and copy. */

test("UI-08: typing keeps lowercase letters, digits and underscores, 20 at most", () => {
  assert.equal(typedCallsign("Kai Sui!"), "kaisui");
  assert.equal(typedCallsign("KAI_sui-9"), "kai_sui9");
  assert.equal(typedCallsign("@mira.chen"), "mirachen");
  assert.equal(typedCallsign("x".repeat(25)), "x".repeat(20));
  assert.equal(typedCallsign("ÄÖ"), "");
});

test("UI-08: the field's states and the design's exact lines", () => {
  assert.deepEqual(callsignMessage(localCallsignCheck("")), { text: "3 to 20 letters, numbers or underscores.", tone: "muted" });
  for (const bad of ["k", "ka", "_kai", "kai_", "a".repeat(21)]) {
    assert.deepEqual(callsignMessage(localCallsignCheck(bad)), {
      text: "Use 3 to 20 characters. Start and end with a letter or number.",
      tone: "bad",
    }, bad);
  }
  assert.deepEqual(localCallsignCheck("kai_sui"), { status: "checking", callsign: "kai_sui" });
  assert.deepEqual(callsignMessage(localCallsignCheck("kai_sui")), { text: "Checking…", tone: "muted" });
  assert.deepEqual(callsignMessage(checkFromReason("kai_sui", null)), { text: "@kai_sui is available", tone: "ok" });
  assert.deepEqual(callsignMessage(checkFromReason("admin", "reserved")), { text: "@admin is reserved.", tone: "bad" });
  assert.deepEqual(callsignMessage(checkFromReason("mirachen", "taken", "mirachen_sui")), {
    text: "@mirachen is taken. Try @mirachen_sui.",
    tone: "bad",
  });
  // A suggestion that is itself unavailable is not offered.
  assert.equal(callsignMessage(checkFromReason("mirachen", "taken", null)).text, "@mirachen is taken.");
  assert.equal(callsignMessage(checkFromReason("scam_lord", "blocked")).tone, "bad");
  assert.equal(callsignMessage({ status: "unchecked", callsign: "kai" }).tone, "bad");
  assert.deepEqual(checkFromReason("x", "invalid"), { status: "invalid" });
});

test("UI-08: a taken callsign's suggestion is its first 15 characters and _sui", () => {
  assert.equal(suggestedCallsign("mirachen"), "mirachen_sui");
  assert.equal(suggestedCallsign("abcdefghijklmnopqrst"), "abcdefghijklmno_sui");
});
