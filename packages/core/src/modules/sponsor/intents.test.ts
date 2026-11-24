import assert from "node:assert/strict";
import test from "node:test";

import {
  capsNetStorage,
  countsDailyExecution,
  namesPresale,
  PUBLIC_SPONSOR_INTENTS,
  recordsCommit,
  recoversByKey,
  signingCheck,
  SPONSOR_INTENTS,
  sponsorPolicyKind,
  type SponsorIntent,
} from "./intents.ts";

// Today's behaviour, one row per intent: public route, policy, names a presale, storage cap,
// daily execution limit, signing check, keyed recovery, commit record after success.
const EXPECTED: Record<SponsorIntent, readonly unknown[]> = {
  commit: [true, "presale", true, true, true, { identity: true, pauseBit: "Commit" }, false, true],
  claim: [true, "presale", true, true, true, { identity: true, pauseBit: null }, false, false],
  settle: [true, "presale", true, true, true, { identity: true, pauseBit: null }, false, false],
  cancel: [true, "presale", true, true, true, { identity: true, pauseBit: null }, false, false],
  reward_claim: [true, "presale", true, true, true, { identity: true, pauseBit: null }, false, false],
  withdraw: [true, "withdraw", false, true, true, { identity: false }, false, false],
  trade: [false, "trusted", false, false, false, { identity: true, pauseBit: null }, false, false],
  bridge_withdraw: [false, "bridge_withdraw", false, true, true, { identity: false }, true, false],
  create: [false, "trusted", false, false, true, { identity: true, pauseBit: null }, false, false],
  vesting: [false, "trusted", false, false, true, { identity: true, pauseBit: null }, false, false],
  creator_caps: [false, "trusted", false, false, true, { identity: true, pauseBit: null }, false, false],
  launch_claim: [false, "trusted", false, false, true, { identity: true, pauseBit: null }, false, false],
};

test("each intent's derived rules match the sponsor's behaviour before the registry", () => {
  assert.deepEqual(Object.keys(SPONSOR_INTENTS), Object.keys(EXPECTED));
  for (const intent of Object.keys(EXPECTED) as SponsorIntent[]) {
    assert.deepEqual(
      [
        PUBLIC_SPONSOR_INTENTS.includes(intent as never),
        sponsorPolicyKind(intent),
        namesPresale(intent),
        capsNetStorage(intent),
        countsDailyExecution(intent),
        signingCheck(intent),
        recoversByKey(intent),
        recordsCommit(intent),
      ],
      EXPECTED[intent],
      intent,
    );
  }
});
