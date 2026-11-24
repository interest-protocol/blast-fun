import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { fastTimeouts } from "../../../../test/fixtures/social/fast-timeouts.ts";
afterEach(() => mock.restoreAll());

import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import type { CreatorCapsClaim } from "@blast/core/modules/social/contracts/creator-claims.ts";

import { claimCanRetry, claimRefusalDescription, claimSettled, creatorCapsClaimTarget } from "./claims";
import { FAKE_SIGNATURE, FAKE_SPONSOR, sponsoredSigner, transactionBytesFor } from "../../../../test/fixtures/social/claim/claim-doubles.ts";
import { CLAIM_PENDING, type ClaimSigner } from "./claim-flow";
import { isCreatorCapsClaim, isCreatorCommitment } from "./creator-caps-client";
import { ATTESTATION_EXPIRED, CREATOR_CAPS_SEND_MARGIN_MS, runCreatorCapsClaim, type CreatorCapsFlowDependencies } from "./creator-caps-flow";

/**
 * LP-17's client flow over scripted answers from LP-16's `POST /api/social/me/creator-caps`:
 * both recipient kinds, a launch that names another wallet, a claim for
 * another wallet, an attestation that runs out before the claim is sent (asked for again, never
 * sent stale), and a launch claimed elsewhere meanwhile. The route is tested in
 * `packages/server/src/modules/social/creator-claims/route.test.ts`.
 */

const LAUNCH = normalizeSuiAddress(`0x${"1a".repeat(32)}`);
const KAI = normalizeSuiAddress(`0x${"9a11e700".padStart(64, "0")}`);
const OTHER = normalizeSuiAddress(`0x${"66".repeat(32)}`);
const NOW = 1_790_000_000_000;
const kindTransaction = new Transaction();
kindTransaction.moveCall({ target: "0x2::coin::zero", typeArguments: ["0x2::sui::SUI"] });
const KIND = await kindTransaction.build({ onlyTransactionKind: true });
const SPONSORED = transactionBytesFor(KIND, KAI, FAKE_SPONSOR);
const SPONSORED_DIGEST = TransactionDataBuilder.getDigestFromBytes(SPONSORED);
const SPONSORSHIP = { reservation_id: "res-1", transaction_bytes: toBase64(SPONSORED), sponsor_signature: "", expires_at_ms: NOW + 120_000, gas_budget: "5000000" } as const;
const TARGET = creatorCapsClaimTarget({ launchId: LAUNCH, name: "Froggy" });

type Answer = Readonly<{ status: number; body: unknown }>;

/** An account claim, sponsored, whose attestation runs 5 minutes from `NOW`. */
function claim(over: Partial<CreatorCapsClaim> = {}): CreatorCapsClaim {
  return {
    launch_id: LAUNCH,
    meme_type: `0x${"3f".repeat(32)}::froggy::FROGGY`,
    recipient: "account",
    claimant: KAI,
    fee: "sponsored",
    transaction_kind_bytes: toBase64(KIND),
    sponsored: SPONSORSHIP,
    attestation_expires_at_ms: NOW + 300_000,
    ...over,
  };
}

const addressClaim = (over: Partial<CreatorCapsClaim> = {}) => claim({ recipient: "address", attestation_expires_at_ms: null, ...over });
const ok = (body: CreatorCapsClaim): Answer => ({ status: 200, body });
const refusal = (status: number, code: string): Answer => ({ status, body: { error: { code, message: "refused" } } });

