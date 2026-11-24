import assert from "node:assert/strict";
import test from "node:test";
import { decodeReferralContext, encodeReferralContext, REFERRAL_CONTEXT_MAX_BYTES } from "./share-context.ts";

const inviter = { callsign: "new_friend", crew: null, title: null, avatarUrl: null };
test("referral context contains only public inviter fields and binds the requested callsign", () => {
  assert.deepEqual(decodeReferralContext(encodeReferralContext(inviter, inviter.callsign), inviter.callsign), inviter);
  assert.equal(decodeReferralContext(encodeReferralContext(null, inviter.callsign), inviter.callsign), null);
  for (const value of [{ ...inviter, callsign: "other_friend" }, { ...inviter, account_id: "private" }, { ...inviter, crew: 1.5 }]) {
    assert.throws(() => encodeReferralContext(value, inviter.callsign), /Referral context unavailable/);
  }
  assert.throws(() => decodeReferralContext(JSON.stringify({ version: "blast.referral-inviter.v1", inviter, session: "private" }), inviter.callsign));
});

test("referral context bounds actual UTF-8 bytes for both producer and consumer", () => {
  const prefix = encodeReferralContext({ ...inviter, title: "" }, inviter.callsign);
  const exact = { ...inviter, title: "x".repeat(REFERRAL_CONTEXT_MAX_BYTES - Buffer.byteLength(prefix)) };
  assert.equal(Buffer.byteLength(encodeReferralContext(exact, inviter.callsign)), REFERRAL_CONTEXT_MAX_BYTES);
  assert.throws(() => encodeReferralContext({ ...exact, title: exact.title + "x" }, inviter.callsign));
  assert.throws(() => decodeReferralContext(" ".repeat(REFERRAL_CONTEXT_MAX_BYTES + 1), inviter.callsign));
  assert.throws(() => encodeReferralContext({ ...inviter, title: "💥".repeat(REFERRAL_CONTEXT_MAX_BYTES / 4) }, inviter.callsign));
});
