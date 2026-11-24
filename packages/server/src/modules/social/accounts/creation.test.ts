import assert from "node:assert/strict";
import test from "node:test";

import { DatabaseError } from "pg";

import { findLinkedXAccount } from "@blast/server/lib/privy-adapter/adapter.ts";
import { PrivyAdapterError } from "@blast/core/lib/privy-adapter/errors.ts";
import {
  createSyntheticPrivyGateway,
  SYNTHETIC_GOOGLE_PRIVY_DID,
  SYNTHETIC_PRIVY_DID,
  SYNTHETIC_X_SUBJECT,
  syntheticGoogleOnlyUser,
} from "../../../../../core/test/fixtures/lib/privy-adapter/fixtures.ts";
import { normalizeSocialCallsign, normalizeSocialDisplayName, socialCallsignPath } from "@blast/core/modules/social/contracts/accounts.ts";
import { derivedDisplayName, insertRefusal } from "@blast/server/modules/social/accounts/creation.ts";
import { generateAccountIdentity } from "@blast/server/modules/social/accounts/generated-identity.ts";
import { isSocialCallsign } from "@blast/core/modules/social/contracts/accounts.ts";

test("generated identities have readable names and valid callsigns within the existing limits", () => {
  const callsigns = new Set<string>();
  for (let index = 0; index < 100; index++) {
    const identity = generateAccountIdentity();
    assert.equal(isSocialCallsign(identity.callsign), true);
    assert.match(identity.displayName, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.ok(identity.displayName.length <= 32);
    callsigns.add(identity.callsign);
  }
  assert.ok(callsigns.size > 1);
});

/** Social-feed T-014: the Privy X lookup over the fixture gateways, the contract helpers and the constraint mapping. */

test("T-014 (AC-010, AC-012): the linked X account is read from Privy's users API fixture, sanitized; a failure throws", async () => {
  assert.deepEqual(await findLinkedXAccount(createSyntheticPrivyGateway("success"), SYNTHETIC_PRIVY_DID), {
    xSubject: SYNTHETIC_X_SUBJECT,
    handle: "blast_pilot",
    displayName: "Blast Pilot",
    avatarUrl: "https://images.example.test/blast-pilot.png",
  });
  await assert.rejects(
    findLinkedXAccount(createSyntheticPrivyGateway("provider-timeout"), SYNTHETIC_PRIVY_DID),
    (error: unknown) => error instanceof PrivyAdapterError && error.code === "PROVIDER_TIMEOUT",
  );
  // A user without X, and an answer for another user.
  assert.equal(await findLinkedXAccount({ getUser: async () => syntheticGoogleOnlyUser() }, SYNTHETIC_GOOGLE_PRIVY_DID), null);
  await assert.rejects(findLinkedXAccount({ getUser: async () => syntheticGoogleOnlyUser() }, SYNTHETIC_PRIVY_DID), PrivyAdapterError);
});

test("T-014: callsigns are lowercased only; display names are trimmed to 1..32 code points; paths are encoded", () => {
  assert.equal(normalizeSocialCallsign("Kai_9"), "kai_9");
  assert.equal(normalizeSocialCallsign(" Kai"), " kai");
  assert.equal(normalizeSocialDisplayName(" Kai "), "Kai");
  assert.equal(normalizeSocialDisplayName(""), null);
  assert.equal(normalizeSocialDisplayName("x".repeat(33)), null);
  assert.equal(normalizeSocialDisplayName("😀".repeat(32)), "😀".repeat(32));
  assert.equal(socialCallsignPath("a/b"), "/api/social/callsigns/a%2Fb");
});

test("T-014 (AC-007, AC-009): the callsign guard's and unique indexes' errors map to their refusals; others pass through", () => {
  const failure = (code: string, constraint?: string) => Object.assign(new DatabaseError("x", 1, "error"), { code, constraint });
  assert.equal(insertRefusal(failure("23505", "social_accounts_callsign_taken"))?.code, "callsign_taken");
  assert.equal(insertRefusal(failure("23505", "social_accounts_callsign_key"))?.code, "callsign_taken");
  assert.equal(insertRefusal(failure("23505", "social_accounts_privy_did_key"))?.code, "account_exists");
  assert.equal(insertRefusal(failure("23514", "social_accounts_callsign_not_reserved"))?.code, "callsign_reserved");
  assert.equal(insertRefusal(failure("23505", "social_accounts_pkey")), null);
  assert.equal(insertRefusal(failure("55000")), null);
  assert.equal(insertRefusal(new Error("boom")), null);
});

test("UI-08 (OA-7): a derived display name is X's name cut to 32 code points, else the callsign", async () => {
  const none = async () => null;
  const x = (displayName: string | null) => ({ xSubject: "x-1", handle: "kai", displayName, avatarUrl: null });
  assert.equal(await derivedDisplayName("kai_sui", x("Kai Moreno"), none), "Kai Moreno");
  assert.equal(await derivedDisplayName("kai_sui", x(`${"a".repeat(31)} b`), none), "a".repeat(31));
  assert.equal(await derivedDisplayName("kai_sui", x(`  ${"b".repeat(40)}`), none), "b".repeat(32));
  assert.equal(await derivedDisplayName("kai_sui", x(null), none), "kai_sui");
  assert.equal(await derivedDisplayName("kai_sui", null, none), "kai_sui");
  assert.equal(await derivedDisplayName("kai_sui", x("Scam"), async (text) => (/scam/i.test(text) ? "scam" : null)), "kai_sui");
});
