import assert from "node:assert/strict";
import test from "node:test";

import { isValidPersonalMessageSignature } from "@mysten/sui/verify";

import {
  WalletChallengeError,
  buildWalletChallengeMessage,
  canonicalSuiAddress,
  extractWalletChallengeNonce,
  parseIssueWalletChallengeRequest,
  parseVerifyWalletChallengeRequest,
  toWalletChallengeErrorResponse,
} from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import {
  syntheticEmbeddedSigner,
  syntheticSlushSigner,
} from "../../../../../core/test/fixtures/modules/mission-control/wallet-challenges/testing.ts";

const nonce = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

test("route DTOs canonicalize addresses and bind action to context", () => {
  const request = parseIssueWalletChallengeRequest({
    action: "onboarding",
    address: "0x2",
    origin: "https://blast.fun",
    context: { kind: "attempt", id: "attempt-7" },
    ignoredProviderPayload: { token: "never enters the domain" },
  });
  assert.equal(request.address, `0x${"0".repeat(63)}2`);
  assert.deepEqual(request.context, { kind: "attempt", id: "attempt-7" });
  assert.throws(
    () =>
      parseIssueWalletChallengeRequest({
        ...request,
        action: "restore_crew_access",
      }),
    /Action and context do not match/,
  );
  assert.throws(
    () =>
      parseIssueWalletChallengeRequest({
        ...request,
        origin: "https://blast.fun/path",
      }),
    /canonical and secure/,
  );
});

test("the exact human-readable message carries every bound field", () => {
  const message = buildWalletChallengeMessage({
    action: "restore_crew_access",
    address: canonicalSuiAddress("0x2"),
    origin: "https://blast.fun",
    context: { kind: "recovery", id: "recovery-9" },
    nonce,
    issuedAt: "2026-09-20T12:00:00.000Z",
    expiresAt: "2026-09-20T12:05:00.000Z",
  });
  assert.equal(extractWalletChallengeNonce(message), nonce);
  assert.equal(
    message,
    `BLAST.FUN wallet verification

Action: restore_crew_access
Address: 0x${"0".repeat(63)}2
Origin: https://blast.fun
Recovery context: recovery-9
Nonce: ${nonce}
Issued at: 2026-09-20T12:00:00.000Z
Expires at: 2026-09-20T12:05:00.000Z`,
  );
});

test("onboarding authorization binds the reviewed profile and legal versions", () => {
  const profileHash = "a".repeat(64);
  const message = buildWalletChallengeMessage({
    action: "onboarding",
    address: canonicalSuiAddress("0x2"),
    authorization: {
      acceptedAt: "2026-09-21T12:00:00.000Z",
      callsign: "blast_pilot",
      disclosureVersion: "season-zero-v1",
      fleet: "Recon",
      kind: "season-zero-profile",
      privacyHash: "c".repeat(64),
      privacyVersion: "2026-09-20",
      profileHash,
      termsHash: "b".repeat(64),
      termsVersion: "2026-09-20",
    },
    context: { kind: "attempt", id: "attempt-7" },
    nonce,
    origin: "https://blast.fun",
    issuedAt: "2026-09-21T12:00:00.000Z",
    expiresAt: "2026-09-21T12:05:00.000Z",
  });
  assert.match(message, /Purpose: Create my BLAST\.FUN Season Zero profile/);
  assert.match(message, /Callsign: @blast_pilot/);
  assert.match(message, /Fleet: Recon/);
  assert.match(message, new RegExp(`Profile authorization hash: ${profileHash}`));
  assert.match(message, /Terms version: 2026-09-20/);
  assert.match(message, /Privacy version: 2026-09-20/);
});

test("official Sui verification accepts Slush-like and embedded signer fixtures", async () => {
  const message = new TextEncoder().encode("fixture personal message");
  for (const signer of [syntheticSlushSigner, syntheticEmbeddedSigner]) {
    const signed = await signer.signPersonalMessage(message);
    assert.equal(
      await isValidPersonalMessageSignature(message, signed.signature, {
        address: signer.toSuiAddress(),
        offline: true,
      }),
      true,
    );
    assert.equal(
      await isValidPersonalMessageSignature(
        new TextEncoder().encode("altered"),
        signed.signature,
        { address: signer.toSuiAddress(), offline: true },
      ),
      false,
    );
  }
});

test("verification parsing and error mapping expose no membership detail", () => {
  const valid = {
    action: "onboarding",
    address: syntheticSlushSigner.toSuiAddress(),
    origin: "https://blast.fun",
    context: { kind: "attempt", id: "attempt-7" },
    challengeId: "00000000-0000-4000-8000-000000000007",
    message: "exact message",
    signature: "synthetic-signature",
  } as const;
  assert.equal(parseVerifyWalletChallengeRequest(valid).challengeId, valid.challengeId);
  assert.throws(
    () => parseVerifyWalletChallengeRequest({ ...valid, challengeId: "missing" }),
    /Invalid challenge identifier/,
  );

  const invalid = toWalletChallengeErrorResponse(
    new WalletChallengeError("WALLET_PROOF_INVALID"),
  );
  assert.deepEqual(invalid, {
    status: 400,
    body: {
      error: {
        code: "WALLET_PROOF_INVALID",
        message: "Wallet verification failed.",
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(invalid), /profile|member|exist|address/i);
  assert.equal(toWalletChallengeErrorResponse(new Error("database secret")).status, 500);
  assert.doesNotMatch(
    JSON.stringify(toWalletChallengeErrorResponse(new Error("database secret"))),
    /database secret/,
  );
});

test("sign_in (social UI-08) binds an attempt and says what signing does", () => {
  const request = parseIssueWalletChallengeRequest({
    action: "sign_in",
    address: "0x2",
    origin: "https://blast.fun",
    context: { kind: "attempt", id: "sign-in-7" },
  });
  for (const context of [{ kind: "account", id: "a" }, { kind: "recovery", id: "r" }]) {
    assert.throws(() => parseIssueWalletChallengeRequest({ ...request, context }), /Action and context do not match/);
  }
  assert.equal(
    buildWalletChallengeMessage({
      ...request,
      nonce,
      issuedAt: "2026-10-03T12:00:00.000Z",
      expiresAt: "2026-10-03T12:05:00.000Z",
    }),
    `BLAST.FUN wallet verification

Action: sign_in
Address: 0x${"0".repeat(63)}2
Origin: https://blast.fun
Attempt: sign-in-7

Purpose: Sign in to BLAST.FUN with this wallet
Nonce: ${nonce}
Issued at: 2026-10-03T12:00:00.000Z
Expires at: 2026-10-03T12:05:00.000Z`,
  );
});
