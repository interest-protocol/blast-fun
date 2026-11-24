import assert from "node:assert/strict";
import test from "node:test";

import { isReferralCursor, isReferralInvitees, isReferralSummary, referralCallsign, referralPath, requestReferral, REFERRAL_COOKIE } from "./contracts.ts";

test("invite links and cookies accept only callsigns", () => {
  assert.equal(referralPath("Kai_9"), "/?ref=kai_9");
  for (const invalid of [null, "ab", "../kai", "kai%0d", "a".repeat(21), " kai ", "<script>"]) {
    assert.equal(referralCallsign(invalid), null);
  }
  assert.throws(() => referralPath("a/b"), TypeError);
  const request = (cookie: string) => new Request("https://blast.fun", { headers: { cookie } });
  assert.equal(requestReferral(request(`other=1; ${REFERRAL_COOKIE}=kai_9; next=2`)), "kai_9");
  assert.equal(requestReferral(request(`not${REFERRAL_COOKIE}=kai_9`)), null);
  assert.equal(requestReferral(request(`${REFERRAL_COOKIE}=../bad`)), null);
});

test("the private summary requires exact positive USD strings and safe counts", () => {
  const summary = { invited: 10, volume_usd: "10000.00", unvalued_trades: 0 };
  assert.equal(isReferralSummary(summary), true);
  for (const invalid of [null, {}, { ...summary, volume_usd: 10000 }, { ...summary, invited: -1 }, { ...summary, unvalued_trades: 0.1 }]) {
    assert.equal(isReferralSummary(invalid), false);
  }
});

test("invitee pages validate bounded identities and UUID cursors", () => {
  const person = { id: "00000000-0000-4000-8000-000000000001", callsign: "kai_9", display_name: "Kai", avatar_url: null, x_handle: null };
  const page = { invitees: [person], next_cursor: person.id };
  assert.equal(isReferralInvitees(page), true);
  assert.equal(isReferralInvitees({ invitees: [{ ...person, callsign: null }], next_cursor: null }), true);
  assert.equal(isReferralInvitees({ invitees: [{ ...person, x_handle: "kai_x" }], next_cursor: null }), true);
  assert.equal(isReferralInvitees({ invitees: [{ ...person, joined_at_ms: 1_793_000_000_000 }], next_cursor: null }), true);
  for (const joined of [-1, 1.5, "1793000000000"]) {
    assert.equal(isReferralInvitees({ invitees: [{ ...person, joined_at_ms: joined }], next_cursor: null }), false, String(joined));
  }
  for (const value of [null, {}, { ...page, next_cursor: "bad" }, { ...page, invitees: Array(51).fill(person) }, { ...page, invitees: [{ ...person, callsign: "../bad" }] }, { ...page, invitees: [{ ...person, x_handle: 42 }] }]) {
    assert.equal(isReferralInvitees(value), false);
  }
  for (const cursor of ["", "bad", "1; DROP TABLE", null]) assert.equal(isReferralCursor(cursor), false);
});