/** LP-16's route answering `requests` in turn, and the sponsor's execute answering `execute`. */
function server(requests: readonly Answer[], execute: Answer = { status: 200, body: { digest: SPONSORED_DIGEST, effects: { status: "success" } } }) {
  const calls: { path: string; body: unknown }[] = [];
  let asked = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    let answer: Answer;
    if (path === "/api/social/me/creator-caps") answer = requests[Math.min(asked++, requests.length - 1)]!;
    else if (path === "/api/presale/sponsor/res-1/execute") answer = execute;
    else answer = refusal(404, "not_found");
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

async function run(
  signer: ClaimSigner | null,
  requests: readonly Answer[],
  options: Partial<{ execute: Answer; clock: { ms: number } }> = {},
) {
  const fake = server(requests, options.execute);
  const clock = options.clock ?? { ms: NOW };
  mock.method(Date, "now", () => clock.ms);
  fastTimeouts();
  const deps: CreatorCapsFlowDependencies = {
    api: { getAccessToken: async () => null, fetch: fake.fetch },
    signer: async () => signer,
  };
  const outcome = await runCreatorCapsClaim(deps, TARGET, new AbortController().signal);
  const steps = fake.calls.map((call) => (call.path.endsWith("/execute") ? "execute" : call.path.endsWith("/creator-caps") ? "request" : call.path));
  return { ...fake, steps, outcome };
}

test("LP-17: an account recipient's claim is requested by launch, signed with the embedded key, and executed by the sponsor", async () => {
  const signed: Uint8Array[] = [];
  const result = await run(sponsoredSigner(KAI, { signed }), [ok(claim())]);
  assert.deepEqual(result.outcome, { status: "confirmed", digest: SPONSORED_DIGEST });
  assert.deepEqual(result.steps, ["request", "execute"]);
  // The client names only the launch: the server finds the recipient, the claimant and the attestation.
  assert.deepEqual(result.calls[0]!.body, { launch_id: LAUNCH });
  assert.deepEqual(result.calls[1]!.body, { user_signature: FAKE_SIGNATURE });
  assert.deepEqual(signed, [SPONSORED]);
});

test("LP-17: an address recipient's claim (no attestation) is sponsored and executed by the sponsor too", async () => {
  const signed: Uint8Array[] = [];
  const result = await run(sponsoredSigner(KAI, { signed }), [ok(addressClaim())]);
  assert.deepEqual(result.outcome, { status: "confirmed", digest: SPONSORED_DIGEST });
  assert.deepEqual(result.steps, ["request", "execute"]);
  assert.deepEqual(signed, [SPONSORED]);
});

test("LP-17: the wrong wallet signs nothing: a launch naming another wallet is refused, and a claim for another wallet or fee arm is not signed", async () => {
  const refused = await run(sponsoredSigner(KAI), [refusal(403, "not_creator_recipient")]);
  assert.deepEqual(refused.outcome, { status: "failed", code: "not_creator_recipient" });
  assert.deepEqual(refused.steps, ["request"]);
  for (const answer of [addressClaim({ claimant: OTHER }), claim({ launch_id: OTHER }), claim({ fee: "wallet", sponsored: null })]) {
    const signed: Uint8Array[] = [];
    const result = await run(sponsoredSigner(KAI, { signed }), [ok(answer)]);
    assert.deepEqual(result.outcome, { status: "failed", code: "mismatch" });
    assert.deepEqual(signed, []);
    assert.deepEqual(result.steps, ["request"]);
  }
  // Sponsored bytes from another sender are never signed.
  const signed: Uint8Array[] = [];
  const swapped = await run(sponsoredSigner(KAI, { signed }), [ok(claim({ sponsored: { ...SPONSORSHIP, transaction_bytes: toBase64(transactionBytesFor(KIND, OTHER, FAKE_SPONSOR)) } }))]);
  assert.deepEqual(swapped.outcome, { status: "failed", code: "mismatch" });
  assert.deepEqual(signed, []);
  assert.deepEqual((await run(null, [ok(claim())])).outcome, { status: "failed", code: "blast_wallet_missing" });
});

test("LP-17: an attestation that ran out before signing is requested again, never signed", async () => {
  const signed: Uint8Array[] = [];
  const stale = claim({ attestation_expires_at_ms: NOW + CREATOR_CAPS_SEND_MARGIN_MS - 1 });
  const result = await run(sponsoredSigner(KAI, { signed }), [ok(stale), ok(claim())]);
  assert.deepEqual(result.outcome, { status: "confirmed", digest: SPONSORED_DIGEST });
  assert.deepEqual(result.steps, ["request", "request", "execute"]);
  assert.equal(signed.length, 1, "only the fresh claim is signed");

  // Stale every time: nothing is signed or sent, and the reader is told to claim again.
  const never: Uint8Array[] = [];
  const expired = await run(sponsoredSigner(KAI, { signed: never }), [ok(stale)]);
  assert.deepEqual(expired.outcome, { status: "failed", code: ATTESTATION_EXPIRED });
  assert.deepEqual(expired.steps, ["request", "request"]);
  assert.deepEqual(never, []);
});

test("LP-17: an attestation that ran out while the wallet was open is dropped; the new request finds the launch claimed elsewhere meanwhile", async () => {
  const clock = { ms: NOW };
  const slow: ClaimSigner = {
    fee: "sponsored",
    address: KAI,
    async signTransaction() {
      clock.ms += 300_000; // the reader took five minutes to approve
      return FAKE_SIGNATURE;
    },
  };
  const result = await run(slow, [ok(claim()), refusal(409, "creator_caps_claimed")], { clock });
  assert.deepEqual(result.outcome, { status: "failed", code: "creator_caps_claimed" });
  // No execute step: the stale signature is never sent.
  assert.deepEqual(result.steps, ["request", "request"]);
});

test("LP-17: a launch claimed elsewhere before the request is refused; one claimed between the request and execution fails on Sui", async () => {
  const before = await run(sponsoredSigner(KAI), [refusal(409, "creator_caps_claimed")]);
  assert.deepEqual(before.outcome, { status: "failed", code: "creator_caps_claimed" });
  const during = await run(sponsoredSigner(KAI), [ok(claim())], { execute: { status: 200, body: { digest: SPONSORED_DIGEST, effects: { status: "failure" } } } });
  assert.deepEqual(during.outcome, { status: "failed", code: "execution_failed" });
});

test("LP-17: each refusal of the route is its code, with plain copy; a declined or lost claim says so", async () => {
  for (const [answer, code] of [
    [refusal(403, "not_creator_recipient"), "not_creator_recipient"],
    [refusal(409, "creator_caps_claimed"), "creator_caps_claimed"],
    [refusal(409, "claim_unavailable"), "claim_unavailable"],
    [refusal(409, "nothing_to_claim"), "nothing_to_claim"],
    [refusal(429, "rate_limited"), "rate_limited"],
    [refusal(409, "blast_wallet_missing"), "blast_wallet_missing"],
  ] as const) {
    const signed: Uint8Array[] = [];
    const result = await run(sponsoredSigner(KAI, { signed }), [answer]);
    assert.deepEqual(result.outcome, { status: "failed", code }, code);
    assert.deepEqual(signed, [], code);
    assert.notEqual(claimRefusalDescription(code), claimRefusalDescription("an_unknown_code"), `${code} has its own words`);
  }
  assert.match(claimRefusalDescription("not_creator_recipient"), /another wallet or account/);
  assert.match(claimRefusalDescription("creator_caps_claimed"), /already claimed/);
  assert.match(claimRefusalDescription(ATTESTATION_EXPIRED), /Claim again/);
  // A claim someone else owns or already made is not offered again; a run-out approval is.
  assert.equal(claimCanRetry(claimSettled({ status: "failed", code: "creator_caps_claimed" })), false);
  assert.equal(claimCanRetry(claimSettled({ status: "failed", code: "not_creator_recipient" })), false);
  assert.equal(claimCanRetry(claimSettled({ status: "failed", code: ATTESTATION_EXPIRED })), true);

  const declined = await run(sponsoredSigner(KAI, { error: new Error("User rejected the request") }), [ok(claim())]);
  assert.deepEqual(declined.outcome, { status: "failed", code: "rejected" });
  const lost = await run(sponsoredSigner(KAI), [ok(addressClaim())], { execute: refusal(500, "internal") });
  assert.deepEqual(lost.outcome, { status: "failed", code: CLAIM_PENDING, digest: SPONSORED_DIGEST });
});

test("LP-17: the route's answers are checked before anything reads them", () => {
  assert.equal(isCreatorCapsClaim(claim()), true);
  assert.equal(isCreatorCapsClaim(addressClaim()), true);
  assert.equal(isCreatorCapsClaim({ ...claim(), attestation_expires_at_ms: null }), false, "an account claim always expires");
  assert.equal(isCreatorCapsClaim({ ...addressClaim(), attestation_expires_at_ms: NOW }), false, "an address claim carries no attestation");
  assert.equal(isCreatorCapsClaim({ ...claim(), claimant: "0x1" }), false);
  assert.equal(isCreatorCapsClaim({ ...claim(), sponsored: { reservation_id: 1 } }), false);
  assert.equal(isCreatorCommitment({ account_commitment: "7c".repeat(32) }), true);
  assert.equal(isCreatorCommitment({ account_commitment: `0x${"7c".repeat(32)}` }), false);
  assert.equal(isCreatorCommitment({ account_commitment: "7C".repeat(32) }), false);
});
